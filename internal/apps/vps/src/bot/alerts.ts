// Claude Bot — 集體智慧異常告警 + L0 額度告警
// 整合 IntelligenceEngine 和 L0Manager 的告警邏輯

import type { AlertManager } from '../core/alert-manager';
import type { VPSDatabase } from '../storage/database';

// ===== 型別定義 =====

// 集體智慧異常檢查結果
export interface IntelligenceAlertResult {
  alertsFired: number;
  servicesChecked: number;
  anomalies: Array<{
    serviceId: string;
    region: string;
    previousRate: number;
    currentRate: number;
    drop: number;
  }>;
}

// L0 額度狀態
export type L0QuotaStatus = 'normal' | 'warning' | 'critical';

// L0 額度告警結果
export interface L0AlertResult {
  alertsFired: number;
  keysChecked: number;
  actions: Array<{
    keyId: string;
    serviceId: string;
    status: L0QuotaStatus;
    usagePercent: number;
    autoThrottled: boolean;
    newQuota?: number;
  }>;
}

// DB 查詢結果型別
interface RoutingRecRow {
  service_id: string;
  region: string;
  success_rate: number;
  generated_at: string;
}

interface L0KeyRow {
  id: string;
  service_id: string;
  daily_quota: number;
  daily_used: number;
  status: string;
}

// ===== 告警閾值常數 =====

// 成功率下降告警閾值（15%）
const SUCCESS_RATE_DROP_THRESHOLD = 0.15;

// L0 額度告警閾值
const L0_QUOTA_WARNING_THRESHOLD = 0.80;   // 80% → 通知 tkman
const L0_QUOTA_CRITICAL_THRESHOLD = 0.95;  // 95% → 自動降額 50%

// 降額幅度（50%）
const AUTO_THROTTLE_RATIO = 0.50;

// ===== IntelligenceAlerts 類別 =====

export class IntelligenceAlerts {
  private db: VPSDatabase;
  private alertManager: AlertManager;

  constructor(db: VPSDatabase, alertManager: AlertManager) {
    this.db = db;
    this.alertManager = alertManager;
  }

  // 檢查集體智慧成功率下降（與前一小時比較）
  async checkSuccessRateDrop(): Promise<IntelligenceAlertResult> {
    const result: IntelligenceAlertResult = {
      alertsFired: 0,
      servicesChecked: 0,
      anomalies: [],
    };

    // 取得最近 1 小時的路由建議
    const currentRecs = this.db.query<RoutingRecRow>(
      `SELECT service_id, region, success_rate, generated_at
       FROM routing_recommendations
       WHERE generated_at > datetime('now', '-1 hour')
         AND success_rate IS NOT NULL`,
    );

    if (currentRecs.length === 0) return result;

    // 取得前一小時的路由建議（用於比較）
    const previousRecs = this.db.query<RoutingRecRow>(
      `SELECT service_id, region, success_rate, generated_at
       FROM routing_recommendations
       WHERE generated_at > datetime('now', '-2 hours')
         AND generated_at <= datetime('now', '-1 hour')
         AND success_rate IS NOT NULL`,
    );

    // 建立前一小時的 Map
    const previousMap = new Map<string, number>();
    for (const rec of previousRecs) {
      const key = `${rec.region}::${rec.service_id}`;
      previousMap.set(key, rec.success_rate);
    }

    result.servicesChecked = currentRecs.length;

    // 比較各服務成功率
    for (const current of currentRecs) {
      const key = `${current.region}::${current.service_id}`;
      const previousRate = previousMap.get(key);

      if (previousRate === undefined) continue;

      const drop = previousRate - current.success_rate;

      if (drop > SUCCESS_RATE_DROP_THRESHOLD) {
        result.anomalies.push({
          serviceId: current.service_id,
          region: current.region,
          previousRate,
          currentRate: current.success_rate,
          drop,
        });

        const sent = await this.alertManager.sendAlert({
          severity: 'warning',
          category: `intelligence_drop:${current.service_id}:${current.region}`,
          message: `集體智慧異常：${current.service_id}（${current.region}）成功率從 ${(previousRate * 100).toFixed(1)}% 下降至 ${(current.success_rate * 100).toFixed(1)}%（下降 ${(drop * 100).toFixed(1)}%）`,
          suggestion: '確認服務是否異常，考慮暫時調整路由策略避開此服務',
        });

        if (sent) result.alertsFired++;
      }
    }

    return result;
  }
}

// ===== L0Alerts 類別 =====

export class L0Alerts {
  private db: VPSDatabase;
  private alertManager: AlertManager;

