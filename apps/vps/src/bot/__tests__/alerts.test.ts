// BotAlerts 測試
// 驗證：異常閾值觸發/不觸發、L0 額度 3 階段、自動降額邏輯

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  IntelligenceAlerts,
  L0Alerts,
  BotAlerts,
  SUCCESS_RATE_DROP_THRESHOLD,
  L0_QUOTA_WARNING_THRESHOLD,
  L0_QUOTA_CRITICAL_THRESHOLD,
  AUTO_THROTTLE_RATIO,
} from '../alerts';
import type { VPSDatabase } from '../../storage/database';
import type { AlertManager } from '../../core/alert-manager';

// ===== Mock 工廠 =====

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

// 建立帶自訂 query 函式的 mock DB
function makeMockDb(queryFn: (sql: string) => unknown[]): VPSDatabase {
  return {
    run: mock(() => ({ changes: 1, lastInsertRowid: 1 })),
    query: mock((sql: string) => queryFn(sql)),
    getDevice: mock(() => null),
    getDeviceByToken: mock(() => null),
    updateDeviceLastSeen: mock(() => {}),
    transaction: mock((fn: () => unknown) => fn()),
    checkpoint: mock(() => {}),
    init: mock(async () => {}),
    close: mock(async () => {}),
  } as unknown as VPSDatabase;
}

// ===== IntelligenceAlerts 測試 =====

describe('IntelligenceAlerts', () => {

  describe('checkSuccessRateDrop', () => {

    it('無路由建議資料 → 不觸發告警', async () => {
      const db = makeMockDb(() => []);
      const alertManager = makeMockAlertManager();
      const alerts = new IntelligenceAlerts(db, alertManager);

      const result = await alerts.checkSuccessRateDrop();

      expect(result.alertsFired).toBe(0);
      expect(result.anomalies).toHaveLength(0);
    });

    it('成功率下降 > 15% → 觸發告警', async () => {
      let callCount = 0;
      const db = makeMockDb(() => {
        callCount++;
        if (callCount === 1) {
          // 當前（最近 1 小時）
          return [{
            service_id: 'openai',
            region: 'asia',
            success_rate: 0.70,   // 當前 70%
            generated_at: new Date().toISOString(),
          }];
        }
        // 前一小時
        return [{
          service_id: 'openai',
          region: 'asia',
          success_rate: 0.90,   // 前一小時 90%
          generated_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        }];
      });

      const alertManager = makeMockAlertManager();
      const alerts = new IntelligenceAlerts(db, alertManager);

      const result = await alerts.checkSuccessRateDrop();

      expect(result.alertsFired).toBe(1);
      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]!.serviceId).toBe('openai');
      expect(result.anomalies[0]!.drop).toBeCloseTo(0.20);
    });

    it('成功率下降剛好 15% → 不觸發告警（邊界）', async () => {
      let callCount = 0;
      const db = makeMockDb(() => {
        callCount++;
        if (callCount === 1) {
          return [{
            service_id: 'groq',
            region: 'asia',
            success_rate: 0.80,  // 下降剛好 15%
            generated_at: new Date().toISOString(),
          }];
        }
        return [{
          service_id: 'groq',
          region: 'asia',
          success_rate: 0.95,
          generated_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        }];
      });

      const alertManager = makeMockAlertManager();
      const alerts = new IntelligenceAlerts(db, alertManager);

      const result = await alerts.checkSuccessRateDrop();

      // 0.95 - 0.80 = 0.15，不超過閾值（> 而非 >=）
      expect(result.alertsFired).toBe(0);
    });

    it('成功率下降 < 15% → 不觸發告警', async () => {
      let callCount = 0;
      const db = makeMockDb(() => {
        callCount++;
        if (callCount === 1) {
          return [{
            service_id: 'anthropic',
            region: 'europe',
            success_rate: 0.88,   // 下降 7%
            generated_at: new Date().toISOString(),
          }];
        }
        return [{
          service_id: 'anthropic',
          region: 'europe',
          success_rate: 0.95,
          generated_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        }];
      });

      const alertManager = makeMockAlertManager();
      const alerts = new IntelligenceAlerts(db, alertManager);

      const result = await alerts.checkSuccessRateDrop();
      expect(result.alertsFired).toBe(0);
    });

    it('確認 SUCCESS_RATE_DROP_THRESHOLD 常數值為 0.15', () => {
      expect(SUCCESS_RATE_DROP_THRESHOLD).toBe(0.15);
    });
  });
});

// ===== L0Alerts 測試 =====

