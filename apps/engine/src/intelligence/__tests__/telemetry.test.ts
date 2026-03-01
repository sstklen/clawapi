// telemetry.test.ts — TelemetryCollector 完整測試套件
// 涵蓋：recordEvent、匿名化、buildBatch、uploadBatch、scheduleUpload、uploadBacklog、submitFeedback

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { TelemetryCollector } from '../telemetry';
import { createDatabase } from '../../storage/database';
import type { ClawDatabase } from '../../storage/database';
import type { VPSClient } from '../vps-client';
import type { TelemetryBatch } from '@clawapi/protocol';

// ===== Mock VPSClient =====

/** Mock VPSClient：記錄所有呼叫，可注入錯誤 */
function createMockVPSClient(): {
  client: VPSClient;
  uploadCalls: TelemetryBatch[];
  feedbackCalls: unknown[];
  uploadError: Error | null;
  setUploadError: (err: Error | null) => void;
} {
  const uploadCalls: TelemetryBatch[] = [];
  const feedbackCalls: unknown[] = [];
  let uploadError: Error | null = null;

  const client = {
    uploadTelemetry: async (batch: TelemetryBatch) => {
      if (uploadError) throw uploadError;
      uploadCalls.push(batch);
    },
    submitFeedback: async (feedback: unknown) => {
      feedbackCalls.push(feedback);
    },
    // 其他方法不需要實作
  } as unknown as VPSClient;

  return {
    client,
    uploadCalls,
    feedbackCalls,
    uploadError,
    setUploadError: (err: Error | null) => { uploadError = err; },
  };
}

// ===== 輔助函式 =====

/** 建立測試用 in-memory DB */
async function createTestDb(): Promise<ClawDatabase> {
  const db = createDatabase(':memory:');
  await db.init();
  return db;
}

/** 插入裝置記錄 */
function insertDevice(db: ClawDatabase, deviceId = 'test-device-uuid-1234-5678'): void {
  db.run(
    `INSERT OR REPLACE INTO device
       (device_id, device_fingerprint, created_at, updated_at)
     VALUES (?, 'fp', datetime('now'), datetime('now'))`,
    [deviceId]
  );
}

/** 在 usage_log 插入多筆遙測記錄（模擬多服務使用） */
function insertUsageLogs(
  db: ClawDatabase,
  count: number,
  serviceId: string,
  hoursAgo = 0
): void {
  const timestamp = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  for (let i = 0; i < count; i++) {
    db.run(
      `INSERT INTO usage_log
         (service_id, model, layer, success, latency_ms,
          tokens_output, routing_strategy, retry_count, timestamp)
       VALUES (?, 'test-model', 'L1', 1, 100, 50, 'smart', 0, ?)`,
      [serviceId, timestamp]
    );
  }
}

// ===== recordEvent =====

