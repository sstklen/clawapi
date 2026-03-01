// SubKeyManager — Sub-Key 發行、驗證、撤銷、用量追蹤
// 提供完整的 Sub-Key 生命週期管理，讓使用者可以安全地分享 API 存取權限

import type { ClawDatabase } from '../storage/database';
import type { EngineAuth } from '../core/auth';
import { ErrorCode } from '@clawapi/protocol';

// ===== 型別定義 =====

/** 發行 Sub-Key 的參數 */
export interface IssueSubKeyParams {
  /** 標籤（供人識別用，例如「給老婆的 Key」） */
  label: string;
  /** 每日使用上限（null = 無限制） */
  daily_limit?: number | null;
  /** 允許使用的服務清單（null = 全部允許） */
  allowed_services?: string[] | null;
  /** 允許使用的模型清單（null = 全部允許） */
  allowed_models?: string[] | null;
  /** 每小時速率限制（null = 無限制） */
  rate_limit_per_hour?: number | null;
  /** 到期時間（ISO 8601 格式，null = 永不過期） */
  expires_at?: string | null;
}

/** Sub-Key 完整物件（發行後回傳） */
export interface SubKey {
  id: number;
  label: string;
  token: string;
  is_active: boolean;
  daily_limit: number | null;
  daily_used: number;
  allowed_services: string[] | null;
  allowed_models: string[] | null;
  rate_limit_per_hour: number | null;
  rate_used_this_hour: number;
  expires_at: string | null;
  /** 發行時間（ISO 8601） */
  created_at: string;
  /** 最後使用時間（ISO 8601，尚未使用則為 null） */
  last_used_at: string | null;
  /** 總請求次數 */
  total_requests: number;
  /** 總 Token 用量 */
  total_tokens: number;
}

/** Sub-Key 驗證結果（擴充版，包含完整權限資訊） */
export interface SubKeyValidationResult {
  valid: boolean;
  subKeyId?: number;
  /** 驗證通過時的權限快照 */
  permissions?: {
    allowed_services: string[] | null;
    allowed_models: string[] | null;
    daily_limit: number | null;
    daily_remaining: number | null;
    rate_limit_per_hour: number | null;
    rate_remaining: number | null;
    expires_at: string | null;
  };
  /** 驗證失敗時的錯誤碼 */
  error?: string;
}

/** VPS 驗證請求回應 */
export interface VPSValidationResponse {
  valid: boolean;
  service_id?: string;
  permissions?: {
    models: string[] | null;
    rate_limit: number | null;
    rate_remaining: number | null;
    expires_at: string | null;
  };
  error?: string;
}

/** 用量追蹤記錄 */
export interface UsageRecord {
  subKeyId: number;
  serviceId: string;
  tokensUsed: number;
  /** 記錄時間（ISO 8601，預設為現在） */
  recordedAt?: string;
}

/** DB 查詢回傳的 Sub-Key 資料列 */
interface SubKeyRow {
  id: number;
  token: string;
  label: string;
  is_active: number;
  daily_limit: number | null;
  daily_used: number;
  allowed_services: string | null;
  allowed_models: string | null;
  rate_limit_per_hour: number | null;
  rate_used_this_hour: number;
  rate_hour_start: string | null;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  total_requests: number;
  total_tokens: number;
}

// ===== 常數 =====

/** Sub-Key token 前綴 */
const SUBKEY_TOKEN_PREFIX = 'sk_live_';

/** Token 格式正規表達式：sk_live_ + deviceIdHash(8字元) + _ + UUID(36字元) */
const TOKEN_REGEX = /^sk_live_[0-9a-f]{8}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ===== SubKeyManager 主類別 =====

/**
 * SubKeyManager — Sub-Key 管理器
 *
 * 負責 Sub-Key 的完整生命週期：
 * 1. 發行（issue）：產生 token，存入 DB
 * 2. 驗證（validate）：8 項檢查確保合法使用
 * 3. 撤銷（revoke）：設定 is_active = 0
 * 4. 列表（list）：查詢所有 Sub-Key
 * 5. 用量追蹤（recordUsage）：累計請求和 Token 數
 * 6. VPS 驗證（handleVPSValidation）：處理 VPS 的驗證請求
 */
export class SubKeyManager {
  private db: ClawDatabase;
  private auth: EngineAuth;

  /**
   * @param db - ClawDatabase 實例（SQLite）
   * @param auth - EngineAuth 實例（用於取得 deviceId 做 token 前綴）
   */
  constructor(db: ClawDatabase, auth: EngineAuth) {
    this.db = db;
    this.auth = auth;
  }

  // ===== 1. 發行 Sub-Key =====

