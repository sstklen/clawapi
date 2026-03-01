// Scheduler 測試
// 驗證：fake clock 觸發各排程、冷啟動有/無歷史數據
// 使用 in-memory SQLite + mock service

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { VPSScheduler } from '../scheduler';
import { VPSDatabase } from '../../storage/database';
import { VPSKeyManager } from '../ecdh';
import type { IntelligenceEngine, ColdStartResult, HourlyAnalysisResult } from '../../services/intelligence-engine';
import type { L0Manager, HealthCheckResult } from '../../services/l0-manager';

// ===== 測試用 Mock 工廠 =====

// 建立 in-memory DB
function createTestDb(): VPSDatabase {
  return new VPSDatabase(':memory:');
}

// 建立 IntelligenceEngine Mock
function createMockIntelligenceEngine(): IntelligenceEngine {
  return {
    coldStart: mock(async (): Promise<ColdStartResult> => ({
      recommendations_loaded: 0,
      source: 'empty',
    })),
    runHourlyAnalysis: mock(async (): Promise<HourlyAnalysisResult> => ({
      recommendations_generated: 5,
      alerts_fired: 1,
      services_analyzed: 8,
    })),
    getRouteSuggestions: mock(() => []),
    handleFeedback: mock(async () => ({ success: true })),
    receiveBatch: mock(async () => ({
      success: true,
      batch_id: 'test-batch',
      entries_stored: 0,
      reputation_weight: 1.0,
    })),
    startHourlyAnalysis: mock(() => {}),
    stopHourlyAnalysis: mock(() => {}),
  } as unknown as IntelligenceEngine;
}

// 建立 L0Manager Mock
function createMockL0Manager(): L0Manager {
  return {
    checkHealth: mock(async (): Promise<HealthCheckResult> => ({
      checked: 5,
      updated: 0,
      warnings: 0,
    })),
    startHealthCheck: mock(() => {}),
    stopHealthCheck: mock(() => {}),
    getKeys: mock(() => null),
    getDeviceLimits: mock(() => ({})),
    handleDonate: mock(async () => ({
      accepted: true,
      l0_key_id: 'test-key-id',
      message: '成功',
      validation: { key_valid: true, service_confirmed: 'test', estimated_daily_quota: 100 },
    })),
    reportUsage: mock(async () => ({ updated: 0 })),
    prepareForDownload: mock(() => ({})),
    init: mock(async () => {}),
  } as unknown as L0Manager;
}

// ===== 測試群組 =====

describe('VPSScheduler 冷啟動測試', () => {
  let db: VPSDatabase;
  let keyManager: VPSKeyManager;

  beforeEach(async () => {
    db = createTestDb();
    await db.init();
    keyManager = new VPSKeyManager(db);
    await keyManager.init();
  });

  test('冷啟動（無歷史數據）：來源應為 empty', async () => {
    const engine = createMockIntelligenceEngine();
    // 無歷史數據：coldStart 回傳 source='empty'
    (engine.coldStart as ReturnType<typeof mock>).mockImplementation(async () => ({
      recommendations_loaded: 0,
      source: 'empty' as const,
    }));

    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    const result = await scheduler.coldStart();

    expect(result.source).toBe('empty');
    expect(result.recommendations_loaded).toBe(0);
    expect(engine.coldStart).toHaveBeenCalledTimes(1);

    const status = scheduler.getStatus();
    expect(status.coldStartDone).toBe(true);
  });

  test('冷啟動（有 24 小時歷史數據）：來源應為 24hr_aggregate', async () => {
    const engine = createMockIntelligenceEngine();
    // 有歷史數據：coldStart 回傳 source='24hr_aggregate'
    (engine.coldStart as ReturnType<typeof mock>).mockImplementation(async () => ({
      recommendations_loaded: 42,
      source: '24hr_aggregate' as const,
    }));

    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    const result = await scheduler.coldStart();

    expect(result.source).toBe('24hr_aggregate');
    expect(result.recommendations_loaded).toBe(42);
    expect(scheduler.getStatus().coldStartDone).toBe(true);
  });

  test('冷啟動失敗：coldStartDone 應為 false，回傳 empty', async () => {
    const engine = createMockIntelligenceEngine();
    (engine.coldStart as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('模擬 DB 連線失敗');
    });

    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    const result = await scheduler.coldStart();

    // 即使失敗，應回傳安全的預設值
    expect(result.source).toBe('empty');
    expect(result.recommendations_loaded).toBe(0);
    expect(scheduler.getStatus().coldStartDone).toBe(false);
  });
});