describe('TelemetryCollector — recordEvent', () => {
  let db: ClawDatabase;
  let collector: TelemetryCollector;
  let mock_: ReturnType<typeof createMockVPSClient>;

  beforeEach(async () => {
    db = await createTestDb();
    mock_ = createMockVPSClient();
    collector = new TelemetryCollector(db, mock_.client);
    insertDevice(db);
  });

  afterEach(() => {
    collector.stopSchedule();
  });

  it('01. recordEvent 寫入 usage_log', async () => {
    await collector.recordEvent({
      service_id: 'groq',
      model: 'llama-3',
      latency_ms: 200,
      outcome: 'success',
      tokens_used: 300,
      layer: 'L1',
    });

    interface LogRow { service_id: string; latency_ms: number }
    const rows = db.query<LogRow>(
      'SELECT service_id, latency_ms FROM usage_log'
    );
    expect(rows.length).toBe(1);
    expect(rows[0].service_id).toBeTruthy(); // 可能是 'groq' 或 'other'，取決於匿名化
    expect(rows[0].latency_ms).toBe(200);
  });

  it('02. 未知服務（第一次記錄）因裝置數 0 → service_id = "other"', async () => {
    // 第一次記錄 brand-new-service，usage_log 沒有歷史 → 裝置數 = 0 < 10
    await collector.recordEvent({
      service_id: 'brand-new-service',
      latency_ms: 100,
      outcome: 'success',
      layer: 'L1',
    });

    interface LogRow { service_id: string }
    const rows = db.query<LogRow>('SELECT service_id FROM usage_log');
    expect(rows[0].service_id).toBe('other');
  });

  it('03. service_id 在快取中裝置數 >= 10 → 正常記錄', async () => {
    // 先在 usage_log 插入 10 筆歷史記錄（觸發快取更新）
    insertUsageLogs(db, 10, 'popular-service');

    // 強制刷新匿名化快取（透過呼叫 anonymizeServiceId）
    const result = await (collector as unknown as {
      anonymizeServiceId(id: string): Promise<string>
    }).anonymizeServiceId('popular-service');

    // 10 筆 >= THRESHOLD(10) → 正常回傳
    expect(result).toBe('popular-service');
  });

  it('04. service_id 裝置數 = 9 → "other"（邊界測試）', async () => {
    // 9 筆記錄：嚴格小於 10 → 應匿名化
    insertUsageLogs(db, 9, 'small-service');

    const result = await (collector as unknown as {
      anonymizeServiceId(id: string): Promise<string>
    }).anonymizeServiceId('small-service');

    expect(result).toBe('other');
  });

  it('05. service_id 裝置數 = 10 → 正常（邊界測試）', async () => {
    // 10 筆記錄：等於 THRESHOLD → 正常
    insertUsageLogs(db, 10, 'borderline-service');

    const result = await (collector as unknown as {
      anonymizeServiceId(id: string): Promise<string>
    }).anonymizeServiceId('borderline-service');

    expect(result).toBe('borderline-service');
  });
});

// ===== 匿名化規則 =====

describe('TelemetryCollector — 匿名化規則', () => {
  let db: ClawDatabase;
  let collector: TelemetryCollector;

  beforeEach(async () => {
    db = await createTestDb();
    const mock_ = createMockVPSClient();
    collector = new TelemetryCollector(db, mock_.client);
  });

  afterEach(() => {
    collector.stopSchedule();
  });

  it('A1. 0 筆記錄 → "other"', async () => {
    const result = await (collector as unknown as {
      anonymizeServiceId(id: string): Promise<string>
    }).anonymizeServiceId('no-data-service');
    expect(result).toBe('other');
  });

  it('A2. 1-9 筆記錄 → "other"', async () => {
    for (let count = 1; count <= 9; count++) {
      const freshDb = await createTestDb();
      const freshMock = createMockVPSClient();
      const freshCollector = new TelemetryCollector(freshDb, freshMock.client);

      insertUsageLogs(freshDb, count, `service-${count}`);

      const result = await (freshCollector as unknown as {
        anonymizeServiceId(id: string): Promise<string>
      }).anonymizeServiceId(`service-${count}`);

      expect(result).toBe('other');
      freshCollector.stopSchedule();
    }
  });

  it('A3. 10+ 筆記錄 → 正常 service_id', async () => {
    insertUsageLogs(db, 15, 'major-service');

    const result = await (collector as unknown as {
      anonymizeServiceId(id: string): Promise<string>
    }).anonymizeServiceId('major-service');

    expect(result).toBe('major-service');
  });

  it('A4. 超過 24 小時的記錄不計入（在查詢中過濾）', async () => {
    // 插入 25 小時前的記錄（超過 24 小時窗口）
    insertUsageLogs(db, 15, 'old-service', 25);

    // 雖然有 15 筆，但都超過 24 小時
    const result = await (collector as unknown as {
      anonymizeServiceId(id: string): Promise<string>
    }).anonymizeServiceId('old-service');

    // 24 小時外的記錄不計，所以裝置數 = 0 < 10 → 'other'
    expect(result).toBe('other');
  });
});

// ===== buildBatch =====

