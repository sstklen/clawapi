// VPS Monitor 測試
// 驗證：各閾值觸發/不觸發、8 子系統完整、overall 狀態判定

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  VPSMonitor,
  THRESHOLDS,
} from '../monitor';
import type { SystemMetrics, HealthReport } from '../monitor';
import type { VPSDatabase } from '../../storage/database';
import type { AlertManager } from '../../core/alert-manager';

// ===== Mock 工廠 =====

function makeMockDb(): VPSDatabase {
  return {
    run: mock(() => ({ changes: 0, lastInsertRowid: 0 })),
    query: mock(() => [{ active: 2, total: 3 }, { enabled_count: 1 }]),
    getDevice: mock(() => null),
    getDeviceByToken: mock(() => null),
    updateDeviceLastSeen: mock(() => {}),
    transaction: mock((fn: () => unknown) => fn()),
    checkpoint: mock(() => {}),
    init: mock(async () => {}),
    close: mock(async () => {}),
  } as unknown as VPSDatabase;
}

function makeMockAlertManager(): AlertManager {
  return {
    sendAlert: mock(async () => true),
    sendAlerts: mock(async () => []),
    clearDedupeCache: mock(() => {}),
    cleanExpiredCache: mock(() => {}),
    getHistory: mock(() => []),
    _getCacheSize: mock(() => 0),
    _injectCache: mock(() => {}),
  } as unknown as AlertManager;
}

function makeMetrics(overrides: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    diskUsagePercent: 50,
    memoryUsagePercent: 60,
    wsConnectionCount: 100,
    dbSizeBytes: 1 * 1024 * 1024 * 1024,  // 1 GB
    intelligenceLastUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ===== 測試 =====

describe('VPSMonitor 個別閾值檢查', () => {
  let monitor: VPSMonitor;

  beforeEach(() => {
    const db = makeMockDb();
    const alertManager = makeMockAlertManager();
    monitor = new VPSMonitor(db, alertManager);
  });

  // ===== 磁碟閾值 =====

  describe('checkDisk', () => {
    it('磁碟 < 75% → healthy', () => {
      const result = monitor.checkDisk(70);
      expect(result.status).toBe('healthy');
      expect(result.name).toBe('disk');
    });

    it('磁碟 = 75% → healthy（邊界）', () => {
      const result = monitor.checkDisk(75);
      // 75% 不超過 75，所以是 healthy
      expect(result.status).toBe('healthy');
    });

    it('磁碟 > 75% → warning', () => {
      const result = monitor.checkDisk(76);
      expect(result.status).toBe('warning');
    });

    it('磁碟 = 90% → warning（邊界，不是 critical）', () => {
      const result = monitor.checkDisk(90);
      // 90% 不超過 90，所以是 warning
      expect(result.status).toBe('warning');
    });

    it('磁碟 > 90% → critical', () => {
      const result = monitor.checkDisk(91);
      expect(result.status).toBe('critical');
    });

    it('磁碟 100% → critical（極端值）', () => {
      const result = monitor.checkDisk(100);
      expect(result.status).toBe('critical');
    });

    it('回傳值包含正確的數值和閾值', () => {
      const result = monitor.checkDisk(80);
      expect(result.value).toBe(80);
      expect(result.threshold).toBeDefined();
    });
  });

  // ===== 記憶體閾值 =====

  describe('checkMemory', () => {
    it('記憶體 < 80% → healthy', () => {
      const result = monitor.checkMemory(79);
      expect(result.status).toBe('healthy');
    });

    it('記憶體 > 80% → warning', () => {
      const result = monitor.checkMemory(81);
      expect(result.status).toBe('warning');
    });

    it('記憶體 > 95% → critical', () => {
      const result = monitor.checkMemory(96);
      expect(result.status).toBe('critical');
    });

    it('記憶體 = 95% → warning（邊界）', () => {
      const result = monitor.checkMemory(95);
      // 95% 不超過 95，所以是 warning
      expect(result.status).toBe('warning');
    });
  });

  // ===== WebSocket 閾值 =====

  describe('checkWebSocket', () => {
    it('WS 連線 < 4000 → healthy', () => {
      const result = monitor.checkWebSocket(3999);
      expect(result.status).toBe('healthy');
    });

    it('WS 連線 = 4000 → healthy（邊界）', () => {
      const result = monitor.checkWebSocket(4000);
      expect(result.status).toBe('healthy');
    });

    it('WS 連線 > 4000 → warning', () => {
      const result = monitor.checkWebSocket(4001);
      expect(result.status).toBe('warning');
      expect(result.threshold).toBe(THRESHOLDS.WS_WARNING);
    });

    it('WS 連線 = 0 → healthy（空閒狀態）', () => {
      const result = monitor.checkWebSocket(0);
      expect(result.status).toBe('healthy');
    });
  });

  // ===== DB 大小閾值 =====

  describe('checkDatabase', () => {
    it('DB < 5 GB → healthy', () => {
      const result = monitor.checkDatabase(4 * 1024 * 1024 * 1024);
      expect(result.status).toBe('healthy');
    });

    it('DB > 5 GB → warning', () => {
      const result = monitor.checkDatabase(6 * 1024 * 1024 * 1024);
      expect(result.status).toBe('warning');
    });
  });

  // ===== 集體智慧更新閾值 =====

  describe('checkIntelligence', () => {
    it('最近更新（30 分鐘前）→ healthy', () => {
      const recentTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const result = monitor.checkIntelligence(recentTime);
      expect(result.status).toBe('healthy');
    });

    it('超過 2 小時未更新 → warning', () => {
      const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const result = monitor.checkIntelligence(staleTime);
      expect(result.status).toBe('warning');
    });

    it('剛好 2 小時前更新 → warning（邊界）', () => {
      const borderlineTime = new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000).toISOString();
      const result = monitor.checkIntelligence(borderlineTime);
      expect(result.status).toBe('warning');
    });

    it('未提供更新時間 → unknown', () => {
      const result = monitor.checkIntelligence(undefined);
      expect(result.status).toBe('unknown');
    });
  });
});

