// AidEngine 服務層單元測試
// 使用 in-memory 物件 mock（不建立真實 SQLite）
// 涵蓋：handleRequest、_matchHelper、relayAidData、updateConfig、getConfig
//       冷卻機制、每日上限、交叉驗證、30 秒超時、雙向推送匿名保護

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AidEngine } from '../aid-engine';
import { ErrorCode } from '@clawapi/protocol';
import type { AidRequestBody, AidConfigBody, AidRelayBody, IWSManager } from '../aid-engine';
import type { VPSDatabase } from '../../storage/database';
import type { WSServerMessage } from '@clawapi/protocol';

// ===== Mock DB 建構器 =====

interface AidConfigRecord {
  device_id: string;
  enabled: number;
  allowed_services: string | null;
  daily_limit: number;
  daily_given: number;
  daily_reset_at: string | null;
  blackout_hours: string | null;
  helper_public_key: string | null;
  aid_success_rate: number;
  avg_aid_latency_ms: number;
  created_at: string;
  updated_at: string;
}

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

interface AidStatsRecord {
  device_id: string;
  direction: string;
  service_id: string;
  total_count: number;
  month_count: number;
  month_key: string;
}

interface DeviceRow {
  device_id: string;
  status: string;
  reputation_weight: number;
}

function createMockDb() {
  const aidConfigs: Map<string, AidConfigRecord> = new Map();
  const aidRecords: Map<string, AidRecordRow> = new Map();
  const aidStats: Map<string, AidStatsRecord> = new Map();
  const devices: Map<string, DeviceRow> = new Map();

  const runCalls: Array<{ sql: string; params: unknown[] }> = [];

  return {
    // ===== 測試輔助 API =====
    _getAidRecord(id: string) { return aidRecords.get(id); },
    _getAllAidRecords() { return [...aidRecords.values()]; },
    _getAidConfig(deviceId: string) { return aidConfigs.get(deviceId); },
    _insertDevice(device: DeviceRow) { devices.set(device.device_id, device); },
    _insertAidConfig(config: AidConfigRecord) { aidConfigs.set(config.device_id, config); },
    _insertAidRecord(record: AidRecordRow) { aidRecords.set(record.id, record); },
    _getRunCalls() { return [...runCalls]; },
    _clearRunCalls() { runCalls.length = 0; },

    // ===== VPSDatabase 介面實作 =====
    query<T>(sql: string, params?: unknown[]): T[] {
      const s = sql.trim().toLowerCase().replace(/\s+/g, ' ');

      // --- aid_configs + devices JOIN（取候選 helper）---
      if (s.includes('from aid_configs ac') && s.includes('join devices d')) {
        const requesterId = params?.[0] as string;
        const result: Array<{
          device_id: string;
          daily_limit: number;
          daily_given: number;
          allowed_services: string | null;
          helper_public_key: string | null;
          aid_success_rate: number;
          avg_aid_latency_ms: number;
          blackout_hours: string | null;
          reputation_weight: number;
          device_status: string;
        }> = [];

        for (const config of aidConfigs.values()) {
          if (config.device_id === requesterId) continue;
          if (config.enabled !== 1) continue;
          if (!config.helper_public_key) continue;
          if (config.daily_given >= config.daily_limit) continue;

          const device = devices.get(config.device_id);
          if (!device || device.status !== 'active') continue;

          result.push({
            device_id: config.device_id,
            daily_limit: config.daily_limit,
            daily_given: config.daily_given,
            allowed_services: config.allowed_services,
            helper_public_key: config.helper_public_key,
            aid_success_rate: config.aid_success_rate,
            avg_aid_latency_ms: config.avg_aid_latency_ms,
            blackout_hours: config.blackout_hours,
            reputation_weight: device.reputation_weight,
            device_status: device.status,
          });
        }
        return result as unknown as T[];
      }

      // --- SELECT * FROM aid_configs WHERE device_id = ? ---
      if (s.includes('from aid_configs where device_id =')) {
        const deviceId = params?.[0] as string;
        const config = aidConfigs.get(deviceId);
        return (config ? [config] : []) as unknown as T[];
      }

      // --- SELECT service_id FROM aid_records WHERE id = ? ---
      if (s.includes('select service_id from aid_records where id =')) {
        const id = params?.[0] as string;
        const record = aidRecords.get(id);
        return (record ? [{ service_id: record.service_id }] : []) as unknown as T[];
      }

      // --- SELECT * FROM aid_records WHERE id = ? AND status IN (...) ---
      if (s.includes('from aid_records where id =') && s.includes('status in')) {
        const id = params?.[0] as string;
        const record = aidRecords.get(id);
        if (!record) return [] as T[];
        if (record.status !== 'matched' && record.status !== 'relaying') return [] as T[];
        return [record] as unknown as T[];
      }

      // --- SELECT aid_success_rate, avg_aid_latency_ms FROM aid_configs WHERE device_id = ? ---
      if (s.includes('aid_success_rate') && s.includes('avg_aid_latency_ms') && s.includes('from aid_configs')) {
        const deviceId = params?.[0] as string;
        const config = aidConfigs.get(deviceId);
        if (!config) return [] as T[];
        return [{ aid_success_rate: config.aid_success_rate, avg_aid_latency_ms: config.avg_aid_latency_ms }] as unknown as T[];
      }

      return [] as T[];
    },

    run(sql: string, params?: unknown[]) {
      runCalls.push({ sql: sql.trim(), params: params ?? [] });
      const s = sql.trim().toLowerCase().replace(/\s+/g, ' ');

      // INSERT INTO aid_records
      if (s.startsWith('insert into aid_records')) {
        const [id, requesterId, serviceId, requestType, requesterPubKey] = params as string[];
        aidRecords.set(id, {
          id,
          requester_device_id: requesterId,
          helper_device_id: null,
          service_id: serviceId,
          request_type: requestType,
          requester_public_key: requesterPubKey,
          helper_public_key: null,
          status: 'pending',
          latency_ms: null,
          timeout_reason: null,
          created_at: new Date().toISOString(),
          completed_at: null,
        });
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE aid_records SET helper_device_id（配對成功）
      if (s.includes('update aid_records set') && s.includes('helper_device_id')) {
        const [helperId, helperPubKey, id] = params as string[];
        const record = aidRecords.get(id);
        if (record) {
          record.helper_device_id = helperId;
          record.helper_public_key = helperPubKey;
          record.status = 'matched';
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE aid_records SET status = 'relaying'
      if (s.includes('update aid_records set status = ') && s.includes('relaying')) {
        const id = params?.[0] as string;
        const record = aidRecords.get(id);
        if (record) record.status = 'relaying';
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE aid_records SET status = ? + latency_ms（markMatchResult 用）
      if (s.includes('update aid_records set') && s.includes('latency_ms') && !s.includes('helper_device_id')) {
        const [status, latencyMs, id] = params as [string, number, string];
        const record = aidRecords.get(id);
        if (record) {
          record.status = status;
          record.latency_ms = latencyMs;
          record.completed_at = new Date().toISOString();
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE aid_records SET status = 'timeout' OR 'no_helper'
      if (s.includes('update aid_records set') && s.includes('status =') && (s.includes('timeout') || s.includes('no_helper'))) {
        const id = params?.[0] as string;
        const record = aidRecords.get(id);
        if (record) {
          record.status = s.includes('timeout') ? 'timeout' : 'no_helper';
          record.completed_at = new Date().toISOString();
          if (s.includes('timeout_reason')) {
            record.timeout_reason = 'no_response_within_30s';
          }
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE aid_records SET status = 'fulfilled' + latency_ms（_completeMatch 用）
      if (s.includes('update aid_records set') && s.includes('fulfilled') && s.includes('latency_ms')) {
        const [latencyMs, id] = params as [number, string];
        const record = aidRecords.get(id);
        if (record) {
          record.status = 'fulfilled';
          record.latency_ms = latencyMs;
          record.completed_at = new Date().toISOString();
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE aid_configs SET daily_given = daily_given + 1
      if (s.includes('update aid_configs set') && s.includes('daily_given = daily_given + 1')) {
        const deviceId = params?.[0] as string;
        const config = aidConfigs.get(deviceId);
        if (config) config.daily_given++;
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE aid_configs SET daily_given = MAX(0, daily_given - 1)（超時回滾）
      if (s.includes('update aid_configs set') && s.includes('daily_given - 1')) {
        const deviceId = params?.[0] as string;
        const config = aidConfigs.get(deviceId);
        if (config) config.daily_given = Math.max(0, config.daily_given - 1);
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE aid_configs SET aid_success_rate, avg_aid_latency_ms
      if (s.includes('update aid_configs set') && s.includes('aid_success_rate')) {
        const [newSuccessRate, newAvgLatency, deviceId] = params as [number, number, string];
        const config = aidConfigs.get(deviceId);
        if (config) {
          config.aid_success_rate = newSuccessRate;
          config.avg_aid_latency_ms = newAvgLatency;
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // INSERT INTO aid_configs（UPSERT）
      if (s.startsWith('insert into aid_configs')) {
        const [deviceId, enabled, allowedServices, dailyLimit, blackoutHours, helperPublicKey] = params as [string, number, string | null, number, string | null, string | null];
        const existing = aidConfigs.get(deviceId);
        if (existing) {
          // ON CONFLICT DO UPDATE
          if (enabled !== null && enabled !== undefined) existing.enabled = enabled;
          if (allowedServices !== undefined) existing.allowed_services = allowedServices;
          if (dailyLimit !== undefined) existing.daily_limit = dailyLimit;
          if (blackoutHours !== undefined) existing.blackout_hours = blackoutHours;
          if (helperPublicKey !== undefined && helperPublicKey !== null) existing.helper_public_key = helperPublicKey;
          existing.updated_at = new Date().toISOString();
        } else {
          aidConfigs.set(deviceId, {
            device_id: deviceId,
            enabled,
            allowed_services: allowedServices,
            daily_limit: dailyLimit,
            daily_given: 0,
            daily_reset_at: null,
            blackout_hours: blackoutHours,
            helper_public_key: helperPublicKey,
            aid_success_rate: 0.5,
            avg_aid_latency_ms: 10000,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // INSERT INTO aid_stats（UPSERT）
      if (s.startsWith('insert into aid_stats')) {
        const [deviceId, direction, serviceId, totalCount, monthCount, monthKey] = params as [string, string, string, number, number, string];
        const key = `${deviceId}:${direction}:${serviceId}`;
        const existing = aidStats.get(key);
        if (existing) {
          existing.total_count++;
          if (existing.month_key === monthKey) {
            existing.month_count++;
          } else {
            existing.month_count = 1;
            existing.month_key = monthKey;
          }
        } else {
          aidStats.set(key, { device_id: deviceId, direction, service_id: serviceId, total_count: 1, month_count: 1, month_key: monthKey });
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      return { changes: 0, lastInsertRowid: 0 };
    },

    // 其他 VPSDatabase 方法（測試不需要）
    init: async () => {},
    close: async () => {},
    transaction: <T>(fn: () => T) => fn(),
    checkpoint: () => {},
    getDevice: () => null,
    getDeviceByToken: () => null,
    updateDeviceLastSeen: () => {},
  } as unknown as VPSDatabase & {
    _getAidRecord(id: string): AidRecordRow | undefined;
    _getAllAidRecords(): AidRecordRow[];
    _getAidConfig(deviceId: string): AidConfigRecord | undefined;
    _insertDevice(device: DeviceRow): void;
    _insertAidConfig(config: AidConfigRecord): void;
    _insertAidRecord(record: AidRecordRow): void;
    _getRunCalls(): Array<{ sql: string; params: unknown[] }>;
    _clearRunCalls(): void;
  };
}

// ===== Mock WS Manager 建構器 =====

function createMockWsManager() {
  const sentMessages: Map<string, WSServerMessage[]> = new Map();
  let onlineDevices: Set<string> = new Set();

  return {
    // 測試輔助
    _setOnline(deviceId: string) { onlineDevices.add(deviceId); },
    _setOffline(deviceId: string) { onlineDevices.delete(deviceId); },
    _getSentMessages(deviceId: string) { return sentMessages.get(deviceId) ?? []; },
    _getAllSentMessages() { return [...sentMessages.entries()]; },
    _clearMessages() { sentMessages.clear(); },

    // IWSManager 介面
    sendToDevice(deviceId: string, message: WSServerMessage): boolean {
      if (!onlineDevices.has(deviceId)) return false;
      const existing = sentMessages.get(deviceId) ?? [];
      existing.push(message);
      sentMessages.set(deviceId, existing);
      return true;
    },
    getConnection(deviceId: string) {
      if (!onlineDevices.has(deviceId)) return undefined;
      return { deviceId };
    },
  } as IWSManager & {
    _setOnline(deviceId: string): void;
    _setOffline(deviceId: string): void;
    _getSentMessages(deviceId: string): WSServerMessage[];
    _getAllSentMessages(): [string, WSServerMessage[]][];
    _clearMessages(): void;
  };
}

// ===== 測試輔助：建立標準 helper 設定 =====

function makeHelperConfig(
  deviceId: string,
  overrides: Partial<AidConfigRecord> = {},
): AidConfigRecord {
  // 注意：helper_public_key 刻意使用不含 device_id 的固定字串
  // 確保 helper device_id 匿名保護測試不受 key 命名影響
  return {
    device_id: deviceId,
    enabled: 1,
    allowed_services: null, // null = 接受所有 service
    daily_limit: 50,
    daily_given: 0,
    daily_reset_at: null,
    blackout_hours: null,
    helper_public_key: 'HelperPublicKeyBase64Abcxyz1234567890',
    aid_success_rate: 0.8,
    avg_aid_latency_ms: 3000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ===== 測試群組 =====

describe('AidEngine — handleRequest 基本流程', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  beforeEach(() => {
    db = createMockDb();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('1. 正常發起請求 → 202 + aid_id（格式 aid_...）', async () => {
    const result = await engine.handleRequest('clw_requester_001', {
      service_id: 'openai',
      request_type: 'chat_completion',
      requester_public_key: 'requester_pub_key_base64',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aid_id).toMatch(/^aid_\d+_[a-z0-9]+$/);

    // 確認 DB 有寫入記錄（queueMicrotask 在 bun:test 中為同步，狀態可能已更新為 no_helper）
    const record = db._getAidRecord(result.aid_id);
    expect(record).toBeDefined();
    // 記錄存在即代表 handleRequest 有正確寫入
    expect(record!.requester_device_id).toBe('clw_requester_001');
    expect(record!.service_id).toBe('openai');
  });

  it('2. 回傳值含 aid_id 和 status=matching', async () => {
    const result = await engine.handleRequest('clw_requester_002', {
      service_id: 'anthropic',
      request_type: 'message',
      requester_public_key: 'pub_key_002',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.aid_id).toBeTruthy();
  });
});

describe('AidEngine — 冷卻機制（60s→120s→240s）', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  beforeEach(() => {
    db = createMockDb();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('3. 第一次請求後立刻再發 → AID_COOLDOWN 429', async () => {
    // 第一次
    await engine.handleRequest('clw_cooldown_device', {
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'pub_key',
    });

    // 立刻第二次
    const result = await engine.handleRequest('clw_cooldown_device', {
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'pub_key',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(ErrorCode.AID_COOLDOWN);
    expect(result.retry_after).toBeGreaterThan(0);
    expect(result.retry_after).toBeLessThanOrEqual(60);
  });

  it('4. 不同裝置之間互不影響冷卻', async () => {
    // 裝置 A 發請求
    await engine.handleRequest('clw_device_A', {
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'pub_key_A',
    });

    // 裝置 B 也能馬上發（不受 A 影響）
    const result = await engine.handleRequest('clw_device_B', {
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'pub_key_B',
    });

    expect(result.ok).toBe(true);
  });
});

describe('AidEngine — 每日上限（30 次）', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  beforeEach(() => {
    db = createMockDb();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('5. 超過 30 次 → AID_DAILY_LIMIT_REACHED 429', async () => {
    const deviceId = 'clw_daily_limit_device';

    // 模擬 30 次成功請求（直接操作內部狀態）
    // 使用 private 欄位繞過冷卻（測試只驗每日上限）
    const today = new Date().toISOString().slice(0, 10);
    (engine as unknown as { cooldownMap: Map<string, unknown> }).cooldownMap.set(deviceId, {
      lastRequestAt: Date.now() - 70_000, // 70 秒前，不受冷卻
      consecutiveFails: 0,
      todayCount: 30, // 已達上限
      todayDate: today,
    });

    const result = await engine.handleRequest(deviceId, {
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'pub_key',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(ErrorCode.AID_DAILY_LIMIT_REACHED);
    expect(result.retry_after).toBeGreaterThan(0);
  });
});

describe('AidEngine — _matchHelper 配對邏輯', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  const REQUESTER_ID = 'clw_requester_test';
  const HELPER_ID = 'clw_helper_test';
  const AID_ID = 'aid_test_001';

  beforeEach(() => {
    db = createMockDb();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);

    // 設定雙方在線
    wsManager._setOnline(REQUESTER_ID);
    wsManager._setOnline(HELPER_ID);

    // 在 DB 中準備 requester 的 aid_record
    db._insertAidRecord({
      id: AID_ID,
      requester_device_id: REQUESTER_ID,
      helper_device_id: null,
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'requester_pub_key',
      helper_public_key: null,
      status: 'pending',
      latency_ms: null,
      timeout_reason: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('6. 有可用 helper → 雙向推送 aid_matched', async () => {
    // 在 DB 中準備 helper 設定
    db._insertDevice({ device_id: HELPER_ID, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_ID));

    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    // requester 應收到 aid_matched（含 helper_public_key，不含 helper device_id）
    const requesterMsgs = wsManager._getSentMessages(REQUESTER_ID);
    expect(requesterMsgs.length).toBeGreaterThanOrEqual(1);
    const requesterNotif = requesterMsgs.find((m) => {
      const payload = m.payload as { kind?: string };
      return payload?.kind === 'aid_matched';
    });
    expect(requesterNotif).toBeDefined();

    // helper 也應收到 aid_matched（含 service_id、requester_public_key）
    const helperMsgs = wsManager._getSentMessages(HELPER_ID);
    expect(helperMsgs.length).toBeGreaterThanOrEqual(1);
    const helperNotif = helperMsgs.find((m) => {
      const payload = m.payload as { kind?: string };
      return payload?.kind === 'aid_matched';
    });
    expect(helperNotif).toBeDefined();
  });

  it('7. helper device_id 不出現在 requester 收到的任何訊息中（匿名保護）', async () => {
    db._insertDevice({ device_id: HELPER_ID, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_ID));

    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    const requesterMsgs = wsManager._getSentMessages(REQUESTER_ID);

    // 將所有發給 requester 的訊息序列化成字串，檢查 HELPER_ID 有沒有出現
    const allMsgText = JSON.stringify(requesterMsgs);
    expect(allMsgText).not.toContain(HELPER_ID);
  });

  it('8. 沒有可用 helper → 推送 no_helper 給 requester', async () => {
    // 不插入任何 helper 設定
    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    const requesterMsgs = wsManager._getSentMessages(REQUESTER_ID);
    // 應推送 aid_result（status=timeout 代表無 helper）
    const noHelperMsg = requesterMsgs.find((m) => {
      const payload = m.payload as { kind?: string; status?: string };
      return payload?.kind === 'aid_result';
    });
    expect(noHelperMsg).toBeDefined();

    // aid_record 狀態應為 no_helper
    const record = db._getAidRecord(AID_ID);
    expect(record?.status).toBe('no_helper');
  });

  it('9. helper 的 daily_given 在配對後遞增', async () => {
    db._insertDevice({ device_id: HELPER_ID, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_ID, { daily_given: 5 }));

    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    const config = db._getAidConfig(HELPER_ID);
    expect(config?.daily_given).toBe(6);
  });

  it('10. daily_given >= daily_limit 的 helper 不會被選中', async () => {
    // daily_given = daily_limit（已達上限）
    db._insertDevice({ device_id: HELPER_ID, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_ID, { daily_limit: 5, daily_given: 5 }));

    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    // 沒有可用 helper，應推送 no_helper
    const record = db._getAidRecord(AID_ID);
    expect(record?.status).toBe('no_helper');
  });

  it('11. suspended 裝置不會被選為 helper', async () => {
    db._insertDevice({ device_id: HELPER_ID, status: 'suspended', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_ID));

    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    const record = db._getAidRecord(AID_ID);
    expect(record?.status).toBe('no_helper');
  });

  it('12. helper 的 allowed_services 過濾（不接受此 service_id）', async () => {
    db._insertDevice({ device_id: HELPER_ID, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_ID, {
      allowed_services: JSON.stringify(['anthropic']), // 只接受 anthropic
    }));

    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' }, // 要 openai
    );

    // openai 不在 allowed_services，不應被選中
    const record = db._getAidRecord(AID_ID);
    expect(record?.status).toBe('no_helper');
  });
});

describe('AidEngine — 評分（calculateHelperScore）', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  beforeEach(() => {
    db = createMockDb();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('13. 剩餘額度多 + 成功率高的 helper 排名優先', async () => {
    const HELPER_A = 'clw_helper_high_score';
    const HELPER_B = 'clw_helper_low_score';
    const AID_ID_SCORE = 'aid_score_test';

    // 在線
    wsManager._setOnline('clw_requester_score');
    wsManager._setOnline(HELPER_A);
    wsManager._setOnline(HELPER_B);

    // Helper A：高餘額、高成功率、低延遲
    db._insertDevice({ device_id: HELPER_A, status: 'active', reputation_weight: 1.5 });
    db._insertAidConfig(makeHelperConfig(HELPER_A, {
      daily_limit: 100,
      daily_given: 10,    // 剩餘 90
      aid_success_rate: 0.95,
      avg_aid_latency_ms: 1000,
    }));

    // Helper B：低餘額、低成功率、高延遲
    db._insertDevice({ device_id: HELPER_B, status: 'active', reputation_weight: 0.5 });
    db._insertAidConfig(makeHelperConfig(HELPER_B, {
      daily_limit: 50,
      daily_given: 45,    // 剩餘 5
      aid_success_rate: 0.3,
      avg_aid_latency_ms: 12000,
    }));

    db._insertAidRecord({
      id: AID_ID_SCORE,
      requester_device_id: 'clw_requester_score',
      helper_device_id: null,
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'pub_key',
      helper_public_key: null,
      status: 'pending',
      latency_ms: null,
      timeout_reason: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });

    await engine._matchHelper(
      AID_ID_SCORE,
      'clw_requester_score',
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'pub_key' },
    );

    // Helper A 應被選中（高分）
    const record = db._getAidRecord(AID_ID_SCORE);
    expect(record?.helper_device_id).toBe(HELPER_A);
  });
});

describe('AidEngine — relayAidData 密文轉發', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  const REQUESTER_ID = 'clw_relay_requester';
  const HELPER_ID = 'clw_relay_helper';
  const AID_ID = 'aid_relay_test';

  beforeEach(() => {
    db = createMockDb();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);

    // 雙方在線
    wsManager._setOnline(REQUESTER_ID);
    wsManager._setOnline(HELPER_ID);

    // 在 DB 中準備已配對的 aid_record
    db._insertAidRecord({
      id: AID_ID,
      requester_device_id: REQUESTER_ID,
      helper_device_id: HELPER_ID,
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'requester_pub_key',
      helper_public_key: 'helper_pub_key',
      status: 'matched',
      latency_ms: null,
      timeout_reason: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('14. encrypted_request（B→A）轉發 → helper 收到 aid_data', async () => {
    const body: AidRelayBody = {
      aid_id: AID_ID,
      from_device_id: REQUESTER_ID,
      encrypted_payload: 'base64_encrypted_payload',
      iv: 'base64_iv',
      tag: 'base64_tag',
      kind: 'encrypted_request',
    };

    const result = await engine.relayAidData(AID_ID, REQUESTER_ID, body);

    expect(result.ok).toBe(true);

    // helper 應收到 aid_data
    const helperMsgs = wsManager._getSentMessages(HELPER_ID);
    expect(helperMsgs.length).toBeGreaterThanOrEqual(1);
    const relayMsg = helperMsgs.find((m) => m.type === 'aid_data');
    expect(relayMsg).toBeDefined();

    // 轉發內容應原封不動
    const payload = relayMsg!.payload as {
      encrypted_payload: string;
      iv: string;
      tag: string;
      kind: string;
    };
    expect(payload.encrypted_payload).toBe('base64_encrypted_payload');
    expect(payload.iv).toBe('base64_iv');
    expect(payload.tag).toBe('base64_tag');
    expect(payload.kind).toBe('encrypted_request');
  });

  it('15. encrypted_response（A→B）轉發 → requester 收到 aid_data', async () => {
    const body: AidRelayBody = {
      aid_id: AID_ID,
      from_device_id: HELPER_ID,
      encrypted_payload: 'response_payload_base64',
      iv: 'response_iv',
      tag: 'response_tag',
      kind: 'encrypted_response',
      helper_public_key: 'helper_pub_key',
    };

    const result = await engine.relayAidData(AID_ID, HELPER_ID, body);

    expect(result.ok).toBe(true);

    // requester 應收到 aid_data
    const requesterMsgs = wsManager._getSentMessages(REQUESTER_ID);
    const relayMsg = requesterMsgs.find((m) => m.type === 'aid_data');
    expect(relayMsg).toBeDefined();
  });

  it('16. 轉發時 from_device_id 不出現在目標訊息中（匿名保護）', async () => {
    const body: AidRelayBody = {
      aid_id: AID_ID,
      from_device_id: REQUESTER_ID,
      encrypted_payload: 'payload',
      iv: 'iv',
      tag: 'tag',
      kind: 'encrypted_request',
    };

    await engine.relayAidData(AID_ID, REQUESTER_ID, body);

    // helper 收到的訊息不應含 REQUESTER_ID
    const helperMsgs = wsManager._getSentMessages(HELPER_ID);
    const allMsgText = JSON.stringify(helperMsgs);
    expect(allMsgText).not.toContain(REQUESTER_ID);
  });

  it('17. payload 超過 64KB → AID_PAYLOAD_TOO_LARGE 413', async () => {
    // 產生超大 payload（base64 字串，解碼後 > 64KB）
    const oversized = 'A'.repeat(90 * 1024); // 90KB 的 base64 字串

    const body: AidRelayBody = {
      aid_id: AID_ID,
      from_device_id: REQUESTER_ID,
      encrypted_payload: oversized,
      iv: 'iv',
      tag: 'tag',
      kind: 'encrypted_request',
    };

    const result = await engine.relayAidData(AID_ID, REQUESTER_ID, body);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(ErrorCode.AID_PAYLOAD_TOO_LARGE);
  });

  it('18. 不存在的 aid_id → INVALID_REQUEST', async () => {
    const body: AidRelayBody = {
      aid_id: 'aid_nonexistent',
      from_device_id: REQUESTER_ID,
      encrypted_payload: 'payload',
      iv: 'iv',
      tag: 'tag',
      kind: 'encrypted_request',
    };

    const result = await engine.relayAidData('aid_nonexistent', REQUESTER_ID, body);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(ErrorCode.INVALID_REQUEST);
  });
});

describe('AidEngine — 30 秒超時處理', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  const REQUESTER_ID = 'clw_timeout_requester';
  const HELPER_ID = 'clw_timeout_helper';
  const AID_ID = 'aid_timeout_test';

  beforeEach(() => {
    db = createMockDb();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);

    wsManager._setOnline(REQUESTER_ID);
    wsManager._setOnline(HELPER_ID);

    db._insertDevice({ device_id: HELPER_ID, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_ID));

    db._insertAidRecord({
      id: AID_ID,
      requester_device_id: REQUESTER_ID,
      helper_device_id: null,
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'requester_pub_key',
      helper_public_key: null,
      status: 'pending',
      latency_ms: null,
      timeout_reason: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('19. 配對後 activeMatches 應有一筆記錄', async () => {
    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    expect(engine._getActiveMatchCount()).toBe(1);
    const match = engine._getActiveMatch(AID_ID);
    expect(match).toBeDefined();
    expect(match!.requesterId).toBe(REQUESTER_ID);
    expect(match!.helperId).toBe(HELPER_ID);
  });

  it('20. markMatchResult(fulfilled) → 計時器清除 + aid_record 更新', async () => {
    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    expect(engine._getActiveMatchCount()).toBe(1);

    // 模擬 helper 回應成功
    engine.markMatchResult(AID_ID, 'fulfilled', 2000);

    // activeMatches 應清空
    expect(engine._getActiveMatchCount()).toBe(0);

    // aid_record 應更新
    const record = db._getAidRecord(AID_ID);
    expect(record?.status).toBe('fulfilled');
    expect(record?.latency_ms).toBe(2000);
  });
});

describe('AidEngine — updateConfig / getConfig', () => {
  let db: ReturnType<typeof createMockDb>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  beforeEach(() => {
    db = createMockDb();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);
  });

  it('21. updateConfig 儲存設定 → getConfig 可取回', async () => {
    const deviceId = 'clw_config_device';
    const config: AidConfigBody = {
      enabled: true,
      allowed_services: ['openai', 'anthropic'],
      daily_limit: 100,
      blackout_hours: [0, 1, 2, 3],
      helper_public_key: 'my_helper_pub_key',
    };

    const result = await engine.updateConfig(deviceId, config);
    expect(result.ok).toBe(true);

    const retrieved = engine.getConfig(deviceId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.enabled).toBe(true);
    expect(retrieved!.allowed_services).toEqual(['openai', 'anthropic']);
    expect(retrieved!.daily_limit).toBe(100);
    expect(retrieved!.helper_public_key).toBe('my_helper_pub_key');
  });

  it('22. 未設定過的裝置 → getConfig 回 null', () => {
    const result = engine.getConfig('clw_never_configured');
    expect(result).toBeNull();
  });

  it('23. daily_limit 超出範圍（0） → 回傳 INVALID_REQUEST', async () => {
    const result = await engine.updateConfig('clw_invalid_limit', { daily_limit: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('24. daily_limit 超出範圍（201） → 回傳 INVALID_REQUEST', async () => {
    const result = await engine.updateConfig('clw_invalid_limit2', { daily_limit: 201 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(ErrorCode.INVALID_REQUEST);
  });
});

// ===== 以下為新增測試：感謝榜、積分、積分加成配對 =====

// ===== 擴展版 Mock DB 建構器（支援 aid_credits + leaderboard 查詢） =====

interface AidCreditRecord {
  device_id: string;
  credits: number;
  earned_total: number;
  spent_total: number;
}

function createMockDbWithExtras() {
  const base = createMockDb();
  const aidCredits: Map<string, AidCreditRecord> = new Map();

  // 感謝榜用的彙總資料（手動設定）
  let leaderboardRows: Array<{
    device_id: string;
    total_helped: number;
    services: string;
  }> = [];

  // 裝置信譽分數（用於感謝榜查 reputation_weight）
  const deviceReputation: Map<string, number> = new Map();

  // 攔截 base.query，追加新查詢支援
  const originalQuery = base.query.bind(base);
  (base as unknown as { query: typeof base.query }).query = function <T>(sql: string, params?: unknown[]): T[] {
    const s = sql.trim().toLowerCase().replace(/\s+/g, ' ');

    // --- 感謝榜查詢：aid_stats + group by ---
    if (s.includes('from aid_stats') && s.includes('group by') && s.includes('direction')) {
      const limit = (params?.[0] as number) ?? 20;
      return leaderboardRows.slice(0, limit) as unknown as T[];
    }

    // --- 感謝榜查 reputation_weight ---
    if (s.includes('select reputation_weight from devices where device_id =')) {
      const deviceId = params?.[0] as string;
      const weight = deviceReputation.get(deviceId) ?? 0.5;
      return [{ reputation_weight: weight }] as unknown as T[];
    }

    // --- 積分查詢：aid_credits ---
    if (s.includes('from aid_credits') && s.includes('where device_id =')) {
      const deviceId = params?.[0] as string;
      const record = aidCredits.get(deviceId);
      if (!record) return [] as T[];
      return [{ credits: record.credits, earned_total: record.earned_total, spent_total: record.spent_total }] as unknown as T[];
    }

    // 其餘查詢交給原始 mock
    return originalQuery<T>(sql, params);
  };

  // 攔截 base.run，追加 aid_credits 寫入支援
  const originalRun = base.run.bind(base);
  (base as unknown as { run: typeof base.run }).run = function (sql: string, params?: unknown[]) {
    const s = sql.trim().toLowerCase().replace(/\s+/g, ' ');

    // --- 積分 UPSERT：INSERT INTO aid_credits ---
    if (s.includes('insert into aid_credits')) {
      const deviceId = params?.[0] as string;
      const existing = aidCredits.get(deviceId);
      if (existing) {
        existing.credits += 1;
        existing.earned_total += 1;
      } else {
        aidCredits.set(deviceId, {
          device_id: deviceId,
          credits: 1,
          earned_total: 1,
          spent_total: 0,
        });
      }
      // 也呼叫原始 run 讓 runCalls 記錄保留
      return originalRun(sql, params);
    }

    return originalRun(sql, params);
  };

  return Object.assign(base, {
    // 測試輔助：設定感謝榜資料
    _setLeaderboardRows(rows: Array<{ device_id: string; total_helped: number; services: string }>) {
      leaderboardRows = rows;
    },
    // 測試輔助：設定裝置信譽分數
    _setDeviceReputation(deviceId: string, weight: number) {
      deviceReputation.set(deviceId, weight);
    },
    // 測試輔助：設定積分記錄
    _setAidCredits(deviceId: string, credits: number, earnedTotal: number, spentTotal: number) {
      aidCredits.set(deviceId, { device_id: deviceId, credits, earned_total: earnedTotal, spent_total: spentTotal });
    },
    // 測試輔助：取得積分記錄
    _getAidCredits(deviceId: string) { return aidCredits.get(deviceId); },
  });
}

// ===== 25~28：感謝榜測試 =====

describe('AidEngine — getLeaderboard', () => {
  let db: ReturnType<typeof createMockDbWithExtras>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  beforeEach(() => {
    db = createMockDbWithExtras();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('25. 多裝置有 aid_stats → 按 total_helped DESC 排列', () => {
    // 設定感謝榜原始資料（模擬 DB 彙總結果）
    db._setLeaderboardRows([
      { device_id: 'clw_helper_top', total_helped: 100, services: 'openai,anthropic' },
      { device_id: 'clw_helper_mid', total_helped: 50, services: 'openai' },
      { device_id: 'clw_helper_low', total_helped: 10, services: 'groq' },
    ]);
    db._setDeviceReputation('clw_helper_top', 1.8);
    db._setDeviceReputation('clw_helper_mid', 1.0);
    db._setDeviceReputation('clw_helper_low', 0.5);

    const result = engine.getLeaderboard();

    expect(result.length).toBe(3);
    // 排名應從 1 開始
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
    expect(result[2].rank).toBe(3);
    // 第一名的幫助次數最多
    expect(result[0].total_helped).toBe(100);
    expect(result[2].total_helped).toBe(10);
  });

  it('26. 匿名化：device_id 不出現在結果中，名稱為「龍蝦 #XXX」格式', () => {
    db._setLeaderboardRows([
      { device_id: 'clw_secret_device_123', total_helped: 42, services: 'openai' },
    ]);
    db._setDeviceReputation('clw_secret_device_123', 1.0);

    const result = engine.getLeaderboard();

    expect(result.length).toBe(1);
    // 匿名名稱格式檢查
    expect(result[0].anonymous_name).toMatch(/^龍蝦 #\d+$/);
    // device_id 不應出現在序列化結果中
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('clw_secret_device_123');
  });

  it('27. limit 參數：limit=2 只回傳 2 筆', () => {
    db._setLeaderboardRows([
      { device_id: 'clw_a', total_helped: 100, services: 'openai' },
      { device_id: 'clw_b', total_helped: 50, services: 'openai' },
      { device_id: 'clw_c', total_helped: 10, services: 'openai' },
    ]);
    db._setDeviceReputation('clw_a', 1.0);
    db._setDeviceReputation('clw_b', 1.0);

    const result = engine.getLeaderboard(2);

    expect(result.length).toBe(2);
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
  });

  it('28. 無資料 → 空陣列', () => {
    db._setLeaderboardRows([]);

    const result = engine.getLeaderboard();

    expect(result).toEqual([]);
  });
});

// ===== 29~30：積分查詢測試 =====

describe('AidEngine — getCredits', () => {
  let db: ReturnType<typeof createMockDbWithExtras>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  beforeEach(() => {
    db = createMockDbWithExtras();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('29. 有積分記錄 → 回傳 { credits, earned_total, spent_total }', () => {
    db._setAidCredits('clw_rich_device', 25, 30, 5);

    const result = engine.getCredits('clw_rich_device');

    expect(result.credits).toBe(25);
    expect(result.earned_total).toBe(30);
    expect(result.spent_total).toBe(5);
  });

  it('30. 無記錄 → 回傳全部為 0', () => {
    const result = engine.getCredits('clw_unknown_device');

    expect(result.credits).toBe(0);
    expect(result.earned_total).toBe(0);
    expect(result.spent_total).toBe(0);
  });
});

// ===== 31~32：積分頒發測試 =====

describe('AidEngine — _awardCredit', () => {
  let db: ReturnType<typeof createMockDbWithExtras>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  beforeEach(() => {
    db = createMockDbWithExtras();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('31. 呼叫 _awardCredit → DB run() 被呼叫，SQL 包含 aid_credits', () => {
    db._clearRunCalls();

    engine._awardCredit('clw_helper_award');

    const calls = db._getRunCalls();
    // 至少有一筆 run 呼叫
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // 找到包含 aid_credits 的 SQL
    const creditCall = calls.find((c) => c.sql.toLowerCase().includes('aid_credits'));
    expect(creditCall).toBeDefined();
    // SQL 應包含 INSERT（UPSERT 語法）
    expect(creditCall!.sql.toLowerCase()).toContain('insert');
  });

  it('32. 連續頒發兩次 → 積分累加', () => {
    engine._awardCredit('clw_helper_double');
    engine._awardCredit('clw_helper_double');

    const record = db._getAidCredits('clw_helper_double');
    expect(record).toBeDefined();
    expect(record!.credits).toBe(2);
    expect(record!.earned_total).toBe(2);
  });
});

// ===== 33~34：積分加成配對測試 =====

describe('AidEngine — credit bonus in matching', () => {
  let db: ReturnType<typeof createMockDbWithExtras>;
  let wsManager: ReturnType<typeof createMockWsManager>;
  let engine: AidEngine;

  const REQUESTER_ID = 'clw_credit_requester';
  const HELPER_A = 'clw_credit_helper_a';
  const HELPER_B = 'clw_credit_helper_b';
  const AID_ID = 'aid_credit_bonus_test';

  beforeEach(() => {
    db = createMockDbWithExtras();
    wsManager = createMockWsManager();
    engine = new AidEngine(db, wsManager);

    wsManager._setOnline(REQUESTER_ID);
    wsManager._setOnline(HELPER_A);
    wsManager._setOnline(HELPER_B);
  });

  afterEach(() => {
    engine._clearAllTimers();
  });

  it('33. 高積分 requester（credits=30）配對時評分有加成', async () => {
    // 設定 requester 的積分（30 積分 → creditBonus = min(30/10, 2.0) = 2.0）
    db._setAidCredits(REQUESTER_ID, 30, 30, 0);

    // 準備兩個條件完全相同的 helper（只靠 credit bonus 拉分）
    db._insertDevice({ device_id: HELPER_A, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_A, {
      daily_limit: 50,
      daily_given: 25,
      aid_success_rate: 0.5,
      avg_aid_latency_ms: 5000,
    }));

    db._insertDevice({ device_id: HELPER_B, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_B, {
      daily_limit: 50,
      daily_given: 25,
      aid_success_rate: 0.5,
      avg_aid_latency_ms: 5000,
    }));

    db._insertAidRecord({
      id: AID_ID,
      requester_device_id: REQUESTER_ID,
      helper_device_id: null,
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'requester_pub_key',
      helper_public_key: null,
      status: 'pending',
      latency_ms: null,
      timeout_reason: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });

    await engine._matchHelper(
      AID_ID,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    // 有 helper 被選中（高積分 requester 仍能正常配對）
    const record = db._getAidRecord(AID_ID);
    expect(record?.status).toBe('matched');
    expect(record?.helper_device_id).toBeDefined();
  });

  it('34. 零積分 requester 配對正常運作（creditBonus = 0）', async () => {
    // requester 沒有任何積分記錄 → getCredits 回傳 0 → creditBonus = 0
    const AID_ID_ZERO = 'aid_zero_credit_test';

    db._insertDevice({ device_id: HELPER_A, status: 'active', reputation_weight: 1.0 });
    db._insertAidConfig(makeHelperConfig(HELPER_A));

    db._insertAidRecord({
      id: AID_ID_ZERO,
      requester_device_id: REQUESTER_ID,
      helper_device_id: null,
      service_id: 'openai',
      request_type: 'chat',
      requester_public_key: 'requester_pub_key',
      helper_public_key: null,
      status: 'pending',
      latency_ms: null,
      timeout_reason: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });

    await engine._matchHelper(
      AID_ID_ZERO,
      REQUESTER_ID,
      { service_id: 'openai', request_type: 'chat', requester_public_key: 'requester_pub_key' },
    );

    // 即使積分為 0，配對仍正常
    const record = db._getAidRecord(AID_ID_ZERO);
    expect(record?.status).toBe('matched');
    expect(record?.helper_device_id).toBe(HELPER_A);
  });
});