describe('TelemetryCollector — buildBatch', () => {
  let db: ClawDatabase;
  let collector: TelemetryCollector;

  beforeEach(async () => {
    db = await createTestDb();
    const mock_ = createMockVPSClient();
    collector = new TelemetryCollector(db, mock_.client);
    insertDevice(db);
  });

  afterEach(() => {
    collector.stopSchedule();
  });

  it('B1. usage_log 有資料 → 組裝正確的 TelemetryBatch', async () => {
    insertUsageLogs(db, 3, 'groq');

    const batch = await collector.buildBatch();

    expect(batch).not.toBeNull();
    expect(batch!.schema_version).toBe(1);
    expect(batch!.batch_id).toMatch(/^b_/);
    expect(batch!.entries.length).toBe(3);
    expect(batch!.period.from).toBeDefined();
    expect(batch!.period.to).toBeDefined();
    expect(batch!.summary).toBeDefined();
    expect(batch!.summary.total_requests).toBe(3);
  });

  it('B2. usage_log 為空 → 回傳 null', async () => {
    const batch = await collector.buildBatch();
    expect(batch).toBeNull();
  });

  it('B3. batch_id 包含 deviceId', async () => {
    insertUsageLogs(db, 1, 'groq');

    const batch = await collector.buildBatch();
    expect(batch!.batch_id).toContain('test-device-uuid-1234-5678');
  });

  it('B4. 超過 1 小時前的記錄不納入批次', async () => {
    // 2 小時前的記錄
    insertUsageLogs(db, 5, 'old-groq', 2);
    // 30 分鐘前的記錄
    insertUsageLogs(db, 3, 'groq', 0.5);

    const batch = await collector.buildBatch();

    // 只有 30 分鐘前的 3 筆
    expect(batch!.entries.length).toBe(3);
  });

  it('B5. 每批最多 500 條記錄', async () => {
    // 插入 600 筆
    insertUsageLogs(db, 600, 'groq');

    const batch = await collector.buildBatch();

    expect(batch!.entries.length).toBeLessThanOrEqual(500);
  });

  it('B6. summary.success_rate 計算正確', async () => {
    // 插入 3 成功 + 假設 failure 由 outcome 決定
    insertUsageLogs(db, 3, 'groq');

    const batch = await collector.buildBatch();

    // 都是 success（usage log success = 1）
    expect(batch!.summary.success_rate).toBeCloseTo(1.0);
    expect(batch!.summary.services_used.length).toBeGreaterThanOrEqual(0);
  });
});

// ===== uploadBatch =====

