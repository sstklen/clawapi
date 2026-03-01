// 互助配對引擎（AidEngine）
// 負責互助請求的配對、推送、轉發、防刷單、超時處理
// 依據 SPEC-B §4.5 + SPEC-C §4.5 實作
// 重要鐵律：helper 的 device_id 永不出現在傳給 requester 的任何訊息中

import { ErrorCode } from '@clawapi/protocol';
import type { VPSDatabase } from '../storage/database';
import type { WSServerMessage } from '@clawapi/protocol';

// ===== 常數定義 =====

/** 配對等待超時（毫秒）：30 秒沒有 aid_response → timeout */
const AID_MATCH_TIMEOUT_MS = 30_000;

/** 裝置每日互助請求上限 */
const AID_DAILY_REQUEST_LIMIT = 30;

/** 基本冷卻時間（毫秒）：同裝置兩次請求間隔 ≥ 60s */
const AID_BASE_COOLDOWN_MS = 60_000;

/** 交叉驗證：同一對（requester + helper）24hr 內最多互助 3 次 */
const AID_CROSS_PAIR_LIMIT = 3;

/** 24 小時（毫秒），用於交叉驗證查詢 */
const AID_CROSS_PAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** payload 大小上限（bytes）：64KB */
const AID_PAYLOAD_MAX_BYTES = 64 * 1024;

// ===== 型別定義 =====

/** POST /v1/aid/request 的 request body */
export interface AidRequestBody {
  service_id: string;
  request_type: string;
  requester_public_key: string;
}

/** PUT /v1/aid/config 的 request body */
export interface AidConfigBody {
  enabled?: boolean;
  allowed_services?: string[] | null;
  daily_limit?: number;
  blackout_hours?: number[];
  helper_public_key?: string;
}

/** POST /v1/aid/relay 的 request body */
export interface AidRelayBody {
  aid_id: string;
  from_device_id: string;
  encrypted_payload: string;
  iv: string;
  tag: string;
  kind: 'encrypted_request' | 'encrypted_response';
  helper_public_key?: string;
}

/** aid_configs 資料表的行型別 */
interface AidConfigRow {
  device_id: string;
  enabled: number;                   // SQLite INTEGER → 0/1
  allowed_services: string | null;   // JSON 字串
  daily_limit: number;
  daily_given: number;
  daily_reset_at: string | null;
  blackout_hours: string | null;     // JSON 字串
  helper_public_key: string | null;
  aid_success_rate: number;
  avg_aid_latency_ms: number;
  created_at: string;
  updated_at: string;
}

/** aid_records 資料表的行型別 */
interface AidRecordRow {
  id: string;
  requester_device_id: string;
  helper_device_id: string | null;
  service_id: string;
  request_type: string;
  requester_public_key: string | null;
  helper_public_key: string | null;
  status: string;
  latency_ms: number | null;
  timeout_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

/** 配對候選幫助者資料（含評分所需欄位）*/
interface HelperCandidate {
  device_id: string;
  daily_limit: number;
  daily_given: number;
  allowed_services: string[];
  helper_public_key: string;
  aid_success_rate: number;
  avg_aid_latency_ms: number;
  reputation_weight: number;
}

/** 裝置冷卻狀態（記憶體中維護） */
interface CooldownState {
  lastRequestAt: number;     // 上次請求時間（ms）
  consecutiveFails: number;  // 連續失敗次數（影響冷卻時間倍增）
  todayCount: number;        // 今日請求次數
  todayDate: string;         // 今日日期（YYYY-MM-DD，用於重置計數）
}

/** WebSocket Manager 最小介面（測試 mock 用）*/
export interface IWSManager {
  sendToDevice(deviceId: string, message: WSServerMessage): boolean;
  getConnection(deviceId: string): { deviceId: string } | undefined;
}

// ===== AidEngine 主類別 =====

export class AidEngine {
  private db: VPSDatabase;
  private wsManager: IWSManager;