describe('VPSScheduler 排程任務觸發測試', () => {
  let db: VPSDatabase;
  let keyManager: VPSKeyManager;
  let engine: IntelligenceEngine;
  let l0Manager: L0Manager;
  let scheduler: VPSScheduler;

  beforeEach(async () => {
    db = createTestDb();
    await db.init();
    keyManager = new VPSKeyManager(db);
    await keyManager.init();
    engine = createMockIntelligenceEngine();
    l0Manager = createMockL0Manager();
    scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);
  });

  test('手動觸發集體智慧分析：應呼叫 runHourlyAnalysis', async () => {
    const result = await scheduler.triggerIntelligence();

    expect(result.recommendations_generated).toBe(5);
    expect(result.services_analyzed).toBe(8);
    expect(engine.runHourlyAnalysis).toHaveBeenCalledTimes(1);
  });

  test('手動觸發 L0 健康檢查：應呼叫 checkHealth', async () => {
    const result = await scheduler.triggerL0Health();

    expect(result.checked).toBe(5);
    expect(result.warnings).toBe(0);
    expect(l0Manager.checkHealth).toHaveBeenCalledTimes(1);
  });

  test('手動觸發 DB 清理：應不拋出錯誤（空 DB）', async () => {
    // 空 DB 也應正常執行（刪除 0 筆）
    await expect(scheduler.triggerDbCleanup()).resolves.toBeUndefined();
  });

  test('手動觸發 WAL checkpoint：應不拋出錯誤', () => {
    expect(() => scheduler.triggerWalCheckpoint()).not.toThrow();
  });

  test('手動觸發 ECDH 金鑰輪換：應呼叫 rotateIfNeeded', async () => {
    const rotateIfNeededSpy = spyOn(keyManager, 'rotateIfNeeded');
    rotateIfNeededSpy.mockImplementation(async () => false);

    const result = await scheduler.triggerEcdhRotation();

    expect(rotateIfNeededSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(false); // 金鑰未到期，不輪換
  });

  test('ECDH 金鑰輪換（模擬已到 30 天）：應回傳 true', async () => {
    const rotateIfNeededSpy = spyOn(keyManager, 'rotateIfNeeded');
    rotateIfNeededSpy.mockImplementation(async () => true); // 模擬超過 30 天

    const result = await scheduler.triggerEcdhRotation();

    expect(result).toBe(true);
    expect(rotateIfNeededSpy).toHaveBeenCalledTimes(1);
  });
});

describe('VPSScheduler 狀態追蹤測試', () => {
  let db: VPSDatabase;
  let keyManager: VPSKeyManager;

  beforeEach(async () => {
    db = createTestDb();
    await db.init();
    keyManager = new VPSKeyManager(db);
    await keyManager.init();
  });

  test('初始狀態：running=false，所有任務未執行', () => {
    const engine = createMockIntelligenceEngine();
    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    const status = scheduler.getStatus();

    expect(status.running).toBe(false);
    expect(status.coldStartDone).toBe(false);
    expect(status.startedAt).toBeNull();
    expect(status.tasks.intelligence.runCount).toBe(0);
    expect(status.tasks.l0Health.runCount).toBe(0);
    expect(status.tasks.walCheckpoint.runCount).toBe(0);
  });

  test('執行任務後：runCount 應增加', async () => {
    const engine = createMockIntelligenceEngine();
    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    // 執行 3 次集體智慧分析
    await scheduler.triggerIntelligence();
    await scheduler.triggerIntelligence();
    await scheduler.triggerIntelligence();

    const status = scheduler.getStatus();
    expect(status.tasks.intelligence.runCount).toBe(3);
    expect(status.tasks.intelligence.lastRunAt).not.toBeNull();
    expect(status.tasks.intelligence.errorCount).toBe(0);
  });

  test('任務失敗：errorCount 應增加，lastError 應有內容', async () => {
    const engine = createMockIntelligenceEngine();
    (engine.runHourlyAnalysis as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('模擬分析失敗');
    });

    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    // 觸發失敗
    await expect(scheduler.triggerIntelligence()).rejects.toThrow('模擬分析失敗');

    const status = scheduler.getStatus();
    expect(status.tasks.intelligence.errorCount).toBe(1);
    expect(status.tasks.intelligence.lastError).toContain('模擬分析失敗');
  });

  test('WAL checkpoint：執行後 runCount 應增加', () => {
    const engine = createMockIntelligenceEngine();
    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    scheduler.triggerWalCheckpoint();
    scheduler.triggerWalCheckpoint();

    const status = scheduler.getStatus();
    expect(status.tasks.walCheckpoint.runCount).toBe(2);
    expect(status.tasks.walCheckpoint.lastRunAt).not.toBeNull();
  });
});

describe('VPSScheduler start/stop 測試', () => {
  let db: VPSDatabase;
  let keyManager: VPSKeyManager;

  beforeEach(async () => {
    db = createTestDb();
    await db.init();
    keyManager = new VPSKeyManager(db);
    await keyManager.init();
  });

  test('start() 後 running 應為 true，stop() 後應為 false', async () => {
    const engine = createMockIntelligenceEngine();
    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    await scheduler.start();
    expect(scheduler.getStatus().running).toBe(true);
    expect(scheduler.getStatus().startedAt).not.toBeNull();

    scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
  });

  test('重複 start()：第二次應被忽略', async () => {
    const engine = createMockIntelligenceEngine();
    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    await scheduler.start();
    const firstStartedAt = scheduler.getStatus().startedAt;

    // 再次 start（應被忽略）
    await scheduler.start();
    expect(scheduler.getStatus().startedAt).toBe(firstStartedAt);

    scheduler.stop();
  });

  test('stop() 未 running：應不拋出錯誤', () => {
    const engine = createMockIntelligenceEngine();
    const l0Manager = createMockL0Manager();
    const scheduler = new VPSScheduler(engine, l0Manager, db, keyManager);

    expect(() => scheduler.stop()).not.toThrow();
  });
});
