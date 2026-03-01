// 告警管理器測試
// 驗證：去重計時、不同類型不去重、severity、DB 寫入

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AlertManager } from '../alert-manager';
import type { VPSDatabase } from '../../storage/database';

// ===== Mock VPSDatabase =====

function makeMockDb(): VPSDatabase {
  const runMock = mock(() => ({ changes: 1, lastInsertRowid: 1 }));
  const queryMock = mock(() => []);

  return {
    run: runMock,
    query: queryMock,
    getDevice: mock(() => null),
    getDeviceByToken: mock(() => null),
    updateDeviceLastSeen: mock(() => {}),
    transaction: mock((fn: () => unknown) => fn()),
    checkpoint: mock(() => {}),
    init: mock(async () => {}),
    close: mock(async () => {}),
  } as unknown as VPSDatabase;
}

// ===== 測試 =====

describe('AlertManager', () => {
  let db: VPSDatabase;
  let manager: AlertManager;

  beforeEach(() => {
    db = makeMockDb();
    // 不提供 Telegram 設定（避免真實呼叫）
    manager = new AlertManager(db);
  });

  // ===== 去重測試 =====

  describe('告警去重', () => {
    it('同類告警 1 小時內不重發', async () => {
      const alert = {
        severity: 'warning' as const,
        category: 'disk_usage',
        message: '磁碟使用率 80%',
      };

      // 第一次發送應成功
      const first = await manager.sendAlert(alert);
      expect(first).toBe(true);

      // 立即重發同類告警應被去重
      const second = await manager.sendAlert(alert);
      expect(second).toBe(false);
    });

    it('去重快取記錄發送時間', async () => {
      expect(manager._getCacheSize()).toBe(0);

      await manager.sendAlert({
        severity: 'info',
        category: 'test_category',
        message: '測試訊息',
      });

      expect(manager._getCacheSize()).toBe(1);
    });

    it('1 小時後相同告警可以重發', async () => {
      const alert = {
        severity: 'warning' as const,
        category: 'memory_usage',
        message: '記憶體使用率 85%',
      };

      // 注入一個 61 分鐘前的快取（已過期）
      const expiredAt = Date.now() - 61 * 60 * 1000;
      manager._injectCache('warning', 'memory_usage', expiredAt);

      // 應該可以重發（快取已過期）
      const sent = await manager.sendAlert(alert);
      expect(sent).toBe(true);
    });

    it('59 分鐘前的告警仍被去重', async () => {
      const alert = {
        severity: 'critical' as const,
        category: 'disk_critical',
        message: '磁碟快滿了',
      };

      // 注入一個 59 分鐘前的快取（未過期）
      const recentAt = Date.now() - 59 * 60 * 1000;
      manager._injectCache('critical', 'disk_critical', recentAt);

      // 應該被去重
      const sent = await manager.sendAlert(alert);
      expect(sent).toBe(false);
    });
  });

  // ===== 不同類型不去重 =====

  describe('不同分類不互相去重', () => {
    it('同 severity 但不同 category 不去重', async () => {
      const alert1 = { severity: 'warning' as const, category: 'disk_usage', message: '磁碟警告' };
      const alert2 = { severity: 'warning' as const, category: 'memory_usage', message: '記憶體警告' };

      const first = await manager.sendAlert(alert1);
      const second = await manager.sendAlert(alert2);

      expect(first).toBe(true);
      expect(second).toBe(true);  // 不同 category，不去重
    });

    it('同 category 但不同 severity 不去重', async () => {
      const alert1 = { severity: 'warning' as const, category: 'disk', message: '磁碟警告' };
      const alert2 = { severity: 'critical' as const, category: 'disk', message: '磁碟危急' };

      const first = await manager.sendAlert(alert1);
      const second = await manager.sendAlert(alert2);

      expect(first).toBe(true);
      expect(second).toBe(true);  // 不同 severity，不去重
    });
  });

  // ===== Severity 測試 =====

  describe('severity 正確處理', () => {
    it('接受三種合法 severity', async () => {
      const severities = ['info', 'warning', 'critical'] as const;

      for (const severity of severities) {
        const sent = await manager.sendAlert({
          severity,
          category: `test_${severity}`,
          message: `${severity} 測試訊息`,
        });
        expect(sent).toBe(true);
      }
    });

    it('帶 suggestion 的告警也能正確發送', async () => {
      const sent = await manager.sendAlert({
        severity: 'warning',
        category: 'with_suggestion',
        message: '需要建議的告警',
        suggestion: '請執行維護程序',
      });
      expect(sent).toBe(true);
    });
  });

  // ===== DB 寫入驗證 =====

  describe('DB 寫入', () => {
    it('發送告警後應寫入 alert_history 表', async () => {
      const dbRun = db.run as ReturnType<typeof mock>;

      await manager.sendAlert({
        severity: 'critical',
        category: 'test_db_write',
        message: '測試 DB 寫入',
      });

      // 確認 db.run 有被呼叫（寫入 alert_history）
      expect(dbRun.mock.calls.length).toBeGreaterThan(0);

      // 確認 SQL 包含 alert_history
      const sqlCalls = dbRun.mock.calls.map(call => call[0] as string);
      const hasAlertHistoryWrite = sqlCalls.some(sql => sql.includes('alert_history'));
      expect(hasAlertHistoryWrite).toBe(true);
    });

    it('去重跳過的告警不應寫入 DB', async () => {
      const dbRun = db.run as ReturnType<typeof mock>;

      const alert = {
        severity: 'info' as const,
        category: 'dedup_test',
        message: '去重測試',
      };

      await manager.sendAlert(alert);
      const callsAfterFirst = dbRun.mock.calls.length;

      // 第二次發送（應被去重）
      await manager.sendAlert(alert);
      const callsAfterSecond = dbRun.mock.calls.length;

      // 去重後不應有新的 DB 呼叫
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  // ===== 批量發送 =====

  describe('批量發送', () => {
    it('批量發送多個告警，回傳各別結果', async () => {
      const alerts = [
        { severity: 'info' as const, category: 'bulk_1', message: '批量 1' },
        { severity: 'warning' as const, category: 'bulk_2', message: '批量 2' },
        { severity: 'critical' as const, category: 'bulk_3', message: '批量 3' },
      ];

      const results = await manager.sendAlerts(alerts);

      expect(results).toHaveLength(3);
      expect(results.every(r => r.sent === true)).toBe(true);
    });
  });

  // ===== 快取清理 =====

  describe('快取清理', () => {
    it('clearDedupeCache 應清空所有快取', async () => {
      await manager.sendAlert({ severity: 'info', category: 'cache_test', message: '測試' });
      expect(manager._getCacheSize()).toBe(1);

      manager.clearDedupeCache();
      expect(manager._getCacheSize()).toBe(0);
    });

    it('cleanExpiredCache 只清除過期項目', async () => {
      // 注入一個過期的快取
      manager._injectCache('warning', 'expired_cat', Date.now() - 2 * 60 * 60 * 1000);
      // 注入一個未過期的快取
      manager._injectCache('warning', 'fresh_cat', Date.now() - 30 * 60 * 1000);

      expect(manager._getCacheSize()).toBe(2);

      manager.cleanExpiredCache();

      // 只剩未過期的
      expect(manager._getCacheSize()).toBe(1);
    });
  });
});