  /**
   * 發行新的 Sub-Key
   *
   * Token 格式：`sk_live_${deviceIdHash}_${UUID}`
   * - deviceIdHash：device_id 的前 8 字元（用於追蹤來源裝置）
   * - UUID：隨機唯一識別碼
   *
   * @param params - 發行參數（label, daily_limit, allowed_services 等）
   * @returns 完整的 SubKey 物件（含 token）
   */
  async issue(params: IssueSubKeyParams): Promise<SubKey> {
    // 產生 token：取得 device_id 的雜湊前綴
    const deviceIdHash = this.getDeviceIdHash();
    const uuid = globalThis.crypto.randomUUID();
    const token = `${SUBKEY_TOKEN_PREFIX}${deviceIdHash}_${uuid}`;

    // 序列化 JSON 陣列欄位
    const allowedServicesJson =
      params.allowed_services != null ? JSON.stringify(params.allowed_services) : null;
    const allowedModelsJson =
      params.allowed_models != null ? JSON.stringify(params.allowed_models) : null;

    // 存入 DB
    const result = this.db.run(
      `INSERT INTO sub_keys
         (token, label, daily_limit, daily_used,
          allowed_services, allowed_models,
          rate_limit_per_hour, rate_used_this_hour,
          is_active, expires_at, created_at, last_used_at,
          total_requests, total_tokens)
       VALUES (?, ?, ?, 0, ?, ?, ?, 0, 1, ?, datetime('now'), null, 0, 0)`,
      [
        token,
        params.label,
        params.daily_limit ?? null,
        allowedServicesJson,
        allowedModelsJson,
        params.rate_limit_per_hour ?? null,
        params.expires_at ?? null,
      ]
    );

    // 查詢剛插入的完整資料列
    const rows = this.db.query<SubKeyRow>(
      'SELECT * FROM sub_keys WHERE id = ?',
      [result.lastInsertRowid]
    );

    if (rows.length === 0) {
      throw new Error('Sub-Key 發行後查詢失敗');
    }

    return this.rowToSubKey(rows[0]);
  }

  // ===== 2. 驗證 Sub-Key =====

  /**
   * 驗證 Sub-Key（每次 API 呼叫時執行）
   *
   * 8 項依序檢查：
   * 1. 查 sub_keys 表（token 存在）
   * 2. is_active = 1（未被撤銷）
   * 3. expires_at 未過期
   * 4. daily_used < daily_limit
   * 5. rate_used_this_hour < rate_limit_per_hour
   * 6. service_id 在 allowed_services（null = 全部允許）
   * 7. model 在 allowed_models（null = 全部允許）
   * 8. token 格式正確（防偽造）
   *
   * @param token - Sub-Key token 字串
   * @param serviceId - 目標服務 ID
   * @param model - 目標模型 ID（可選）
   */
  async validate(
    token: string,
    serviceId: string,
    model?: string
  ): Promise<SubKeyValidationResult> {
    // 8. token 格式正確性（先快速失敗，減少 DB 查詢）
    if (!this.isValidTokenFormat(token)) {
      return { valid: false, error: ErrorCode.SUBKEY_INVALID };
    }

    // 1. 查 sub_keys 表
    const rows = this.db.query<SubKeyRow>(
      'SELECT * FROM sub_keys WHERE token = ?',
      [token]
    );

    if (rows.length === 0) {
      return { valid: false, error: ErrorCode.SUBKEY_INVALID };
    }

    const sk = rows[0];

    // 2. is_active = 1
    if (sk.is_active === 0) {
      return { valid: false, error: ErrorCode.SUBKEY_INVALID };
    }

    // 3. expires_at 未過期
    if (sk.expires_at !== null) {
      const expiry = new Date(sk.expires_at);
      if (expiry < new Date()) {
        return { valid: false, error: ErrorCode.SUBKEY_INVALID };
      }
    }

    // 4. daily_used < daily_limit
    if (sk.daily_limit !== null && sk.daily_used >= sk.daily_limit) {
      return { valid: false, error: 'daily_limit_exceeded' };
    }

    // 5. rate_used_this_hour < rate_limit_per_hour
    if (sk.rate_limit_per_hour !== null) {
      const currentHourStart = this.getCurrentHourStart();
      const rateHourStart = sk.rate_hour_start ? new Date(sk.rate_hour_start) : null;
      const isCurrentHour =
        rateHourStart !== null && rateHourStart >= currentHourStart;

      // 同一小時內且已達上限
      if (isCurrentHour && sk.rate_used_this_hour >= sk.rate_limit_per_hour) {
        return { valid: false, error: 'rate_limit_exceeded' };
      }
    }

    // 6. service_id 在 allowed_services
    if (sk.allowed_services !== null) {
      const allowedList = this.parseJsonArray(sk.allowed_services);
      if (allowedList !== null && !allowedList.includes(serviceId)) {
        return { valid: false, error: 'service_not_allowed' };
      }
    }

    // 7. model 在 allowed_models
    if (sk.allowed_models !== null && model !== undefined) {
      const allowedList = this.parseJsonArray(sk.allowed_models);
      if (allowedList !== null && !allowedList.includes(model)) {
        return { valid: false, error: 'model_not_allowed' };
      }
    }

    // 全部通過，組裝權限回應
    const allowedServices = sk.allowed_services ? this.parseJsonArray(sk.allowed_services) : null;
    const allowedModels = sk.allowed_models ? this.parseJsonArray(sk.allowed_models) : null;

    const dailyRemaining =
      sk.daily_limit !== null ? Math.max(0, sk.daily_limit - sk.daily_used) : null;

    // 計算速率剩餘
    let rateRemaining: number | null = null;
    if (sk.rate_limit_per_hour !== null) {
      const currentHourStart = this.getCurrentHourStart();
      const rateHourStart = sk.rate_hour_start ? new Date(sk.rate_hour_start) : null;
      const isCurrentHour = rateHourStart !== null && rateHourStart >= currentHourStart;
      const usedThisHour = isCurrentHour ? sk.rate_used_this_hour : 0;
      rateRemaining = Math.max(0, sk.rate_limit_per_hour - usedThisHour);
    }

    return {
      valid: true,
      subKeyId: sk.id,
      permissions: {
        allowed_services: allowedServices,
        allowed_models: allowedModels,
        daily_limit: sk.daily_limit,
        daily_remaining: dailyRemaining,
        rate_limit_per_hour: sk.rate_limit_per_hour,
        rate_remaining: rateRemaining,
        expires_at: sk.expires_at,
      },
    };
  }