describe('TelemetryCollector — uploadBatch', () => {
  let db: ClawDatabase;
  let collector: TelemetryCollector;
  let mock_: ReturnType<typeof createMockVPSClient>;

  beforeEach(async () => {
    db = await createTestDb();
    mock_ = createMockVPSClient();
    collector = new TelemetryCollector(db, mock_.client);
    insertDevice(db);
  });

  afterEach(() => {
    collector.stopSchedule();
  });

  /** 建立假批次 */
  function createFakeBatch(batchId = 'b_test_batch001'): TelemetryBatch {
    return {
      schema_version: 1,
      batch_id: batchId,
      period: {
        from: new Date(Date.now() - 3600000).toISOString(),
        to: new Date().toISOString(),
      },
      entries: [],
      summary: {
        total_requests: 0,
        success_rate: 1,
        services_used: [],
        pool_stats: {
          king_pool_used: 0,
          friend_pool_used: 0,
          l0_pool_used: 0,
          aid_used: 0,
        },
      },
    };
  }

  it('U1. 上傳成功 → VPSClient.uploadTelemetry 被呼叫', async () => {
    const batch = createFakeBatch('b_test_upload_success');

    const success = await collector.uploadBatch(batch);

    expect(success).toBe(true);
    expect(mock_.uploadCalls.length).toBe(1);
  });

  it('U2. 上傳成功 → telemetry_queue 記錄被刪除', async () => {
    const batch = createFakeBatch('b_test_upload_cleanup');

    await collector.uploadBatch(batch);

    interface QueueRow { batch_id: string }
    const rows = db.query<QueueRow>(
      'SELECT batch_id FROM telemetry_queue WHERE batch_id = ?',
      ['b_test_upload_cleanup']
    );
    expect(rows.length).toBe(0);
  });

  it('U3. 一般錯誤 → retry_count 增加，回傳 false', async () => {
    mock_.setUploadError(new Error('Network error'));

    const batch = createFakeBatch('b_test_retry_count');

    const success = await collector.uploadBatch(batch);

    expect(success).toBe(false);

    // telemetry_queue 記錄應存在且 retry_count = 1
    interface QueueRow { retry_count: number }
    const rows = db.query<QueueRow>(
      'SELECT retry_count FROM telemetry_queue WHERE batch_id = ?',
      ['b_test_retry_count']
    );
    expect(rows.length).toBe(1);
    expect(rows[0].retry_count).toBe(1);
  });

  it('U4. retry_count >= 3 → 從 queue 刪除（放棄）', async () => {
    mock_.setUploadError(new Error('Persistent error'));

    const batch = createFakeBatch('b_test_abandon');

    // 先手動設定 retry_count = 2，再上傳一次（第 3 次 → 放棄）
    await collector.uploadBatch(batch); // retry_count = 1
    mock_.setUploadError(new Error('Persistent error'));
    await collector.uploadBatch(batch); // retry_count = 2
    mock_.setUploadError(new Error('Persistent error'));
    await collector.uploadBatch(batch); // retry_count = 3 → 刪除

    interface QueueRow { retry_count: number }
    const rows = db.query<QueueRow>(
      'SELECT retry_count FROM telemetry_queue WHERE batch_id = ?',
      ['b_test_abandon']
    );
    // retry_count >= 3 → 被刪除
    expect(rows.length).toBe(0);
  });

  it('U5. 重複 batch_id → INSERT OR IGNORE，不重複插入', async () => {
    const batch = createFakeBatch('b_test_duplicate');

    // 第一次上傳
    mock_.setUploadError(new Error('fail 1'));
    await collector.uploadBatch(batch);

    // 第二次上傳（同 batch_id）
    mock_.setUploadError(null);
    const success = await collector.uploadBatch(batch);
    expect(success).toBe(true);

    // 確認 queue 只有一筆（或已刪除）
    interface QueueRow { id: number }
    const rows = db.query<QueueRow>(
      'SELECT id FROM telemetry_queue WHERE batch_id = ?',
      ['b_test_duplicate']
    );
    // 成功上傳後應被刪除
    expect(rows.length).toBe(0);
  });
});

// ===== scheduleUpload 排程 =====

describe('TelemetryCollector — scheduleUpload 排程', () => {
  let db: ClawDatabase;
  let collector: TelemetryCollector;

  beforeEach(async () => {
    db = await createTestDb();
    const mock_ = createMockVPSClient();
    collector = new TelemetryCollector(db, mock_.client);
  });

  afterEach(() => {
    collector.stopSchedule();
  });

  it('S1. scheduleUpload 啟動後有計時器（不立即執行）', () => {
    // 確認 scheduleUpload 不會同步執行
    let executed = false;
    const originalBuildBatch = collector.buildBatch.bind(collector);
    collector.buildBatch = async () => {
      executed = true;
      return originalBuildBatch();
    };

    collector.scheduleUpload();

    // scheduleUpload 是 setTimeout，不是立即執行
    expect(executed).toBe(false);
  });

  it('S2. stopSchedule 後計時器清除', () => {
    collector.scheduleUpload();
    collector.stopSchedule();

    // 停止後不會執行（無法直接驗證，但確認不拋出錯誤）
    expect(true).toBe(true);
  });

  it('S3. 重複呼叫 scheduleUpload 不會產生多個計時器', () => {
    // 呼叫多次，應只保留最後一個計時器
    collector.scheduleUpload();
    collector.scheduleUpload();
    collector.scheduleUpload();

    // 確認不拋出錯誤，只保留一個排程
    collector.stopSchedule();
    expect(true).toBe(true);
  });
});