describe('L0Alerts', () => {

  describe('checkQuota', () => {

    it('無 L0 Key → 不觸發告警', async () => {
      const db = makeMockDb(() => []);
      const alertManager = makeMockAlertManager();
      const alerts = new L0Alerts(db, alertManager);

      const result = await alerts.checkQuota();

      expect(result.alertsFired).toBe(0);
      expect(result.keysChecked).toBe(0);
      expect(result.actions).toHaveLength(0);
    });

    it('L0 額度 < 80% → 正常，不告警', async () => {
      const db = makeMockDb(() => [{
        id: 'l0_key_1',
        service_id: 'groq',
        daily_quota: 1000,
        daily_used: 700,   // 70%，低於 80% 閾值
        status: 'active',
      }]);
      const alertManager = makeMockAlertManager();
      const alerts = new L0Alerts(db, alertManager);

      const result = await alerts.checkQuota();

      expect(result.alertsFired).toBe(0);
      expect(result.actions).toHaveLength(0);
    });

    it('L0 額度 > 80% → warning 告警', async () => {
      const db = makeMockDb(() => [{
        id: 'l0_key_2',
        service_id: 'openai',
        daily_quota: 1000,
        daily_used: 850,   // 85%，觸發 warning
        status: 'active',
      }]);
      const alertManager = makeMockAlertManager();
      const alerts = new L0Alerts(db, alertManager);

      const result = await alerts.checkQuota();

      expect(result.alertsFired).toBe(1);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]!.status).toBe('warning');
      expect(result.actions[0]!.autoThrottled).toBe(false);
    });

    it('L0 額度 > 95% → critical 告警 + 自動降額 50%', async () => {
      const originalQuota = 1000;
      const db = makeMockDb(() => [{
        id: 'l0_key_3',
        service_id: 'anthropic',
        daily_quota: originalQuota,
        daily_used: 960,   // 96%，觸發 critical
        status: 'active',
      }]);

      const dbRun = db.run as ReturnType<typeof mock>;
      const alertManager = makeMockAlertManager();
      const alerts = new L0Alerts(db, alertManager);

      const result = await alerts.checkQuota();

      expect(result.alertsFired).toBe(1);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]!.status).toBe('critical');
      expect(result.actions[0]!.autoThrottled).toBe(true);

      // 確認降額為 50%
      const expectedNewQuota = Math.floor(originalQuota * AUTO_THROTTLE_RATIO);
      expect(result.actions[0]!.newQuota).toBe(expectedNewQuota);  // 500

      // 確認 DB 有被更新（執行降額）
      expect(dbRun.mock.calls.length).toBeGreaterThan(0);
    });

    it('L0 額度剛好 95% → warning（邊界，不自動降額）', async () => {
      const db = makeMockDb(() => [{
        id: 'l0_key_4',
        service_id: 'deepseek',
        daily_quota: 1000,
        daily_used: 950,   // 剛好 95%
        status: 'active',
      }]);
      const alertManager = makeMockAlertManager();
      const alerts = new L0Alerts(db, alertManager);

      const result = await alerts.checkQuota();

      // 95% 不超過臨界值（> 而非 >=）
      expect(result.actions[0]?.status).toBe('warning');
      expect(result.actions[0]?.autoThrottled).toBe(false);
    });

    it('多個 Key 各別判定', async () => {
      let queryCount = 0;
      const db = makeMockDb(() => {
        // 第一次呼叫返回多個 Key
        return [
          { id: 'key_a', service_id: 'groq', daily_quota: 100, daily_used: 60, status: 'active' },    // 60% 正常
          { id: 'key_b', service_id: 'openai', daily_quota: 100, daily_used: 85, status: 'active' },  // 85% warning
          { id: 'key_c', service_id: 'anthropic', daily_quota: 100, daily_used: 96, status: 'active' }, // 96% critical
        ];
      });
      const alertManager = makeMockAlertManager();
      const alerts = new L0Alerts(db, alertManager);

      const result = await alerts.checkQuota();

      expect(result.keysChecked).toBe(3);
      expect(result.alertsFired).toBe(2);  // warning + critical 各 1
      expect(result.actions).toHaveLength(2);
    });

    it('確認三個閾值常數正確', () => {
      expect(L0_QUOTA_WARNING_THRESHOLD).toBe(0.80);
      expect(L0_QUOTA_CRITICAL_THRESHOLD).toBe(0.95);
      expect(AUTO_THROTTLE_RATIO).toBe(0.50);
    });
  });

  describe('resetDailyUsage', () => {
    it('重置每日用量應呼叫 DB', () => {
      const db = makeMockDb(() => []);
      const dbRun = db.run as ReturnType<typeof mock>;
      const alertManager = makeMockAlertManager();
      const alerts = new L0Alerts(db, alertManager);

      alerts.resetDailyUsage();

      expect(dbRun.mock.calls.length).toBe(1);
      const sql = dbRun.mock.calls[0]![0] as string;
      expect(sql).toContain('daily_used');
      expect(sql).toContain('UPDATE l0_keys');
    });
  });
});

// ===== BotAlerts 整合測試 =====

describe('BotAlerts', () => {
  it('runAllChecks 同時執行 intelligence 和 l0 檢查', async () => {
    const db = makeMockDb(() => []);
    const alertManager = makeMockAlertManager();
    const botAlerts = new BotAlerts(db, alertManager);

    const result = await botAlerts.runAllChecks();

    expect(result).toHaveProperty('intelligence');
    expect(result).toHaveProperty('l0');
    expect(result).toHaveProperty('totalAlertsFired');
    expect(typeof result.totalAlertsFired).toBe('number');
  });

  it('totalAlertsFired 是 intelligence + l0 的總和', async () => {
    const db = makeMockDb(() => []);
    const alertManager = makeMockAlertManager();
    const botAlerts = new BotAlerts(db, alertManager);

    const result = await botAlerts.runAllChecks();

    expect(result.totalAlertsFired).toBe(
      result.intelligence.alertsFired + result.l0.alertsFired,
    );
  });
});