  // ===== 3. 撤銷 Sub-Key =====

  /**
   * 撤銷 Sub-Key
   * 將 is_active 設為 0，立即生效（後續驗證全部拒絕）
   *
   * @param subKeyId - Sub-Key 的 DB primary key
   * @returns 是否成功撤銷（id 不存在則回傳 false）
   */
  async revoke(subKeyId: number): Promise<boolean> {
    const result = this.db.run(
      'UPDATE sub_keys SET is_active = 0 WHERE id = ?',
      [subKeyId]
    );
    return result.changes > 0;
  }

  // ===== 4. 列表 =====

  /**
   * 列出所有 Sub-Key
   * 按建立時間降冪排列（最新的在前）
   *
   * @returns Sub-Key 陣列（包含已撤銷的）
   */
  async list(): Promise<SubKey[]> {
    const rows = this.db.query<SubKeyRow>(
      'SELECT * FROM sub_keys ORDER BY created_at DESC'
    );
    return rows.map(row => this.rowToSubKey(row));
  }

  /**
   * 列出啟用中的 Sub-Key
   * 只回傳 is_active = 1 且未過期的
   */
  async listActive(): Promise<SubKey[]> {
    const now = new Date().toISOString();
    const rows = this.db.query<SubKeyRow>(
      `SELECT * FROM sub_keys
       WHERE is_active = 1
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
      [now]
    );
    return rows.map(row => this.rowToSubKey(row));
  }

  // ===== 5. 用量追蹤 =====

  /**
   * 記錄 Sub-Key 用量
   *
   * 更新：
   * - daily_used += 1
   * - rate_used_this_hour += 1（或重置為 1 如果跨小時）
   * - last_used_at = 現在
   * - total_requests += 1
   * - total_tokens += tokensUsed
   *
   * @param subKeyId - Sub-Key 的 DB primary key
   * @param serviceId - 使用的服務 ID（記錄用）
   * @param tokensUsed - 本次消耗的 Token 數量
   */
  async recordUsage(subKeyId: number, serviceId: string, tokensUsed: number): Promise<void> {
    // 查詢目前的 rate_hour_start
    const rows = this.db.query<{ rate_hour_start: string | null }>(
      'SELECT rate_hour_start FROM sub_keys WHERE id = ?',
      [subKeyId]
    );

    if (rows.length === 0) return;

    const currentHourStart = this.getCurrentHourStart();
    const rateHourStart = rows[0].rate_hour_start
      ? new Date(rows[0].rate_hour_start)
      : null;
    const isCurrentHour = rateHourStart !== null && rateHourStart >= currentHourStart;
    const now = new Date().toISOString();

    if (isCurrentHour) {
      // 同一小時：直接累加速率計數器
      this.db.run(
        `UPDATE sub_keys
         SET daily_used = daily_used + 1,
             rate_used_this_hour = rate_used_this_hour + 1,
             last_used_at = ?,
             total_requests = total_requests + 1,
             total_tokens = total_tokens + ?
         WHERE id = ?`,
        [now, tokensUsed, subKeyId]
      );
    } else {
      // 跨小時：重置速率計數器，新的一小時第一次使用
      this.db.run(
        `UPDATE sub_keys
         SET daily_used = daily_used + 1,
             rate_used_this_hour = 1,
             rate_hour_start = ?,
             last_used_at = ?,
             total_requests = total_requests + 1,
             total_tokens = total_tokens + ?
         WHERE id = ?`,
        [now, now, tokensUsed, subKeyId]
      );
    }

    // 寫入 usage_log（用於後續分析和遙測）
    this.db.run(
      `INSERT INTO usage_log
         (service_id, layer, sub_key_id, success, latency_ms,
          tokens_input, tokens_output, routing_strategy, retry_count)
       VALUES (?, 'L1', ?, 1, 0, 0, ?, 'direct', 0)`,
      [serviceId, subKeyId, tokensUsed]
    );
  }

  // ===== 6. VPS 驗證請求處理 =====

  /**
   * 處理 VPS 的 Sub-Key 驗證請求
   *
   * 當 VPS 收到帶 Sub-Key 的請求時，會向引擎驗證（SPEC-C §4.10）。
   * 此方法執行完整的 8 項驗證並回傳 VPS 可用的格式。
   *
   * @param token - Sub-Key token
   * @param serviceId - 請求的服務 ID
   * @returns VPS 格式的驗證回應
   */
  async handleVPSValidation(token: string, serviceId: string): Promise<VPSValidationResponse> {
    const result = await this.validate(token, serviceId);

    if (!result.valid) {
      return {
        valid: false,
        error: result.error,
      };
    }

    // 轉換為 VPS 使用的回應格式（SPEC-C SubKeyValidateResponse）
    return {
      valid: true,
      service_id: serviceId,
      permissions: {
        models: result.permissions?.allowed_models ?? null,
        rate_limit: result.permissions?.rate_limit_per_hour ?? null,
        rate_remaining: result.permissions?.rate_remaining ?? null,
        expires_at: result.permissions?.expires_at ?? null,
      },
    };
  }

  // ===== 私有輔助方法 =====

  /**
   * 取得裝置 ID 的前 8 字元做為 token 前綴
   * 從 DB 的 device 表讀取（若無資料則使用固定佔位字元）
   */
  private getDeviceIdHash(): string {
    interface DeviceRow { device_id: string }
    const rows = this.db.query<DeviceRow>(
      'SELECT device_id FROM device LIMIT 1'
    );

    if (rows.length === 0) {
      // 尚未向 VPS 注冊，使用佔位字元
      return '00000000';
    }

    // 取 UUID 的前 8 字元（去除連字號，保留 hex 字元）
    const deviceId = rows[0].device_id.replace(/-/g, '').substring(0, 8);
    return deviceId.toLowerCase();
  }

  /**
   * 驗證 token 格式
   * 格式：`sk_live_[8 hex]_[UUID]`
   */
  private isValidTokenFormat(token: string): boolean {
    return TOKEN_REGEX.test(token);
  }

  /**
   * 取得目前整點時間（用於速率限制比較）
   * 例如 14:37:22 → 14:00:00
   */
  private getCurrentHourStart(): Date {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return now;
  }

  /**
   * 解析 JSON 陣列字串
   * 失敗時回傳 null（防止損壞資料讓全部通過）
   */
  private parseJsonArray(value: string): string[] | null {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as string[];
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 將 DB 資料列轉換為 SubKey 物件
   * JSON 欄位在此解析，布林欄位在此轉換
   */
  private rowToSubKey(row: SubKeyRow): SubKey {
    return {
      id: row.id,
      label: row.label,
      token: row.token,
      is_active: row.is_active === 1,
      daily_limit: row.daily_limit,
      daily_used: row.daily_used,
      allowed_services: row.allowed_services
        ? this.parseJsonArray(row.allowed_services)
        : null,
      allowed_models: row.allowed_models
        ? this.parseJsonArray(row.allowed_models)
        : null,
      rate_limit_per_hour: row.rate_limit_per_hour,
      rate_used_this_hour: row.rate_used_this_hour,
      expires_at: row.expires_at,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      total_requests: row.total_requests,
      total_tokens: row.total_tokens,
    };
  }
}

// ===== 模組導出 =====

export default SubKeyManager;
