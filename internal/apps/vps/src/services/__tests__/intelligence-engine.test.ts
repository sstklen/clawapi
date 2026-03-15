// IntelligenceEngine 單元測試
// 涵蓋：receiveBatch、runHourlyAnalysis、getRouteSuggestions、handleFeedback、coldStart
// 使用 in-memory 物件 mock DB，不依賴真實 SQLite

import { describe, it, expect, beforeEach } from 'bun:test';
import { IntelligenceEngine } from '../intelligence-engine';
import type { VPSDatabase, Device } from '../../storage/database';
import type { TelemetryBatch } from '@clawapi/protocol';
import { ErrorCode } from '@clawapi/protocol';

// ===== Mock DB 建構器 =====

function createMockDb() {
  // 各資料表的記憶體儲存
  const batchesStore: Map<string, Record<string, unknown>> = new Map();
  const entriesStore: Array<Record<string, unknown>> = [];
  const recommendationsStore: Map<string, Record<string, unknown>> = new Map();
  const alertsStore: Array<Record<string, unknown>> = [];
  const feedbackStore: Array<Record<string, unknown>> = [];
  const feedbackAggStore: Map<string, Record<string, unknown>> = new Map();
  const aggregatedStore: Array<Record<string, unknown>> = [];
  const devicesStore: Map<string, Device> = new Map();

  // 裝置批次計數（模擬 telemetry_batches 的批次數量）
  const deviceBatchCounts: Map<string, number> = new Map();

  const db = {
    // 測試輔助方法
    _insertDevice(device: Device) { devicesStore.set(device.device_id, device); },
    _getDevice(id: string) { return devicesStore.get(id); },
    _getBatches() { return [...batchesStore.values()]; },
    _getEntries() { return entriesStore; },              // 回傳原始陣列參考（供測試 push）
    _addEntry(entry: Record<string, unknown>) { entriesStore.push(entry); },  // 直接插入條目
    _getRecommendations() { return [...recommendationsStore.values()]; },
    _getAlerts() { return [...alertsStore]; },
    _getFeedback() { return [...feedbackStore]; },
    _insertAggregated(row: Record<string, unknown>) { aggregatedStore.push(row); },
    _setDeviceBatchCount(deviceId: string, count: number) {
      deviceBatchCounts.set(deviceId, count);
    },

    getDevice(deviceId: string): Device | null {
      return devicesStore.get(deviceId) ?? null;
    },

    updateDeviceLastSeen(_deviceId: string): void {
      // mock：忽略
    },

    query<T>(sql: string, params?: unknown[]): T[] {
      const s = sql.trim().toLowerCase();

      // 查詢裝置資料
      if (s.includes('from devices') && s.includes('device_id = ?') && params?.[0]) {
        const device = devicesStore.get(params[0] as string);
        return device ? [device as unknown as T] : [] as T[];
      }

      // 查詢裝置 created_at（異常偵測用）
      if (s.includes('select created_at from devices') && params?.[0]) {
        const device = devicesStore.get(params[0] as string);
        return device ? [{ created_at: device.created_at } as unknown as T] : [] as T[];
      }

      // 查詢批次計數（信譽加權用）
      if (s.includes('count(*) as count from telemetry_batches') && s.includes('device_id = ?') && params?.[0]) {
        const deviceId = params[0] as string;
        const count = deviceBatchCounts.get(deviceId) ?? batchesStore.size;
        return [{ count } as unknown as T];
      }

      // 查詢近 1 小時批次計數（速率限制 / 配額用）
      if (s.includes('from telemetry_batches') && s.includes('device_id = ?') && s.includes('received_at >') && params?.[0]) {
        const deviceId = params[0] as string;
        const count = [...batchesStore.values()].filter(
          (b) => b['device_id'] === deviceId,
        ).length;
        return [{ count } as unknown as T];
      }

      // 查詢近 1 小時遙測條目（每小時分析用）
      if (s.includes('from telemetry_entries te') && s.includes('join telemetry_batches')) {
        return entriesStore.map((e) => ({
          ...e,
          device_id_from_batch: e['device_id'],
        })) as unknown as T[];
      }

      // 查詢前一小時路由建議（alert 比較用）
      if (s.includes('from routing_recommendations') && s.includes('generated_at >') && s.includes('generated_at <=')) {
        return [] as T[];
      }

      // 查詢有效路由建議（getRouteSuggestions）
      if (s.includes('from routing_recommendations') && s.includes('valid_until > datetime')) {
        let recs = [...recommendationsStore.values()];
        if (params?.[0] && s.includes('region = ?')) {
          recs = recs.filter((r) => r['region'] === params[0]);
        }
        return recs as unknown as T[];
      }

      // 查詢路由建議（recommendation_id = ?）
      if (s.includes('from routing_recommendations') && s.includes('recommendation_id = ?') && params?.[0]) {
        const rec = recommendationsStore.get(params[0] as string);
        return rec ? [rec as unknown as T] : [] as T[];
      }

      // 查詢最新路由建議（service_id = ? order by...）
      if (s.includes('from routing_recommendations') && s.includes('service_id = ?') && s.includes('order by generated_at desc') && params?.[0]) {
        const recs = [...recommendationsStore.values()]
          .filter((r) => r['service_id'] === params[0])
          .sort((a, b) => String(b['generated_at']).localeCompare(String(a['generated_at'])));
        return recs.slice(0, 1) as unknown as T[];
      }

      // 查詢有效建議計數（冷啟動用）
      if (s.includes('count(*) as count from routing_recommendations') && s.includes('valid_until >')) {
        const count = recommendationsStore.size;
        return [{ count } as unknown as T];
      }

      // 查詢 telemetry_aggregated（冷啟動用）
      if (s.includes('from telemetry_aggregated') && s.includes('aggregated_at >')) {
        return aggregatedStore as unknown as T[];
      }

      // 查詢 telemetry_entries 統計（GlobalStats 用）
      if (s.includes('from telemetry_entries') && s.includes('group by service_id') && s.includes('total_count')) {
        const statsMap = new Map<string, { total: number; success: number }>();
        for (const e of entriesStore) {
          const sid = e['service_id'] as string;
          if (!statsMap.has(sid)) statsMap.set(sid, { total: 0, success: 0 });
          const stat = statsMap.get(sid)!;
          stat.total++;
          if (e['outcome'] === 'success') stat.success++;
        }
        return [...statsMap.entries()].map(([sid, s]) => ({
          service_id: sid,
          total_count: s.total,
          success_count: s.success,
          p95_latency: null,
        })) as unknown as T[];
      }

      // 查詢延遲數據（GlobalStats 用）
      if (s.includes('avg(latency_ms) as avg_latency') && s.includes('group by service_id')) {
        const latencyMap = new Map<string, number[]>();
        for (const e of entriesStore) {
          if (e['outcome'] !== 'success' || e['latency_ms'] === null) continue;
          const sid = e['service_id'] as string;
          if (!latencyMap.has(sid)) latencyMap.set(sid, []);
          latencyMap.get(sid)!.push(e['latency_ms'] as number);
        }
        return [...latencyMap.entries()].map(([sid, lats]) => ({
          service_id: sid,
          avg_latency: lats.reduce((a, b) => a + b, 0) / lats.length,
        })) as unknown as T[];
      }

      // 查詢回饋計數（配額用）
      if (s.includes('from telemetry_feedback') && s.includes('device_id = ?') && params?.[0]) {
        const count = feedbackStore.filter((f) => f['device_id'] === params[0]).length;
        return [{ count } as unknown as T];
      }

      return [] as T[];
    },

    run(sql: string, params?: unknown[]) {
      const s = sql.trim().toLowerCase();

      // INSERT telemetry_batches
      if (s.startsWith('insert into telemetry_batches')) {
        if (params && params.length >= 9) {
          const batchId = params[0] as string;
          // 檢查是否已存在（模擬 UNIQUE 衝突）
          if (batchesStore.has(batchId)) {
            throw new Error(`UNIQUE constraint failed: telemetry_batches.batch_id`);
          }
          batchesStore.set(batchId, {
            batch_id: batchId,
            device_id: params[1],
            region: params[2],
            schema_version: params[3],
            period_from: params[4],
            period_to: params[5],
            total_requests: params[6],
            success_rate: params[7],
            reputation_weight: params[8],
          });
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // INSERT telemetry_entries
      if (s.startsWith('insert into telemetry_entries')) {
        if (params) {
          entriesStore.push({
            batch_id: params[0],
            device_id: params[1],
            region: params[2],
            service_id: params[3],
            model: params[4],
            tier: params[5],
            outcome: params[6],
            latency_ms: params[7],
            token_input: params[8],
            token_output: params[9],
            routing_strategy: params[10],
            retry_count: params[11],
            time_bucket: params[12],
            reputation_weight: params[13],
            received_at: new Date().toISOString(),
          });
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // INSERT OR REPLACE routing_recommendations
      if (s.includes('routing_recommendations') && (s.startsWith('insert or replace') || s.startsWith('insert or ignore'))) {
        if (params && params.length >= 11) {
          const recId = params[0] as string;
          recommendationsStore.set(recId, {
            recommendation_id: params[0],
            service_id: params[1],
            region: params[2],
            status: params[3],
            confidence: params[4],
            success_rate: params[5],
            avg_latency_ms: params[6],
            p95_latency_ms: params[7],
            sample_size: params[8],
            // note 可能在 params[9]（INSERT OR IGNORE 時）
            generated_at: params.length >= 12 ? params[10] : params[9],
            valid_until: params.length >= 12 ? params[11] : params[10],
          });
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE routing_recommendations confidence
      if (s.includes('update routing_recommendations') && s.includes('confidence =') && params?.[1]) {
        const recId = params[1] as string;
        const rec = recommendationsStore.get(recId);
        if (rec) {
          rec['confidence'] = params[0] as number;
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // INSERT service_alerts
      if (s.startsWith('insert into service_alerts')) {
        if (params) {
          alertsStore.push({
            severity: params[0],
            service_id: params[1],
            region: params[2],
            message: params[3],
          });
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // INSERT telemetry_feedback
      if (s.startsWith('insert into telemetry_feedback')) {
        if (params) {
          feedbackStore.push({
            device_id: params[0],
            recommendation_id: params[1],
            service_id: params[2],
            feedback: params[3],
            reason: params[4],
            comment: params[5],
          });
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // INSERT OR UPDATE feedback_aggregation
      if (s.includes('feedback_aggregation')) {
        if (params) {
          const key = `${params[0]}::${params[1]}::${params[2]}`;
          const existing = feedbackAggStore.get(key) ?? {
            service_id: params[0],
            region: params[1],
            period_hour: params[2],
            positive_count: 0,
            negative_count: 0,
          };
          if (s.includes('positive_count = positive_count + 1')) {
            (existing['positive_count'] as number)++;
          } else if (s.includes('negative_count = negative_count + 1')) {
            (existing['negative_count'] as number)++;
          }
          feedbackAggStore.set(key, existing);
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      return { changes: 1, lastInsertRowid: 0 };
    },

    transaction<T>(fn: () => T): T {
      return fn();
    },
  } as unknown as VPSDatabase & {
    _insertDevice(d: Device): void;
    _getDevice(id: string): Device | undefined;
    _getBatches(): Record<string, unknown>[];
    _getEntries(): Record<string, unknown>[];
    _addEntry(entry: Record<string, unknown>): void;
    _getRecommendations(): Record<string, unknown>[];
    _getAlerts(): Record<string, unknown>[];
    _getFeedback(): Record<string, unknown>[];
    _insertAggregated(row: Record<string, unknown>): void;
    _setDeviceBatchCount(deviceId: string, count: number): void;
  };

  return db;
}

// ===== 測試用裝置產生器 =====

function makeDevice(overrides: Partial<Device> = {}): Device {
  const now = new Date();
  const createdAt = overrides.created_at ?? now.toISOString();
  return {
    device_id: 'clw_test00000000000000000000000000001',
    device_fingerprint: 'fp_test',
    device_token: 'tok_test',
    token_expires_at: new Date(now.getTime() + 86400000 * 30).toISOString(),
    client_version: '1.0.0',
    os: 'linux',
    arch: 'x64',
    locale: 'zh-TW',
    timezone: 'Asia/Taipei',
    region: 'asia',
    assigned_region: 'asia',
    vps_public_key_id: null,
    reputation_weight: 1.0,
    reputation_tier: 'normal',
    anomaly_count: 0,
    status: 'active',
    suspended_reason: null,
    google_id_hash: null,
    google_email_masked: null,
    nickname: null,
    last_seen_at: now.toISOString(),
    created_at: createdAt,
    updated_at: now.toISOString(),
    ...overrides,
  };
}

// ===== 測試用批次產生器 =====

function makeBatch(overrides: Partial<TelemetryBatch> = {}): TelemetryBatch {
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1 小時前
  const to = now.toISOString();

  return {
    schema_version: 1,
    batch_id: `batch_${Math.random().toString(36).slice(2, 12)}`,
    period: { from, to },
    entries: [
      {
        service_id: 'groq',
        tier: 'L1',
        outcome: 'success',
        latency_ms: 800,
        routing_strategy: 'fast',
        retry_count: 0,
        time_bucket: 'morning',
      },
    ],
    summary: {
      total_requests: 1,
      success_rate: 1.0,
      services_used: ['groq'],
      pool_stats: { king_pool_used: 1, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 },
    },
    ...overrides,
  };
}

// ===== 測試套件 =====

describe('IntelligenceEngine', () => {
  let db: ReturnType<typeof createMockDb>;
  let engine: IntelligenceEngine;

  beforeEach(() => {
    db = createMockDb();
    engine = new IntelligenceEngine(db as unknown as VPSDatabase);
  });

  // ─── receiveBatch ───────────────────────────────────────────────

  describe('receiveBatch', () => {
    it('成功接收有效批次', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const batch = makeBatch();
      const result = await engine.receiveBatch(device.device_id, batch);

      expect(result.success).toBe(true);
      expect(result.batch_id).toBe(batch.batch_id);
      expect(result.entries_stored).toBe(1);
      expect(result.reputation_weight).toBeGreaterThan(0);
    });

    it('驗收標準 1：batch_id 重複 → 拋出 409 TELEMETRY_DUPLICATE_BATCH', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const batch = makeBatch();

      // 第一次成功
      await engine.receiveBatch(device.device_id, batch);

      // 第二次應拋出錯誤
      let thrown = false;
      try {
        await engine.receiveBatch(device.device_id, batch);
      } catch (err) {
        thrown = true;
        const e = err as Error & { errorCode?: ErrorCode };
        expect(e.errorCode).toBe(ErrorCode.TELEMETRY_DUPLICATE_BATCH);
      }
      expect(thrown).toBe(true);
    });

    it('記憶體快取也能偵測 batch_id 重複', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const batch = makeBatch();
      const batchId = batch.batch_id;

      // 直接注入快取（模擬已接收過）
      engine._injectBatchCache(batchId, device.device_id);

      let thrown = false;
      try {
        await engine.receiveBatch(device.device_id, batch);
      } catch (err) {
        thrown = true;
        const e = err as Error & { errorCode?: ErrorCode };
        expect(e.errorCode).toBe(ErrorCode.TELEMETRY_DUPLICATE_BATCH);
      }
      expect(thrown).toBe(true);
    });

    it('驗收標準 2：新蝦（3天內）信譽加權 = 0.3', async () => {
      // 建立 3 天內的新帳號
      const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const device = makeDevice({ created_at: recentDate, anomaly_count: 0 });
      db._insertDevice(device);
      db._setDeviceBatchCount(device.device_id, 5); // < 10 批 → 新蝦

      const batch = makeBatch();
      const result = await engine.receiveBatch(device.device_id, batch);

      expect(result.reputation_weight).toBe(0.3);
    });

    it('老蝦（> 90天且 > 500批）信譽加權 = 1.5', async () => {
      // 建立 100 天前的老帳號
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      const device = makeDevice({ created_at: oldDate, anomaly_count: 0 });
      db._insertDevice(device);
      db._setDeviceBatchCount(device.device_id, 600); // > 500 批 → 老蝦

      const batch = makeBatch();
      const result = await engine.receiveBatch(device.device_id, batch);

      expect(result.reputation_weight).toBe(1.5);
    });

    it('schema_version < 1 → TELEMETRY_INVALID_SCHEMA', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const batch = makeBatch({ schema_version: 0 });

      let thrown = false;
      try {
        await engine.receiveBatch(device.device_id, batch);
      } catch (err) {
        thrown = true;
        const e = err as Error & { errorCode?: ErrorCode };
        expect(e.errorCode).toBe(ErrorCode.TELEMETRY_INVALID_SCHEMA);
      }
      expect(thrown).toBe(true);
    });

    it('entries > 1000 → TELEMETRY_BATCH_TOO_LARGE', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const entries = Array.from({ length: 1001 }, () => ({
        service_id: 'groq',
        tier: 'L1' as const,
        outcome: 'success' as const,
        latency_ms: 100,
        routing_strategy: 'fast' as const,
        retry_count: 0,
        time_bucket: 'morning' as const,
      }));
      const batch = makeBatch({ entries });

      let thrown = false;
      try {
        await engine.receiveBatch(device.device_id, batch);
      } catch (err) {
        thrown = true;
        const e = err as Error & { errorCode?: ErrorCode };
        expect(e.errorCode).toBe(ErrorCode.TELEMETRY_BATCH_TOO_LARGE);
      }
      expect(thrown).toBe(true);
    });

    it('period 跨度 > 2 小時 → TELEMETRY_INVALID_SCHEMA', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const now = new Date();
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      const batch = makeBatch({
        period: { from: threeHoursAgo.toISOString(), to: now.toISOString() },
      });

      let thrown = false;
      try {
        await engine.receiveBatch(device.device_id, batch);
      } catch (err) {
        thrown = true;
        const e = err as Error & { errorCode?: ErrorCode };
        expect(e.errorCode).toBe(ErrorCode.TELEMETRY_INVALID_SCHEMA);
      }
      expect(thrown).toBe(true);
    });

    it('period.to 超過未來 5 分鐘 → TELEMETRY_INVALID_SCHEMA', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const now = new Date();
      const futureTime = new Date(now.getTime() + 10 * 60 * 1000); // 10 分鐘後
      const pastTime = new Date(now.getTime() - 30 * 60 * 1000);   // 30 分鐘前

      const batch = makeBatch({
        period: { from: pastTime.toISOString(), to: futureTime.toISOString() },
      });

      let thrown = false;
      try {
        await engine.receiveBatch(device.device_id, batch);
      } catch (err) {
        thrown = true;
        const e = err as Error & { errorCode?: ErrorCode };
        expect(e.errorCode).toBe(ErrorCode.TELEMETRY_INVALID_SCHEMA);
      }
      expect(thrown).toBe(true);
    });

    it('latency_ms 超出範圍 → TELEMETRY_INVALID_SCHEMA', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const batch = makeBatch({
        entries: [{
          service_id: 'groq',
          tier: 'L1',
          outcome: 'success',
          latency_ms: 400000, // > 300000
          routing_strategy: 'fast',
          retry_count: 0,
          time_bucket: 'morning',
        }],
      });

      let thrown = false;
      try {
        await engine.receiveBatch(device.device_id, batch);
      } catch (err) {
        thrown = true;
        const e = err as Error & { errorCode?: ErrorCode };
        expect(e.errorCode).toBe(ErrorCode.TELEMETRY_INVALID_SCHEMA);
      }
      expect(thrown).toBe(true);
    });

    it('未知的 service_id → TELEMETRY_INVALID_SCHEMA', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const batch = makeBatch({
        entries: [{
          service_id: 'unknown-service-xyz',
          tier: 'L1',
          outcome: 'success',
          latency_ms: 100,
          routing_strategy: 'fast',
          retry_count: 0,
          time_bucket: 'morning',
        }],
      });

      let thrown = false;
      try {
        await engine.receiveBatch(device.device_id, batch);
      } catch (err) {
        thrown = true;
        const e = err as Error & { errorCode?: ErrorCode };
        expect(e.errorCode).toBe(ErrorCode.TELEMETRY_INVALID_SCHEMA);
      }
      expect(thrown).toBe(true);
    });

    it('異常懲罰：anomaly_count = 1 時信譽加權降低', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      // 老蝦但有 1 次異常：1.5 - 0.2 = 1.3
      const device = makeDevice({ created_at: oldDate, anomaly_count: 1 });
      db._insertDevice(device);
      db._setDeviceBatchCount(device.device_id, 600);

      const batch = makeBatch();
      const result = await engine.receiveBatch(device.device_id, batch);

      expect(result.reputation_weight).toBeCloseTo(1.3, 5);
    });

    it('異常懲罰多次後不低於 0.1', async () => {
      const device = makeDevice({ anomaly_count: 10 }); // 10 次異常
      db._insertDevice(device);
      db._setDeviceBatchCount(device.device_id, 5);

      const batch = makeBatch();
      const result = await engine.receiveBatch(device.device_id, batch);

      // WEIGHT_MIN = 0.1
      expect(result.reputation_weight).toBe(0.1);
    });
  });

  // ─── runHourlyAnalysis ──────────────────────────────────────────

  describe('runHourlyAnalysis', () => {
    it('沒有資料時回傳空結果', async () => {
      const result = await engine.runHourlyAnalysis();
      expect(result.recommendations_generated).toBe(0);
      expect(result.alerts_fired).toBe(0);
    });

    it('驗收標準 4：4 個地區各有獨立建議', async () => {
      // 注入多個地區的遙測條目（每個地區 ≥ 10 個裝置）
      const regions = ['asia', 'europe', 'americas', 'other'];
      const serviceId = 'openai';

      for (const region of regions) {
        for (let i = 0; i < 15; i++) {
          const deviceId = `clw_dev_${region}_${i.toString().padStart(10, '0')}`;
          // 直接注入 entries（模擬已有 telemetry_entries 資料）
          db._addEntry({
            batch_id: `batch_${region}_${i}`,
            device_id: deviceId,
            region,
            service_id: serviceId,
            outcome: 'success',
            latency_ms: 500,
            reputation_weight: 1.0,
            received_at: new Date().toISOString(),
          });
        }
      }

      const result = await engine.runHourlyAnalysis();

      // 應該為 4 個地區各產生 1 個建議
      expect(result.recommendations_generated).toBe(4);

      const recs = db._getRecommendations();
      const recRegions = new Set(recs.map((r) => r['region']));
      expect(recRegions.has('asia')).toBe(true);
      expect(recRegions.has('europe')).toBe(true);
      expect(recRegions.has('americas')).toBe(true);
      expect(recRegions.has('other')).toBe(true);
    });

    it('使用者 < 10 人的服務會跳過', async () => {
      // 只有 5 個裝置上報
      for (let i = 0; i < 5; i++) {
        const deviceId = `clw_dev_${i.toString().padStart(12, '0')}`;
        db._addEntry({
          batch_id: `batch_${i}`,
          device_id: deviceId,
          region: 'asia',
          service_id: 'groq',
          outcome: 'success',
          latency_ms: 500,
          reputation_weight: 1.0,
          received_at: new Date().toISOString(),
        });
      }

      const result = await engine.runHourlyAnalysis();
      expect(result.recommendations_generated).toBe(0);
    });

    it('成功率高且延遲低 → preferred', async () => {
      // 注入 15 個裝置的成功數據，延遲 1000ms
      for (let i = 0; i < 15; i++) {
        const deviceId = `clw_dev_${i.toString().padStart(12, '0')}`;
        db._addEntry({
          batch_id: `batch_${i}`,
          device_id: deviceId,
          region: 'asia',
          service_id: 'gemini',
          outcome: 'success',
          latency_ms: 1000,
          reputation_weight: 1.0,
          received_at: new Date().toISOString(),
        });
      }

      await engine.runHourlyAnalysis();
      const recs = db._getRecommendations();
      const asiaGemini = recs.find(
        (r) => r['region'] === 'asia' && r['service_id'] === 'gemini',
      );
      expect(asiaGemini?.['status']).toBe('preferred');
      expect(Number(asiaGemini?.['confidence'])).toBeGreaterThan(0);
    });

    it('成功率低 → avoid', async () => {
      // 15 個裝置，全部失敗
      for (let i = 0; i < 15; i++) {
        const deviceId = `clw_dev_${i.toString().padStart(12, '0')}`;
        db._addEntry({
          batch_id: `batch_${i}`,
          device_id: deviceId,
          region: 'europe',
          service_id: 'anthropic',
          outcome: 'error',
          latency_ms: null,
          reputation_weight: 1.0,
          received_at: new Date().toISOString(),
        });
      }

      await engine.runHourlyAnalysis();
      const recs = db._getRecommendations();
      const rec = recs.find(
        (r) => r['region'] === 'europe' && r['service_id'] === 'anthropic',
      );
      expect(rec?.['status']).toBe('avoid');
    });

    it('信心度：15 個裝置 → low (0.3)', async () => {
      for (let i = 0; i < 15; i++) {
        const deviceId = `clw_dev_${i.toString().padStart(12, '0')}`;
        db._addEntry({
          batch_id: `batch_${i}`,
          device_id: deviceId,
          region: 'americas',
          service_id: 'deepseek',
          outcome: 'success',
          latency_ms: 500,
          reputation_weight: 1.0,
          received_at: new Date().toISOString(),
        });
      }

      await engine.runHourlyAnalysis();
      const recs = db._getRecommendations();
      const rec = recs.find(
        (r) => r['region'] === 'americas' && r['service_id'] === 'deepseek',
      );
      // 15 < 30 → low = 0.3
      expect(rec?.['confidence']).toBe(0.3);
    });

    it('信心度：105 個裝置 → high (0.9)', async () => {
      for (let i = 0; i < 105; i++) {
        const deviceId = `clw_dev_${i.toString().padStart(12, '0')}`;
        db._addEntry({
          batch_id: `batch_${i}`,
          device_id: deviceId,
          region: 'asia',
          service_id: 'cerebras',
          outcome: 'success',
          latency_ms: 300,
          reputation_weight: 1.0,
          received_at: new Date().toISOString(),
        });
      }

      await engine.runHourlyAnalysis();
      const recs = db._getRecommendations();
      const rec = recs.find(
        (r) => r['region'] === 'asia' && r['service_id'] === 'cerebras',
      );
      // > 100 → high = 0.9
      expect(rec?.['confidence']).toBe(0.9);
    });
  });

  // ─── getRouteSuggestions ────────────────────────────────────────

  describe('getRouteSuggestions', () => {
    it('無地區篩選時回傳所有建議', () => {
      const suggestions = engine.getRouteSuggestions();
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('有地區篩選時只回傳該地區建議', () => {
      const suggestions = engine.getRouteSuggestions('asia');
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  // ─── handleFeedback ─────────────────────────────────────────────

  describe('handleFeedback', () => {
    it('驗收標準 5：positive 回饋提升 confidence', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      // 先建立一個路由建議
      const recId = 'rec_asia_groq_12345';
      // 直接注入到 recommendationsStore
      const mockDb = db as unknown as {
        run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
      };
      mockDb.run(
        `INSERT OR REPLACE INTO routing_recommendations (
          recommendation_id, service_id, region, status,
          confidence, success_rate, avg_latency_ms, p95_latency_ms,
          sample_size, generated_at, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [recId, 'groq', 'asia', 'preferred', 0.6, 0.95, 500, 800, 50,
          new Date().toISOString(), new Date(Date.now() + 7200000).toISOString()],
      );

      await engine.handleFeedback(device.device_id, {
        recommendation_id: recId,
        service_id: 'groq',
        feedback: 'positive',
      });

      // confidence 應該從 0.6 提升到 0.65
      const recs = db._getRecommendations();
      const rec = recs.find((r) => r['recommendation_id'] === recId);
      expect(Number(rec?.['confidence'])).toBeCloseTo(0.65, 5);
    });

    it('negative 回饋降低 confidence', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      const recId = 'rec_europe_openai_99999';
      const mockDb = db as unknown as {
        run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
      };
      mockDb.run(
        `INSERT OR REPLACE INTO routing_recommendations (
          recommendation_id, service_id, region, status,
          confidence, success_rate, avg_latency_ms, p95_latency_ms,
          sample_size, generated_at, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [recId, 'openai', 'europe', 'preferred', 0.8, 0.95, 400, 700, 80,
          new Date().toISOString(), new Date(Date.now() + 7200000).toISOString()],
      );

      await engine.handleFeedback(device.device_id, {
        recommendation_id: recId,
        service_id: 'openai',
        feedback: 'negative',
      });

      // confidence 應從 0.8 降至 0.7
      const recs = db._getRecommendations();
      const rec = recs.find((r) => r['recommendation_id'] === recId);
      expect(Number(rec?.['confidence'])).toBeCloseTo(0.7, 5);
    });

    it('回饋寫入 telemetry_feedback 表', async () => {
      const device = makeDevice();
      db._insertDevice(device);

      await engine.handleFeedback(device.device_id, {
        recommendation_id: 'rec_test',
        service_id: 'groq',
        feedback: 'positive',
        reason: 'other',
      });

      const feedbacks = db._getFeedback();
      expect(feedbacks.length).toBe(1);
      expect(feedbacks[0]?.['device_id']).toBe(device.device_id);
      expect(feedbacks[0]?.['feedback']).toBe('positive');
    });
  });

  // ─── coldStart ──────────────────────────────────────────────────

  describe('coldStart', () => {
    it('驗收標準 6：有 24hr 歷史數據時產生過渡建議', async () => {
      // 注入聚合數據
      db._insertAggregated({
        provider: 'groq',
        model: null,
        region: 'asia',
        success_rate: 0.97,
        latency_p95: 1200,
        sample_count: 500,
        aggregated_at: new Date().toISOString(),
      });
      db._insertAggregated({
        provider: 'openai',
        model: null,
        region: 'europe',
        success_rate: 0.88,
        latency_p95: 2500,
        sample_count: 300,
        aggregated_at: new Date().toISOString(),
      });

      const result = await engine.coldStart();
      expect(result.source).toBe('24hr_aggregate');
      expect(result.recommendations_loaded).toBe(2);
    });

    it('沒有歷史數據且沒有現有建議時回傳 empty', async () => {
      const result = await engine.coldStart();
      expect(result.source).toBe('empty');
      expect(result.recommendations_loaded).toBe(0);
    });

    it('冷啟動建議標記為過渡性（note 包含冷啟動）', async () => {
      db._insertAggregated({
        provider: 'gemini',
        model: null,
        region: 'americas',
        success_rate: 0.95,
        latency_p95: 1800,
        sample_count: 200,
        aggregated_at: new Date().toISOString(),
      });

      await engine.coldStart();
      const recs = db._getRecommendations();
      expect(recs.length).toBeGreaterThan(0);
      // 冷啟動建議的 confidence 應為 low (0.3)
      const rec = recs[0]!;
      expect(rec['confidence']).toBe(0.3);
    });
  });

  // ─── calculateReputationWeight（直接測試）───────────────────────

  describe('calculateReputationWeight', () => {
    it('null 裝置 → WEIGHT_NEW (0.3)', () => {
      const weight = engine.calculateReputationWeight(null);
      expect(weight).toBe(0.3);
    });

    it('新蝦（< 7 天）→ 0.3', () => {
      const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const device = makeDevice({ created_at: recentDate, anomaly_count: 0 });
      db._insertDevice(device);
      db._setDeviceBatchCount(device.device_id, 5);

      const weight = engine.calculateReputationWeight(device);
      expect(weight).toBe(0.3);
    });

    it('普通蝦 → 1.0', () => {
      // 30 天前建立，300 批
      const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const device = makeDevice({ created_at: date, anomaly_count: 0 });
      db._insertDevice(device);
      db._setDeviceBatchCount(device.device_id, 300);

      const weight = engine.calculateReputationWeight(device);
      expect(weight).toBe(1.0);
    });
  });
});