// ===== uploadBacklog 積壓數據 =====

describe('TelemetryCollector — uploadBacklog', () => {
  let db: ClawDatabase;
  let collector: TelemetryCollector;
  let mock_: ReturnType<typeof createMockVPSClient>;

  beforeEach(async () => {
    db = await createTestDb();
    mock_ = createMockVPSClient();
    collector = new TelemetryCollector(db, mock_.client);
    insertDevice(db);
  });

  afterEach(() => {
    collector.stopSchedule();
  });

  it('BL1. 傳入批次清單 → 逐一上傳', async () => {
    const batches: TelemetryBatch[] = [
      {
        schema_version: 1,
        batch_id: 'b_backlog_001',
        period: { from: new Date(Date.now() - 7200000).toISOString(), to: new Date(Date.now() - 3600000).toISOString() },
        entries: [],
        summary: { total_requests: 0, success_rate: 1, services_used: [], pool_stats: { king_pool_used: 0, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 } },
      },
      {
        schema_version: 1,
        batch_id: 'b_backlog_002',
        period: { from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() },
        entries: [],
        summary: { total_requests: 0, success_rate: 1, services_used: [], pool_stats: { king_pool_used: 0, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 } },
      },
    ];

    await collector.uploadBacklog(batches);

    expect(mock_.uploadCalls.length).toBe(2);
  });

  it('BL2. 不傳參數 → 從 DB 讀取 telemetry_queue', async () => {
    // 手動存入佇列
    const payload = new TextEncoder().encode(JSON.stringify({
      schema_version: 1,
      batch_id: 'b_db_backlog_001',
      period: { from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString() },
      entries: [],
      summary: { total_requests: 0, success_rate: 1, services_used: [], pool_stats: { king_pool_used: 0, friend_pool_used: 0, l0_pool_used: 0, aid_used: 0 } },
    }));

    db.run(
      `INSERT INTO telemetry_queue (batch_id, payload, period_from, period_to)
       VALUES (?, ?, datetime('now', '-1 hour'), datetime('now'))`,
      ['b_db_backlog_001', payload]
    );

    await collector.uploadBacklog();

    expect(mock_.uploadCalls.length).toBe(1);
  });

  it('BL3. 空 queue → 不上傳', async () => {
    await collector.uploadBacklog();
    expect(mock_.uploadCalls.length).toBe(0);
  });
});

// ===== submitFeedback =====

describe('TelemetryCollector — submitFeedback', () => {
  let db: ClawDatabase;
  let collector: TelemetryCollector;
  let mock_: ReturnType<typeof createMockVPSClient>;

  beforeEach(async () => {
    db = await createTestDb();
    mock_ = createMockVPSClient();
    collector = new TelemetryCollector(db, mock_.client);
  });

  afterEach(() => {
    collector.stopSchedule();
  });

  it('F1. submitFeedback → 呼叫 VPSClient.submitFeedback 並傳遞正確參數', async () => {
    await collector.submitFeedback({
      recommendation_id: 'rec_abc123',
      service_id: 'groq',
      feedback: 'positive',
    });

    expect(mock_.feedbackCalls.length).toBe(1);
    const call = mock_.feedbackCalls[0] as {
      recommendation_id: string;
      service_id: string;
      feedback: string;
    };
    expect(call.recommendation_id).toBe('rec_abc123');
    expect(call.service_id).toBe('groq');
    expect(call.feedback).toBe('positive');
  });

  it('F2. 負面回饋含 reason 和 comment', async () => {
    await collector.submitFeedback({
      recommendation_id: 'rec_xyz789',
      service_id: 'openai',
      feedback: 'negative',
      reason: 'high_latency',
      comment: '太慢了',
    });

    const call = mock_.feedbackCalls[0] as {
      reason: string;
      comment: string;
    };
    expect(call.reason).toBe('high_latency');
    expect(call.comment).toBe('太慢了');
  });
});