  constructor(db: VPSDatabase, alertManager: AlertManager) {
    this.db = db;
    this.alertManager = alertManager;
  }

  // 檢查 L0 額度使用量
  // 80% → 通知 tkman
  // 95% → 自動降額 50%
  async checkQuota(): Promise<L0AlertResult> {
    const result: L0AlertResult = {
      alertsFired: 0,
      keysChecked: 0,
      actions: [],
    };

    // 取所有 active/degraded 且有 daily_quota 的 L0 Key
    const keys = this.db.query<L0KeyRow>(
      `SELECT id, service_id, daily_quota, daily_used, status
       FROM l0_keys
       WHERE status IN ('active', 'degraded')
         AND daily_quota IS NOT NULL
         AND daily_quota > 0`,
    );

    result.keysChecked = keys.length;

    for (const key of keys) {
      const usagePercent = key.daily_used / key.daily_quota;
      let status: L0QuotaStatus = 'normal';
      let autoThrottled = false;
      let newQuota: number | undefined;

      if (usagePercent > L0_QUOTA_CRITICAL_THRESHOLD) {
        // 超過 95% → 自動降額 50%
        status = 'critical';
        newQuota = Math.floor(key.daily_quota * AUTO_THROTTLE_RATIO);

        // 執行降額（更新 DB）
        this.db.run(
          `UPDATE l0_keys
           SET daily_quota = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [newQuota, key.id],
        );
        autoThrottled = true;

        const sent = await this.alertManager.sendAlert({
          severity: 'critical',
          category: `l0_quota_critical:${key.id}`,
          message: `L0 Key [${key.id}]（${key.service_id}）額度已用 ${(usagePercent * 100).toFixed(1)}%（${key.daily_used}/${key.daily_quota}），已自動降額至 ${newQuota}`,
          suggestion: '考慮擴充公共 Key 池或暫時限制 L0 服務',
        });

        if (sent) result.alertsFired++;
      } else if (usagePercent > L0_QUOTA_WARNING_THRESHOLD) {
        // 超過 80% → 通知 tkman
        status = 'warning';

        const sent = await this.alertManager.sendAlert({
          severity: 'warning',
          category: `l0_quota_warning:${key.id}`,
          message: `L0 Key [${key.id}]（${key.service_id}）額度已用 ${(usagePercent * 100).toFixed(1)}%（${key.daily_used}/${key.daily_quota}），接近上限`,
          suggestion: '請注意 Key 使用量，考慮鼓勵更多捐贈',
        });

        if (sent) result.alertsFired++;
      }

      if (status !== 'normal') {
        result.actions.push({
          keyId: key.id,
          serviceId: key.service_id,
          status,
          usagePercent,
          autoThrottled,
          newQuota,
        });
      }
    }

    return result;
  }

  // 重置每日用量（凌晨 00:00 呼叫）
  resetDailyUsage(): number {
    const result = this.db.run(
      `UPDATE l0_keys
       SET daily_used = 0,
           daily_reset_at = datetime('now'),
           updated_at = datetime('now')
       WHERE date(daily_reset_at) < date('now')
          OR daily_reset_at IS NULL`,
    );
    return result.changes;
  }
}

// ===== BotAlerts 整合類別 =====

export class BotAlerts {
  private intelligenceAlerts: IntelligenceAlerts;
  private l0Alerts: L0Alerts;

  constructor(db: VPSDatabase, alertManager: AlertManager) {
    this.intelligenceAlerts = new IntelligenceAlerts(db, alertManager);
    this.l0Alerts = new L0Alerts(db, alertManager);
  }

  // 執行所有告警檢查
  async runAllChecks(): Promise<{
    intelligence: IntelligenceAlertResult;
    l0: L0AlertResult;
    totalAlertsFired: number;
  }> {
    const [intelligence, l0] = await Promise.all([
      this.intelligenceAlerts.checkSuccessRateDrop(),
      this.l0Alerts.checkQuota(),
    ]);

    return {
      intelligence,
      l0,
      totalAlertsFired: intelligence.alertsFired + l0.alertsFired,
    };
  }

  // 取得 IntelligenceAlerts 實例（供測試使用）
  getIntelligenceAlerts(): IntelligenceAlerts {
    return this.intelligenceAlerts;
  }

  // 取得 L0Alerts 實例（供測試使用）
  getL0Alerts(): L0Alerts {
    return this.l0Alerts;
  }
}

// 匯出閾值常數供測試使用
export {
  SUCCESS_RATE_DROP_THRESHOLD,
  L0_QUOTA_WARNING_THRESHOLD,
  L0_QUOTA_CRITICAL_THRESHOLD,
  AUTO_THROTTLE_RATIO,
};