// ===== 完整健康檢查測試 =====

describe('VPSMonitor.runHealthCheck', () => {
  it('正常指標 → overall healthy', async () => {
    const db = makeMockDb();
    // query 的第一次呼叫返回 L0 資料，第二次返回 aid 資料，第三次返回 intelligence 資料
    let queryCallCount = 0;
    (db.query as ReturnType<typeof mock>).mockImplementation(() => {
      queryCallCount++;
      if (queryCallCount === 1) return [{ active: 2, total: 3 }];
      if (queryCallCount === 2) return [{ enabled_count: 5 }];
      return [];
    });

    const alertManager = makeMockAlertManager();
    const normalMetrics = makeMetrics();

    const monitor = new VPSMonitor(db, alertManager, async () => normalMetrics);
    const report = await monitor.runHealthCheck();

    expect(report.overall).toBe('healthy');
    expect(report.subsystems).toHaveLength(8);
    expect(report.checkedAt).toBeDefined();
  });

  it('報告包含 8 個子系統', async () => {
    const db = makeMockDb();
    let queryCount = 0;
    (db.query as ReturnType<typeof mock>).mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ active: 1, total: 1 }];
      if (queryCount === 2) return [{ enabled_count: 0 }];
      return [];
    });

    const alertManager = makeMockAlertManager();
    const monitor = new VPSMonitor(db, alertManager, async () => makeMetrics());
    const report = await monitor.runHealthCheck();

    const subsystemNames = report.subsystems.map(s => s.name);
    const expected = ['disk', 'memory', 'websocket', 'database', 'intelligence', 'l0', 'aid', 'chat'] as const;

    // 確認 8 個子系統都存在
    expect(report.subsystems).toHaveLength(8);
    for (const name of expected) {
      expect(subsystemNames).toContain(name);
    }
  });

  it('磁碟 critical → overall critical', async () => {
    const db = makeMockDb();
    let queryCount = 0;
    (db.query as ReturnType<typeof mock>).mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ active: 1, total: 1 }];
      if (queryCount === 2) return [{ enabled_count: 0 }];
      return [];
    });

    const alertManager = makeMockAlertManager();
    const criticalMetrics = makeMetrics({ diskUsagePercent: 95 });

    const monitor = new VPSMonitor(db, alertManager, async () => criticalMetrics);
    const report = await monitor.runHealthCheck();

    expect(report.overall).toBe('critical');
  });

  it('記憶體 warning → overall warning', async () => {
    const db = makeMockDb();
    let queryCount = 0;
    (db.query as ReturnType<typeof mock>).mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ active: 1, total: 1 }];
      if (queryCount === 2) return [{ enabled_count: 0 }];
      return [];
    });

    const alertManager = makeMockAlertManager();
    const warningMetrics = makeMetrics({ memoryUsagePercent: 85 });

    const monitor = new VPSMonitor(db, alertManager, async () => warningMetrics);
    const report = await monitor.runHealthCheck();

    expect(report.overall).toBe('warning');
  });

  it('告警管理器在閾值超過時被呼叫', async () => {
    const db = makeMockDb();
    let queryCount = 0;
    (db.query as ReturnType<typeof mock>).mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ active: 1, total: 1 }];
      if (queryCount === 2) return [{ enabled_count: 0 }];
      return [];
    });

    const alertManager = makeMockAlertManager();
    const sendAlertMock = alertManager.sendAlert as ReturnType<typeof mock>;

    const alertMetrics = makeMetrics({ diskUsagePercent: 80, memoryUsagePercent: 82 });
    const monitor = new VPSMonitor(db, alertManager, async () => alertMetrics);
    await monitor.runHealthCheck();

    // 磁碟和記憶體都超過 warning 閾值，至少有 2 次 sendAlert 呼叫
    expect(sendAlertMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('回報中包含 alertsFired 計數', async () => {
    const db = makeMockDb();
    let queryCount = 0;
    (db.query as ReturnType<typeof mock>).mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ active: 1, total: 1 }];
      if (queryCount === 2) return [{ enabled_count: 0 }];
      return [];
    });

    const alertManager = makeMockAlertManager();
    const monitor = new VPSMonitor(db, alertManager, async () => makeMetrics());
    const report = await monitor.runHealthCheck();

    expect(typeof report.alertsFired).toBe('number');
    expect(report.alertsFired).toBeGreaterThanOrEqual(0);
  });
});

// ===== HealthReport 型別驗證 =====

describe('HealthReport 格式', () => {
  it('包含所有必要欄位', async () => {
    const db = makeMockDb();
    let queryCount = 0;
    (db.query as ReturnType<typeof mock>).mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return [{ active: 1, total: 2 }];
      if (queryCount === 2) return [{ enabled_count: 3 }];
      return [];
    });

    const alertManager = makeMockAlertManager();
    const monitor = new VPSMonitor(db, alertManager, async () => makeMetrics());
    const report: HealthReport = await monitor.runHealthCheck();

    expect(report).toHaveProperty('overall');
    expect(report).toHaveProperty('checkedAt');
    expect(report).toHaveProperty('subsystems');
    expect(report).toHaveProperty('alertsFired');
    expect(['healthy', 'warning', 'critical']).toContain(report.overall);
  });
});