  /** 裝置冷卻狀態（記憶體快取，VPS 重啟後清空） */
  private cooldownMap: Map<string, CooldownState> = new Map();

  /** 進行中的配對計時器（aid_id → timeout handle） */
  private matchTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** 進行中的配對資訊（aid_id → { requesterId, helperId, startedAt }） */
  private activeMatches: Map<string, {
    requesterId: string;
    helperId: string;
    startedAt: number;
  }> = new Map();

  constructor(db: VPSDatabase, wsManager: IWSManager) {
    this.db = db;
    this.wsManager = wsManager;
  }

  // ===== 公開 API =====

  /**
   * handleRequest — POST /v1/aid/request
   * 發起互助請求：產生 aid_id、觸發配對、回傳 202
   */
  async handleRequest(
    requesterId: string,
    body: AidRequestBody,
  ): Promise<
    | { ok: true; aid_id: string }
    | { ok: false; errorCode: ErrorCode; message: string; retry_after?: number }
  > {
    const { service_id, request_type, requester_public_key } = body;

    // ===== 防刷單：冷卻檢查 =====
    const cooldownResult = this._checkCooldown(requesterId);
    if (!cooldownResult.ok) {
      return {
        ok: false,
        errorCode: ErrorCode.AID_COOLDOWN,
        message: cooldownResult.message,
        retry_after: Math.ceil(cooldownResult.retryAfterMs! / 1000),
      };
    }

    // ===== 防刷單：每日上限 =====
    const dailyResult = this._checkDailyLimit(requesterId);
    if (!dailyResult.ok) {
      return {
        ok: false,
        errorCode: ErrorCode.AID_DAILY_LIMIT_REACHED,
        message: '今日互助請求已達上限（30 次），明日凌晨重置',
        retry_after: this._secondsUntilMidnight(),
      };
    }

    // ===== 產生唯一 aid_id =====
    const aidId = `aid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // ===== 寫入 aid_records（初始狀態 pending） =====
    this.db.run(
      `INSERT INTO aid_records (
        id, requester_device_id, service_id, request_type,
        requester_public_key, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      [aidId, requesterId, service_id, request_type, requester_public_key],
    );

    // ===== 更新冷卻狀態（記錄本次請求時間） =====
    this._recordRequest(requesterId);

    // ===== 非同步執行配對（不阻塞回應） =====
    // 使用 queueMicrotask 確保回應先送出
    queueMicrotask(() => {
      this._matchHelper(aidId, requesterId, { service_id, request_type, requester_public_key })
        .catch((err) => {
          console.error(`[AidEngine] 配對失敗 aid_id=${aidId}:`, err);
          // 配對失敗：推送 no_helper 通知給 requester
          this._pushNoHelper(aidId, requesterId);
        });
    });

    return { ok: true, aid_id: aidId };
  }

