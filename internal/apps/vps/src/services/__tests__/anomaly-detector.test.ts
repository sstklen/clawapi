// AnomalyDetector 單元測試
// 涵蓋：4 條異常規則、downweight、suspend 動作
// Mock DB 不依賴真實 SQLite

import { describe, it, expect, beforeEach } from 'bun:test';
import { AnomalyDetector } from '../anomaly-detector';
import type { GlobalStats } from '../anomaly-detector';
import type { VPSDatabase } from '../../storage/database';
import type { TelemetryBatch } from '@clawapi/protocol';

// ===== Mock DB =====

function createMockDb() {
  const batchCountsByDevice = new Map<string, number>();
  const deviceCreatedAtMap = new Map<string, string>();
  const deviceTotalEntries = new Map<string, number>();
  const anomalyStore: Array<Record<string, unknown>> = [];
  const deviceStatusMap = new Map<string, string>();

  const db = {
    // 測試輔助方法
    _setBatchCountForDevice(deviceId: string, count: number) {
      batchCountsByDevice.set(deviceId, count);
    },
    _setDeviceCreatedAt(deviceId: string, createdAt: string) {
      deviceCreatedAtMap.set(deviceId, createdAt);
    },
    _setDeviceTotalEntries(deviceId: string, total: number) {
      deviceTotalEntries.set(deviceId, total);
    },
    _getAnomalies() { return anomalyStore; },
    _getDeviceStatus(deviceId: string) { return deviceStatusMap.get(deviceId); },

    query<T>(sql: string, params?: unknown[]): T[] {
      const s = sql.trim().toLowerCase();

      // 查詢批次計數（1 小時內）
      if (s.includes('count(*) as count from telemetry_batches') && s.includes("received_at > datetime('now', '-1 hour')") && params?.[0]) {
        const deviceId = params[0] as string;
        const count = batchCountsByDevice.get(deviceId) ?? 0;
        return [{ count } as unknown as T];
      }

      // 查詢裝置建立時間
      if (s.includes('select created_at from devices') && params?.[0]) {
        const deviceId = params[0] as string;
        const createdAt = deviceCreatedAtMap.get(deviceId);
        if (!createdAt) return [] as T[];
        return [{ created_at: createdAt } as unknown as T];
      }

      // 查詢裝置歷史條目總數
      if (s.includes('coalesce(sum(total_requests), 0) as count') && s.includes('from telemetry_batches') && params?.[0]) {
        const deviceId = params[0] as string;
        const count = deviceTotalEntries.get(deviceId) ?? 0;
        return [{ count } as unknown as T];
      }

      return [] as T[];
    },

    run(sql: string, params?: unknown[]) {
      const s = sql.trim().toLowerCase();

      // INSERT anomaly_detections
      if (s.startsWith('insert into anomaly_detections')) {
        anomalyStore.push({
          device_id: params?.[0],
          anomaly_type: params?.[1],
          reasons: params?.[2],
          action_taken: params?.[3],
        });
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE devices（anomaly_count 或 status）
      if (s.startsWith('update devices')) {
        if (s.includes("status = 'suspended'") && params?.[1]) {
          deviceStatusMap.set(params[1] as string, 'suspended');
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      return { changes: 1, lastInsertRowid: 0 };
    },

    getDevice: () => null,
    updateDeviceLastSeen: () => {},
    transaction<T>(fn: () => T): T { return fn(); },
  } as unknown as VPSDatabase & {
    _setBatchCountForDevice(id: string, count: number): void;
    _setDeviceCreatedAt(id: string, at: string): void;
    _setDeviceTotalEntries(id: string, total: number): void;
    _getAnomalies(): Array<Record<string, unknown>>;
    _getDeviceStatus(id: string): string | undefined;
  };

  return db;
}

// ===== 空的全體統計數據 =====

function emptyGlobalStats(): GlobalStats {
  return {
    serviceSuccessRates: new Map(),
    serviceP95Latencies: new Map(),
    serviceSampleCounts: new Map(),
  };
}

// ===== 測試用批次產生器 =====

function makeBatch(
  serviceId: string,
  outcomes: string[],
  latencies?: (number | null)[],
): TelemetryBatch {
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const to = now.toISOString();

  const entries = outcomes.map((outcome, i) => ({
    service_id: serviceId,
    tier: 'L1' as const,
    outcome: outcome as 'success' | 'rate_limited' | 'error' | 'timeout',
    latency_ms: latencies?.[i] ?? 500,
    routing_strategy: 'fast' as const,
    retry_count: 0,
    time_bucket: 'morning' as const,
  }));

  const successCount = outcomes.filter((o) => o === 'success').length;

  return {
    schema_version: 1,
    batch_id: `batch_test_${Math.random().toString(36).slice(2, 10)}`,
    period: { from, to },
    entries,
    summary: {
      total_requests: outcomes.length,
      success_rate: outcomes.length > 0 ? successCount / outcomes.length : 0,
      services_used: [serviceId],
      pool_stats: { king_pool_used: 1, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 },
    },
  };
}

// ===== 測試套件 =====

describe('AnomalyDetector', () => {
  let db: ReturnType<typeof createMockDb>;
  let detector: AnomalyDetector;

  const deviceId = 'clw_test00000000000000000000000000001';

  beforeEach(() => {
    db = createMockDb();
    detector = new AnomalyDetector(db as unknown as VPSDatabase);
  });

  // ─── 規則 1：與多數人矛盾 ────────────────────────────────────────

  describe('規則 1：與多數人矛盾', () => {
    it('驗收標準 3：全 100% 失敗但全體 90%+ 成功 → flagged', () => {
      // 本批次：10 條全部失敗
      const batch = makeBatch('groq', Array(10).fill('error'));

      // 全體統計：groq 成功率 95%，樣本 100
      const globalStats: GlobalStats = {
        serviceSuccessRates: new Map([['groq', 0.95]]),
        serviceP95Latencies: new Map([['groq', 1000]]),
        serviceSampleCounts: new Map([['groq', 100]]),
      };

      const report = detector.detect(batch, deviceId, globalStats);

      expect(report.hasAnomaly).toBe(true);
      expect(report.reasons.some((r) => r.rule === 'contradicts_majority')).toBe(true);
    });

    it('全體樣本不足 50 → 不觸發矛盾規則', () => {
      const batch = makeBatch('gemini', Array(10).fill('error'));

      const globalStats: GlobalStats = {
        serviceSuccessRates: new Map([['gemini', 0.95]]),
        serviceP95Latencies: new Map(),
        serviceSampleCounts: new Map([['gemini', 30]]), // < 50，不足
      };

      const report = detector.detect(batch, deviceId, globalStats);

      expect(report.reasons.some((r) => r.rule === 'contradicts_majority')).toBe(false);
    });

    it('本批次條目不足 5 → 不觸發矛盾規則', () => {
      // 只有 3 條
      const batch = makeBatch('openai', ['error', 'error', 'error']);

      const globalStats: GlobalStats = {
        serviceSuccessRates: new Map([['openai', 0.95]]),
        serviceP95Latencies: new Map(),
        serviceSampleCounts: new Map([['openai', 100]]),
      };

      const report = detector.detect(batch, deviceId, globalStats);
      expect(report.reasons.some((r) => r.rule === 'contradicts_majority')).toBe(false);
    });

    it('本批次成功率 > 50% → 不觸發矛盾規則', () => {
      // 8/10 成功 → 80%，不觸發
      const batch = makeBatch('groq', [
        ...Array(8).fill('success'),
        ...Array(2).fill('error'),
      ]);

      const globalStats: GlobalStats = {
        serviceSuccessRates: new Map([['groq', 0.95]]),
        serviceP95Latencies: new Map(),
        serviceSampleCounts: new Map([['groq', 100]]),
      };

      const report = detector.detect(batch, deviceId, globalStats);
      expect(report.reasons.some((r) => r.rule === 'contradicts_majority')).toBe(false);
    });
  });

  // ─── 規則 2：延遲離群 ────────────────────────────────────────────

  describe('規則 2：延遲離群', () => {
    it('本批次 p95 > 全體 p95 × 5 → flagged', () => {
      // 全體 p95 = 1000ms，本批次延遲全是 6000ms（> 1000 × 5 = 5000）
      const batch = makeBatch(
        'anthropic',
        Array(10).fill('success'),
        Array(10).fill(6000),
      );

      const globalStats: GlobalStats = {
        serviceSuccessRates: new Map([['anthropic', 0.95]]),
        serviceP95Latencies: new Map([['anthropic', 1000]]),
        serviceSampleCounts: new Map([['anthropic', 100]]),
      };

      const report = detector.detect(batch, deviceId, globalStats);
      expect(report.reasons.some((r) => r.rule === 'latency_outlier')).toBe(true);
    });

    it('本批次 p95 在正常範圍 → 不觸發', () => {
      const batch = makeBatch(
        'deepseek',
        Array(10).fill('success'),
        Array(10).fill(1500),  // 1500ms，全體 p95 = 1000ms，1500 < 5000
      );

      const globalStats: GlobalStats = {
        serviceSuccessRates: new Map([['deepseek', 0.9]]),
        serviceP95Latencies: new Map([['deepseek', 1000]]),
        serviceSampleCounts: new Map([['deepseek', 50]]),
      };

      const report = detector.detect(batch, deviceId, globalStats);
      expect(report.reasons.some((r) => r.rule === 'latency_outlier')).toBe(false);
    });
  });

  // ─── 規則 3：上報頻率異常 ────────────────────────────────────────

  describe('規則 3：上報頻率異常', () => {
    it('1 小時內 > 3 次 → flagged', () => {
      db._setBatchCountForDevice(deviceId, 4); // 已上報 4 次

      const batch = makeBatch('groq', ['success', 'success', 'success']);
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      expect(report.reasons.some((r) => r.rule === 'excessive_frequency')).toBe(true);
    });

    it('1 小時內 ≤ 3 次 → 不觸發', () => {
      db._setBatchCountForDevice(deviceId, 2); // 只上報 2 次

      const batch = makeBatch('groq', ['success', 'success']);
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      expect(report.reasons.some((r) => r.rule === 'excessive_frequency')).toBe(false);
    });
  });

  // ─── 規則 4：新帳號大量數據 ──────────────────────────────────────

  describe('規則 4：新帳號大量數據', () => {
    it('帳號 < 3 天且累計 > 500 條 → flagged', () => {
      // 建立 1 天前的帳號
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      db._setDeviceCreatedAt(deviceId, recentDate);
      db._setDeviceTotalEntries(deviceId, 490); // 已有 490 條

      // 本批次 20 條 → 總共 510 > 500
      const batch = makeBatch('openai', Array(20).fill('success'));
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      expect(report.reasons.some((r) => r.rule === 'new_account_bulk')).toBe(true);
    });

    it('帳號 ≥ 3 天 → 不觸發新帳號規則', () => {
      // 建立 5 天前的帳號
      const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      db._setDeviceCreatedAt(deviceId, oldDate);
      db._setDeviceTotalEntries(deviceId, 1000);

      const batch = makeBatch('openai', Array(20).fill('success'));
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      expect(report.reasons.some((r) => r.rule === 'new_account_bulk')).toBe(false);
    });

    it('新帳號但數據量未超過 500 → 不觸發', () => {
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      db._setDeviceCreatedAt(deviceId, recentDate);
      db._setDeviceTotalEntries(deviceId, 100); // 只有 100 條

      const batch = makeBatch('openai', Array(10).fill('success'));
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      expect(report.reasons.some((r) => r.rule === 'new_account_bulk')).toBe(false);
    });
  });

  // ─── 動作判定 ────────────────────────────────────────────────────

  describe('動作判定', () => {
    it('0 個 reason → action = none', () => {
      const batch = makeBatch('groq', ['success', 'success']);
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      expect(report.action).toBe('none');
      expect(report.hasAnomaly).toBe(false);
    });

    it('1 個 reason → action = downweight', () => {
      db._setBatchCountForDevice(deviceId, 4); // 觸發頻率異常

      const batch = makeBatch('groq', ['success']);
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      expect(report.action).toBe('downweight');
      expect(report.suggestedWeight).toBe(0.3);
      expect(report.hasAnomaly).toBe(true);
    });

    it('≥ 3 個 reason → action = suspend，裝置被暫停', () => {
      // 同時觸發 3 個規則：
      // 1. 頻率異常（4 次）
      // 2. 矛盾全體（全失敗但全體 95%）
      // 3. 延遲離群（p95 >> 全體 p95）

      db._setBatchCountForDevice(deviceId, 4); // 規則 3

      // 本批次：10 條全失敗，延遲很高
      const batch = makeBatch(
        'groq',
        Array(10).fill('error'),
        Array(10).fill(8000),
      );

      const globalStats: GlobalStats = {
        serviceSuccessRates: new Map([['groq', 0.95]]),
        serviceP95Latencies: new Map([['groq', 1000]]),
        serviceSampleCounts: new Map([['groq', 100]]),
      };

      // 新帳號規則（補 1 個讓 reasons ≥ 3）
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      db._setDeviceCreatedAt(deviceId, recentDate);
      db._setDeviceTotalEntries(deviceId, 490);

      // batch 本身 entries = 10，490 + 10 = 500，但 > 500 才觸發，所以用 491 + 10 = 501
      db._setDeviceTotalEntries(deviceId, 491);

      const report = detector.detect(batch, deviceId, globalStats);

      // 預期至少觸發 3 條規則：矛盾 + 延遲 + 頻率
      expect(report.reasons.length).toBeGreaterThanOrEqual(3);
      expect(report.action).toBe('suspend');

      // 裝置狀態應被設為 suspended
      expect(db._getDeviceStatus(deviceId)).toBe('suspended');
    });

    it('suspend 時寫入 anomaly_detections 記錄', () => {
      db._setBatchCountForDevice(deviceId, 4); // 頻率異常

      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      db._setDeviceCreatedAt(deviceId, recentDate);
      db._setDeviceTotalEntries(deviceId, 491);

      const batch = makeBatch(
        'groq',
        Array(10).fill('error'),
        Array(10).fill(8000),
      );

      const globalStats: GlobalStats = {
        serviceSuccessRates: new Map([['groq', 0.95]]),
        serviceP95Latencies: new Map([['groq', 1000]]),
        serviceSampleCounts: new Map([['groq', 100]]),
      };

      detector.detect(batch, deviceId, globalStats);

      const anomalies = db._getAnomalies();
      expect(anomalies.length).toBeGreaterThan(0);
      expect(anomalies[0]?.['device_id']).toBe(deviceId);
    });
  });

  // ─── 回傳格式 ────────────────────────────────────────────────────

  describe('回傳格式', () => {
    it('AnomalyReport 包含必要欄位', () => {
      const batch = makeBatch('groq', ['success']);
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      expect(report).toHaveProperty('deviceId');
      expect(report).toHaveProperty('hasAnomaly');
      expect(report).toHaveProperty('reasons');
      expect(report).toHaveProperty('action');
      expect(Array.isArray(report.reasons)).toBe(true);
    });

    it('AnomalyReason 包含 rule、description、evidence', () => {
      db._setBatchCountForDevice(deviceId, 4);

      const batch = makeBatch('groq', ['success']);
      const report = detector.detect(batch, deviceId, emptyGlobalStats());

      if (report.reasons.length > 0) {
        const reason = report.reasons[0]!;
        expect(reason).toHaveProperty('rule');
        expect(reason).toHaveProperty('description');
        expect(reason).toHaveProperty('evidence');
      }
    });
  });
});