  /**
   * _matchHelper — 核心配對邏輯（私有，但供測試存取用 public）
   * 找出最佳幫助者並雙向推送 aid_matched 通知
   */
  async _matchHelper(
    aidId: string,
    requesterId: string,
    request: { service_id: string; request_type: string; requester_public_key: string },
  ): Promise<void> {
    const { service_id, request_type, requester_public_key } = request;

    // ===== 1. 取得候選幫助者（aid_configs 表） =====
    const candidates = this._getCandidates(requesterId, service_id);

    if (candidates.length === 0) {
      // 沒有可用幫助者 → 更新狀態並推送 no_helper
      this.db.run(
        `UPDATE aid_records SET status = 'no_helper', completed_at = datetime('now') WHERE id = ?`,
        [aidId],
      );
      this._pushNoHelper(aidId, requesterId);
      return;
    }

    // ===== 2. 評分並選出最高分 =====
    const scored = candidates.map((c) => ({
      candidate: c,
      score: this._calculateHelperScore(c),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].candidate;

    // ===== 3. 更新 aid_records（記錄 helper） =====
    this.db.run(
      `UPDATE aid_records SET
        helper_device_id = ?,
        helper_public_key = ?,
        status = 'matched',
        updated_at = datetime('now')
       WHERE id = ?`,
      [best.device_id, best.helper_public_key, aidId],
    );

    // ===== 4. 雙向推送 aid_matched =====

    // 推送給求助者（requester B）：含 helper 的公鑰，不含 helper device_id
    const msgToRequester: WSServerMessage = {
      type: 'notification',
      channel: 'notifications',
      id: crypto.randomUUID(),
      payload: {
        kind: 'aid_matched',
        aid_id: aidId,
        // 重要：helper_public_key 是 A 預登記的公鑰，不暴露 device_id
        helper_public_key: best.helper_public_key,
      },
      server_time: new Date().toISOString(),
    };
    this.wsManager.sendToDevice(requesterId, msgToRequester);

    // 推送給幫助者（helper A）：含 service_id、request_type、requester 的公鑰
    // 同樣不暴露 requester 的 device_id（只給公鑰）
    const msgToHelper: WSServerMessage = {
      type: 'notification',
      channel: 'notifications',
      id: crypto.randomUUID(),
      payload: {
        kind: 'aid_matched',
        aid_id: aidId,
        service_id,
        request_type,
        requester_public_key,
      },
      server_time: new Date().toISOString(),
    };
    this.wsManager.sendToDevice(best.device_id, msgToHelper);

    // ===== 5. 記錄進行中的配對，並設置超時計時器 =====
    this.activeMatches.set(aidId, {
      requesterId,
      helperId: best.device_id,
      startedAt: Date.now(),
    });

    const timer = setTimeout(
      () => this._handleMatchTimeout(aidId),
      AID_MATCH_TIMEOUT_MS,
    );
    this.matchTimers.set(aidId, timer);

    // ===== 6. 更新 helper 的 daily_given（統計） =====
    this.db.run(
      `UPDATE aid_configs SET
        daily_given = daily_given + 1,
        updated_at = datetime('now')
       WHERE device_id = ?`,
      [best.device_id],
    );
  }

  /**
   * relayAidData — POST /v1/aid/relay（內部用）
   * 原封轉發加密密文，不檢查、不解密內容
   * 根據 kind 決定轉發方向：encrypted_request → helper，encrypted_response → requester
   */
  async relayAidData(
    aidId: string,
    fromDeviceId: string,
    body: AidRelayBody,
  ): Promise<
    | { ok: true }
    | { ok: false; errorCode: ErrorCode; message: string }
  > {
    // ===== payload 大小檢查 =====
    const payloadSize = Buffer.byteLength(body.encrypted_payload, 'base64');
    if (payloadSize > AID_PAYLOAD_MAX_BYTES) {
      return {
        ok: false,
        errorCode: ErrorCode.AID_PAYLOAD_TOO_LARGE,
        message: `payload 超過大小限制（最大 ${AID_PAYLOAD_MAX_BYTES} bytes）`,
      };
    }

    // ===== 查詢 aid_record 確認存在且狀態正確 =====
    const records = this.db.query<AidRecordRow>(
      `SELECT * FROM aid_records WHERE id = ? AND status IN ('matched', 'relaying')`,
      [aidId],
    );
    if (records.length === 0) {
      return {
        ok: false,
        errorCode: ErrorCode.INVALID_REQUEST,
        message: `aid_id ${aidId} 不存在或狀態不允許轉發`,
      };
    }
    const record = records[0];

    // ===== 確認發送者身份（只允許 requester 或 helper 轉發） =====
    const isRequester = fromDeviceId === record.requester_device_id;
    const isHelper = fromDeviceId === record.helper_device_id;
    if (!isRequester && !isHelper) {
      return {
        ok: false,
        errorCode: ErrorCode.INVALID_REQUEST,
        message: '只有互助雙方可以轉發資料',
      };
    }

    // ===== 決定接收方 =====
    // encrypted_request（B→A）：requester 送 → helper 收
    // encrypted_response（A→B）：helper 送 → requester 收
    let targetDeviceId: string;
    if (body.kind === 'encrypted_request') {
      if (!isRequester) {
        return {
          ok: false,
          errorCode: ErrorCode.INVALID_REQUEST,
          message: 'encrypted_request 只能由 requester 發送',
        };
      }
      if (!record.helper_device_id) {
        return {
          ok: false,
          errorCode: ErrorCode.INVALID_REQUEST,
          message: '尚未配對到 helper',
        };
      }
      targetDeviceId = record.helper_device_id;
    } else {
      if (!isHelper) {
        return {
          ok: false,
          errorCode: ErrorCode.INVALID_REQUEST,
          message: 'encrypted_response 只能由 helper 發送',
        };
      }
      targetDeviceId = record.requester_device_id;
    }

    // ===== 構造轉發訊息（原封不動傳遞密文，不解密）=====
    const relayMsg: WSServerMessage = {
      type: 'aid_data',
      channel: 'notifications',
      id: crypto.randomUUID(),
      payload: {
        kind: body.kind,
        aid_id: aidId,
        encrypted_payload: body.encrypted_payload,
        iv: body.iv,
        tag: body.tag,
        // encrypted_response 時附上 helper_public_key（讓 requester 可驗證）
        ...(body.kind === 'encrypted_response' && body.helper_public_key
          ? { helper_public_key: body.helper_public_key }
          : {}),
        // 重要：不傳 from_device_id，保持匿名
      },
      server_time: new Date().toISOString(),
    };

    const sent = this.wsManager.sendToDevice(targetDeviceId, relayMsg);
    if (!sent) {
      // 目標裝置不在線：回傳錯誤（不做離線佇列，密文有時效性）
      return {
        ok: false,
        errorCode: ErrorCode.SERVICE_UNAVAILABLE,
        message: '目標裝置目前不在線，無法轉發',
      };
    }

    // ===== encrypted_response 到達時：完成配對記錄 =====
    if (body.kind === 'encrypted_response') {
      this._completeMatch(aidId, record.helper_device_id!);
    } else {
      // encrypted_request 收到後：更新狀態為 relaying
      this.db.run(
        `UPDATE aid_records SET status = 'relaying', updated_at = datetime('now') WHERE id = ?`,
        [aidId],
      );
    }

    return { ok: true };
  }

  /**
   * updateConfig — PUT /v1/aid/config
   * 更新裝置的互助設定（UPSERT）
   */
  async updateConfig(
    deviceId: string,
    config: AidConfigBody,
  ): Promise<{ ok: true; config: AidConfigBody } | { ok: false; errorCode: ErrorCode; message: string }> {
    const {
      enabled,
      allowed_services,
      daily_limit,
      blackout_hours,
      helper_public_key,
    } = config;

    // 驗證 daily_limit 範圍（1-200）
    if (daily_limit !== undefined && (daily_limit < 1 || daily_limit > 200)) {
      return {
        ok: false,
        errorCode: ErrorCode.INVALID_REQUEST,
        message: 'daily_limit 必須在 1-200 之間',
      };
    }

    // 序列化 JSON 欄位
    const allowedServicesJson = allowed_services !== undefined
      ? JSON.stringify(allowed_services)
      : undefined;
    const blackoutHoursJson = blackout_hours !== undefined
      ? JSON.stringify(blackout_hours)
      : undefined;

    // UPSERT：aid_configs 表以 device_id 為主鍵
    this.db.run(
      `INSERT INTO aid_configs (
        device_id, enabled, allowed_services, daily_limit,
        blackout_hours, helper_public_key,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT (device_id) DO UPDATE SET
        enabled = COALESCE(excluded.enabled, enabled),
        allowed_services = COALESCE(excluded.allowed_services, allowed_services),
        daily_limit = COALESCE(excluded.daily_limit, daily_limit),
        blackout_hours = COALESCE(excluded.blackout_hours, blackout_hours),
        helper_public_key = COALESCE(excluded.helper_public_key, helper_public_key),
        updated_at = datetime('now')`,
      [
        deviceId,
        enabled !== undefined ? (enabled ? 1 : 0) : 0,
        allowedServicesJson ?? null,
        daily_limit ?? 50,
        blackoutHoursJson ?? null,
        helper_public_key ?? null,
      ],
    );

    return { ok: true, config };
  }

  /**
   * getConfig — GET /v1/aid/config
   * 取得裝置的互助設定
   */
  getConfig(deviceId: string): AidConfigBody | null {
    const rows = this.db.query<AidConfigRow>(
      `SELECT * FROM aid_configs WHERE device_id = ?`,
      [deviceId],
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      enabled: row.enabled === 1,
      allowed_services: row.allowed_services ? JSON.parse(row.allowed_services) : null,
      daily_limit: row.daily_limit,
      blackout_hours: row.blackout_hours ? JSON.parse(row.blackout_hours) : undefined,
      helper_public_key: row.helper_public_key ?? undefined,
    };
  }

  /**
   * markMatchResult — 標記配對結果（由 WS handler 呼叫，收到 aid_response 時）
   * status: 'fulfilled' | 'rejected' | 'error'
   */
  markMatchResult(aidId: string, status: 'fulfilled' | 'rejected' | 'error', latencyMs?: number): void {
    const match = this.activeMatches.get(aidId);
    if (!match) return;

    // 清除超時計時器
    this._clearMatchTimer(aidId);

    // 計算 latency
    const actualLatency = latencyMs ?? (Date.now() - match.startedAt);

    // 更新 aid_records
    this.db.run(
      `UPDATE aid_records SET
        status = ?,
        latency_ms = ?,
        completed_at = datetime('now')
       WHERE id = ?`,
      [status, actualLatency, aidId],
    );

    // 更新 helper 的成功率統計（fulfilled 才算成功）
    if (status === 'fulfilled') {
      this._updateHelperStats(match.helperId, true, actualLatency);
    } else {
      this._updateHelperStats(match.helperId, false, actualLatency);
      // 連續失敗：增加 requester 的冷卻計數
      this._recordFailure(match.requesterId);
    }

    // 更新 aid_stats 表（給/收 雙方統計）
    this._updateAidStats(match.requesterId, match.helperId, aidId);

    this.activeMatches.delete(aidId);
  }

  // ===== 私有方法 =====

  /**
   * _getCandidates — 查詢符合條件的候選幫助者
   * 過濾條件：enabled=1、service_id 在 allowed_services、daily_limit 未達、不是自己、裝置未被暫停
   */
  private _getCandidates(requesterId: string, serviceId: string): HelperCandidate[] {
    // 查詢 aid_configs + devices（reputation_weight）
    const rows = this.db.query<{
      device_id: string;
      daily_limit: number;
      daily_given: number;
      allowed_services: string | null;
      helper_public_key: string | null;
      aid_success_rate: number;
      avg_aid_latency_ms: number;
      reputation_weight: number;
      device_status: string;
      blackout_hours: string | null;
    }>(
      `SELECT
        ac.device_id,
        ac.daily_limit,
        ac.daily_given,
        ac.allowed_services,
        ac.helper_public_key,
        ac.aid_success_rate,
        ac.avg_aid_latency_ms,
        ac.blackout_hours,
        d.reputation_weight,
        d.status as device_status
       FROM aid_configs ac
       JOIN devices d ON ac.device_id = d.device_id
       WHERE ac.enabled = 1
         AND ac.helper_public_key IS NOT NULL
         AND ac.device_id != ?
         AND d.status = 'active'
         AND ac.daily_given < ac.daily_limit`,
      [requesterId],
    );

    const currentHour = new Date().getUTCHours();

    // 在 JavaScript 層做進一步過濾（service_id 比對、blackout_hours）
    return rows
      .filter((row) => {
        // 必須有 helper_public_key（SQL 已確保，雙重確認）
        if (!row.helper_public_key) return false;

        // 過濾 blackout_hours（休息時段不接單）
        if (row.blackout_hours) {
          const blackout: number[] = JSON.parse(row.blackout_hours);
          if (blackout.includes(currentHour)) return false;
        }

        // 過濾 allowed_services（null 代表接受全部 service）
        if (row.allowed_services) {
          const allowed: string[] = JSON.parse(row.allowed_services);
          if (!allowed.includes(serviceId)) return false;
        }

        return true;
      })
      .map((row) => ({
        device_id: row.device_id,
        daily_limit: row.daily_limit,
        daily_given: row.daily_given,
        allowed_services: row.allowed_services ? JSON.parse(row.allowed_services) : [],
        helper_public_key: row.helper_public_key!,
        aid_success_rate: row.aid_success_rate,
        avg_aid_latency_ms: row.avg_aid_latency_ms,
        reputation_weight: row.reputation_weight,
      }));
  }

  /**
   * _calculateHelperScore — 計算幫助者評分（最高分 = 最佳 helper）
   *
   * 評分公式：
   * - 剩餘額度分：min(remaining / 10, 5)          → 最高 5 分
   * - 歷史成功率：successRate × 3                 → 最高 3 分
   * - 回應延遲分：max(0, 3 - avgLatency / 5000)   → 最高 3 分（10s 以上得 0）
   * - 信譽分數：reputation_weight（0.1–2.0）       → 加權乘數
   */
  private _calculateHelperScore(candidate: HelperCandidate): number {
    const remaining = candidate.daily_limit - candidate.daily_given;

    // 剩餘額度分（每 10 次額度 = 1 分，最高 5 分）
    const capacityScore = Math.min(remaining / 10, 5);

    // 歷史成功率分（0.0–1.0 × 3）
    const successScore = candidate.aid_success_rate * 3;

    // 回應延遲分（延遲越低越高分）
    const latencyScore = Math.max(0, 3 - candidate.avg_aid_latency_ms / 5000);

    // 基礎分相加後乘以信譽權重
    const baseScore = capacityScore + successScore + latencyScore;
    return baseScore * candidate.reputation_weight;
  }

  /**
   * _checkCooldown — 冷卻時間檢查
   * 冷卻規則：基本 60s，連續失敗 n 次後 × 2^n（60→120→240→...）
   */
  private _checkCooldown(deviceId: string): { ok: boolean; message: string; retryAfterMs?: number } {
    const state = this.cooldownMap.get(deviceId);
    if (!state) return { ok: true, message: '' };

    const now = Date.now();
    const elapsed = now - state.lastRequestAt;

    // 計算冷卻時間：基本 60s，連續失敗加倍
    const cooldownMs = AID_BASE_COOLDOWN_MS * Math.pow(2, Math.min(state.consecutiveFails, 3));
    // 最長不超過 240s（2^2 × 60 = 240 秒）

    if (elapsed < cooldownMs) {
      const retryAfterMs = cooldownMs - elapsed;
      return {
        ok: false,
        message: `請求太頻繁，請等待 ${Math.ceil(retryAfterMs / 1000)} 秒後再試`,
        retryAfterMs,
      };
    }

    return { ok: true, message: '' };
  }

  /**
   * _checkDailyLimit — 每日請求次數上限檢查
   */
  private _checkDailyLimit(deviceId: string): { ok: boolean } {
    const today = new Date().toISOString().slice(0, 10);
    const state = this.cooldownMap.get(deviceId);

    if (!state) return { ok: true };

    // 日期切換時重置計數
    if (state.todayDate !== today) {
      state.todayDate = today;
      state.todayCount = 0;
    }

    return { ok: state.todayCount < AID_DAILY_REQUEST_LIMIT };
  }

  /**
   * _recordRequest — 記錄本次請求（更新冷卻狀態）
   */
  private _recordRequest(deviceId: string): void {
    const today = new Date().toISOString().slice(0, 10);
    const existing = this.cooldownMap.get(deviceId);

    if (existing) {
      // 如果日期切換，重置每日計數
      if (existing.todayDate !== today) {
        existing.todayDate = today;
        existing.todayCount = 0;
      }
      existing.lastRequestAt = Date.now();
      existing.todayCount++;
    } else {
      this.cooldownMap.set(deviceId, {
        lastRequestAt: Date.now(),
        consecutiveFails: 0,
        todayCount: 1,
        todayDate: today,
      });
    }
  }

  /**
   * _recordFailure — 記錄連續失敗（用於加倍冷卻）
   */
  private _recordFailure(deviceId: string): void {
    const state = this.cooldownMap.get(deviceId);
    if (state) {
      state.consecutiveFails = Math.min(state.consecutiveFails + 1, 3);
    }
  }

  /**
   * _handleMatchTimeout — 處理配對超時（30 秒無回應）
   */
  private _handleMatchTimeout(aidId: string): void {
    const match = this.activeMatches.get(aidId);
    if (!match) return;

    // 從 timer map 移除
    this.matchTimers.delete(aidId);
    this.activeMatches.delete(aidId);

    // 更新 DB 狀態
    this.db.run(
      `UPDATE aid_records SET
        status = 'timeout',
        timeout_reason = 'no_response_within_30s',
        completed_at = datetime('now')
       WHERE id = ?`,
      [aidId],
    );

    // 推送 aid_result（timeout）給 requester
    const timeoutMsg: WSServerMessage = {
      type: 'notification',
      channel: 'notifications',
      id: crypto.randomUUID(),
      payload: {
        kind: 'aid_result',
        aid_id: aidId,
        status: 'timeout',
        message: '互助請求超時（30 秒未收到回應）',
        suggestion: '請稍後再試，或檢查服務狀態',
      },
      server_time: new Date().toISOString(),
    };
    this.wsManager.sendToDevice(match.requesterId, timeoutMsg);

    // 連續失敗計數
    this._recordFailure(match.requesterId);

    // 更新 helper 的 daily_given 回滾（超時 = 沒有真正幫助）
    this.db.run(
      `UPDATE aid_configs SET
        daily_given = MAX(0, daily_given - 1),
        updated_at = datetime('now')
       WHERE device_id = ?`,
      [match.helperId],
    );

    console.warn(`[AidEngine] 超時 aid_id=${aidId}，requesterId=${match.requesterId}，helperId=${match.helperId}`);
  }

  /**
   * _completeMatch — 完成配對（收到 encrypted_response 後呼叫）
   */
  private _completeMatch(aidId: string, helperId: string): void {
    const match = this.activeMatches.get(aidId);
    if (!match) return;

    // 清除超時計時器
    this._clearMatchTimer(aidId);

    const latencyMs = Date.now() - match.startedAt;

    // 更新 aid_records
    this.db.run(
      `UPDATE aid_records SET
        status = 'fulfilled',
        latency_ms = ?,
        completed_at = datetime('now')
       WHERE id = ?`,
      [latencyMs, aidId],
    );

    // 更新 helper 統計
    this._updateHelperStats(helperId, true, latencyMs);

    // 更新雙方 aid_stats
    this._updateAidStats(match.requesterId, helperId, aidId);

    this.activeMatches.delete(aidId);
  }

  /**
   * _clearMatchTimer — 清除指定 aid_id 的超時計時器
   */
  private _clearMatchTimer(aidId: string): void {
    const timer = this.matchTimers.get(aidId);
    if (timer) {
      clearTimeout(timer);
      this.matchTimers.delete(aidId);
    }
  }

  /**
   * _pushNoHelper — 推送「無可用幫助者」通知給 requester
   */
  private _pushNoHelper(aidId: string, requesterId: string): void {
    const msg: WSServerMessage = {
      type: 'notification',
      channel: 'notifications',
      id: crypto.randomUUID(),
      payload: {
        kind: 'aid_result',
        aid_id: aidId,
        status: 'timeout',
        message: '目前沒有可用的幫助者',
        suggestion: '請稍後再試，或開啟自己的互助功能來增加社群互助能量',
      },
      server_time: new Date().toISOString(),
    };
    this.wsManager.sendToDevice(requesterId, msg);
  }

  /**
   * _updateHelperStats — 更新 helper 的成功率和平均延遲
   * 使用指數移動平均（EMA）更新，避免一次失敗影響過大
   */
  private _updateHelperStats(helperId: string, success: boolean, latencyMs: number): void {
    const rows = this.db.query<{ aid_success_rate: number; avg_aid_latency_ms: number }>(
      `SELECT aid_success_rate, avg_aid_latency_ms FROM aid_configs WHERE device_id = ?`,
      [helperId],
    );
    if (rows.length === 0) return;

    const { aid_success_rate, avg_aid_latency_ms } = rows[0];

    // EMA alpha = 0.1（新值佔 10%，舊值佔 90%）
    const alpha = 0.1;
    const newSuccessRate = alpha * (success ? 1.0 : 0.0) + (1 - alpha) * aid_success_rate;
    const newAvgLatency = alpha * latencyMs + (1 - alpha) * avg_aid_latency_ms;

    this.db.run(
      `UPDATE aid_configs SET
        aid_success_rate = ?,
        avg_aid_latency_ms = ?,
        updated_at = datetime('now')
       WHERE device_id = ?`,
      [newSuccessRate, Math.round(newAvgLatency), helperId],
    );
  }

  /**
   * _updateAidStats — 更新 aid_stats 表（雙方的給予/接收統計）
   */
  private _updateAidStats(requesterId: string, helperId: string, aidId: string): void {
    // 查詢此次請求的 service_id
    const records = this.db.query<{ service_id: string }>(
      `SELECT service_id FROM aid_records WHERE id = ?`,
      [aidId],
    );
    if (records.length === 0) return;
    const serviceId = records[0].service_id;

    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM

    // requester 的 received 統計
    this.db.run(
      `INSERT INTO aid_stats (device_id, direction, service_id, total_count, month_count, month_key)
       VALUES (?, 'received', ?, 1, 1, ?)
       ON CONFLICT (device_id, direction, service_id) DO UPDATE SET
         total_count = total_count + 1,
         month_count = CASE WHEN month_key = ? THEN month_count + 1 ELSE 1 END,
         month_key = ?`,
      [requesterId, serviceId, monthKey, monthKey, monthKey],
    );

    // helper 的 given 統計
    this.db.run(
      `INSERT INTO aid_stats (device_id, direction, service_id, total_count, month_count, month_key)
       VALUES (?, 'given', ?, 1, 1, ?)
       ON CONFLICT (device_id, direction, service_id) DO UPDATE SET
         total_count = total_count + 1,
         month_count = CASE WHEN month_key = ? THEN month_count + 1 ELSE 1 END,
         month_key = ?`,
      [helperId, serviceId, monthKey, monthKey, monthKey],
    );
  }

  /**
   * _secondsUntilMidnight — 計算到 UTC 明日凌晨的秒數
   */
  private _secondsUntilMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    midnight.setUTCHours(0, 0, 0, 0);
    return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
  }

  // ===== 測試輔助方法（僅供測試使用）=====

  /** 強制清除指定裝置的冷卻狀態（測試用）*/
  _resetCooldown(deviceId: string): void {
    this.cooldownMap.delete(deviceId);
  }

  /** 取得目前進行中的配對數量（測試用）*/
  _getActiveMatchCount(): number {
    return this.activeMatches.size;
  }

  /** 取得指定 aid_id 的進行中配對資訊（測試用）*/
  _getActiveMatch(aidId: string): { requesterId: string; helperId: string; startedAt: number } | undefined {
    return this.activeMatches.get(aidId);
  }

  /** 強制清除所有計時器（測試清理用）*/
  _clearAllTimers(): void {
    for (const [aidId] of this.matchTimers) {
      this._clearMatchTimer(aidId);
    }
    this.activeMatches.clear();
  }
}
