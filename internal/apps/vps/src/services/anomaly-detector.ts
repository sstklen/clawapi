// 異常偵測服務
// 負責分析龍蝦上報的遙測批次是否有異常行為
// 4 條規則：矛盾數據、延遲離群、上報頻率異常、新帳號大量數據
// 動作：reasons ≥ 3 → suspend，≥ 1 → downweight

import type { TelemetryBatch } from '@clawapi/protocol';
import type { VPSDatabase } from '../storage/database';

// ===== 型別定義 =====

// 全體統計數據（從近期遙測聚合而來）
export interface GlobalStats {
  // 每個服務的全體成功率：Map<service_id, success_rate>
  serviceSuccessRates: Map<string, number>;
  // 每個服務的全體 p95 延遲：Map<service_id, p95_latency_ms>
  serviceP95Latencies: Map<string, number>;
  // 各服務的全體樣本數：Map<service_id, sample_count>
  serviceSampleCounts: Map<string, number>;
}

// 異常理由
export interface AnomalyReason {
  rule: 'contradicts_majority' | 'latency_outlier' | 'excessive_frequency' | 'new_account_bulk';
  description: string;
  evidence: string;
}

// 異常偵測報告
export interface AnomalyReport {
  deviceId: string;
  hasAnomaly: boolean;
  reasons: AnomalyReason[];
  // 判定動作
  action: 'none' | 'downweight' | 'suspend';
  // 建議的新信譽加權（downweight 時使用）
  suggestedWeight?: number;
}

// 遙測批次記錄（查 DB 用）
interface BatchCountRow {
  count: number;
}

// ===== 門檻常數 =====

// 規則 1：與多數人矛盾
// 本批次成功率 < 此值 且 全體成功率 > GLOBAL_SUCCESS_HIGH
const LOCAL_SUCCESS_LOW = 0.5;
const GLOBAL_SUCCESS_HIGH = 0.9;
// 需要足夠樣本才觸發（全體 > 50）
const MIN_GLOBAL_SAMPLE_FOR_CONTRADICTION = 50;
// 本批次條目數門檻（至少 5 條才做比對）
const MIN_LOCAL_ENTRIES = 5;

// 規則 2：延遲離群
// 本批次 p95 > 全體 p95 × 此倍數
const LATENCY_OUTLIER_MULTIPLIER = 5;

// 規則 3：上報頻率異常
// 1 小時內超過此次數視為異常
const MAX_BATCHES_PER_HOUR = 3;

// 規則 4：新帳號大量數據
// 帳號建立 < 此天數 且 上報條目數 > MAX_ENTRIES_NEW_ACCOUNT
const NEW_ACCOUNT_DAYS = 3;
const MAX_ENTRIES_NEW_ACCOUNT = 500;

// ===== AnomalyDetector 主類別 =====

export class AnomalyDetector {
  private db: VPSDatabase;

  constructor(db: VPSDatabase) {
    this.db = db;
  }

  // 對一個遙測批次做異常偵測
  // 回傳 AnomalyReport，包含所有觸發的規則和建議動作
  detect(
    batch: TelemetryBatch,
    deviceId: string,
    globalStats: GlobalStats,
  ): AnomalyReport {
    const reasons: AnomalyReason[] = [];

    // === 規則 1：與多數人矛盾 ===
    const contradictionReason = this.checkContradictsMajority(batch, globalStats);
    if (contradictionReason) reasons.push(contradictionReason);

    // === 規則 2：延遲離群 ===
    const latencyReason = this.checkLatencyOutlier(batch, globalStats);
    if (latencyReason) reasons.push(latencyReason);

    // === 規則 3：上報頻率異常 ===
    const frequencyReason = this.checkExcessiveFrequency(deviceId);
    if (frequencyReason) reasons.push(frequencyReason);

    // === 規則 4：新帳號大量數據 ===
    const bulkReason = this.checkNewAccountBulk(batch, deviceId);
    if (bulkReason) reasons.push(bulkReason);

    // === 判定動作 ===
    let action: AnomalyReport['action'];
    if (reasons.length >= 3) {
      action = 'suspend';
    } else if (reasons.length >= 1) {
      action = 'downweight';
    } else {
      action = 'none';
    }

    // downweight 時建議降低信譽加權
    let suggestedWeight: number | undefined;
    if (action === 'downweight') {
      suggestedWeight = 0.3;
    }

    // 有異常則寫入 anomaly_detections 表
    if (reasons.length > 0) {
      this.recordAnomaly(deviceId, action, reasons);
      // 若需要 suspend，更新裝置狀態
      if (action === 'suspend') {
        this.suspendDevice(deviceId, reasons);
      }
    }

    return {
      deviceId,
      hasAnomaly: reasons.length > 0,
      reasons,
      action,
      suggestedWeight,
    };
  }

  // ===== 私有規則實作 =====

  // 規則 1：與多數人矛盾
  // 條件：本批次成功率 < 50%，但全體該服務成功率 > 90%，且全體樣本 > 50
  private checkContradictsMajority(
    batch: TelemetryBatch,
    globalStats: GlobalStats,
  ): AnomalyReason | null {
    if (batch.entries.length < MIN_LOCAL_ENTRIES) return null;

    // 計算本批次各服務的成功率
    const serviceStats = new Map<string, { success: number; total: number }>();

    for (const entry of batch.entries) {
      if (!serviceStats.has(entry.service_id)) {
        serviceStats.set(entry.service_id, { success: 0, total: 0 });
      }
      const stat = serviceStats.get(entry.service_id)!;
      stat.total++;
      if (entry.outcome === 'success') stat.success++;
    }

    // 對每個服務比對
    for (const [serviceId, stat] of serviceStats.entries()) {
      if (stat.total < MIN_LOCAL_ENTRIES) continue;

      const localSuccessRate = stat.success / stat.total;
      const globalSuccessRate = globalStats.serviceSuccessRates.get(serviceId);
      const globalSampleCount = globalStats.serviceSampleCounts.get(serviceId) ?? 0;

      if (
        globalSuccessRate !== undefined &&
        globalSampleCount > MIN_GLOBAL_SAMPLE_FOR_CONTRADICTION &&
        localSuccessRate < LOCAL_SUCCESS_LOW &&
        globalSuccessRate > GLOBAL_SUCCESS_HIGH
      ) {
        return {
          rule: 'contradicts_majority',
          description: `服務 ${serviceId} 本批次成功率與全體相差過大`,
          evidence: `本批次成功率 ${(localSuccessRate * 100).toFixed(1)}%，全體 ${(globalSuccessRate * 100).toFixed(1)}%（樣本 ${globalSampleCount}）`,
        };
      }
    }

    return null;
  }

  // 規則 2：延遲離群
  // 條件：本批次 p95 > 全體 p95 × 5 倍
  private checkLatencyOutlier(
    batch: TelemetryBatch,
    globalStats: GlobalStats,
  ): AnomalyReason | null {
    if (batch.entries.length < MIN_LOCAL_ENTRIES) return null;

    // 計算本批次各服務的 p95 延遲
    const serviceLatencies = new Map<string, number[]>();

    for (const entry of batch.entries) {
      if (entry.latency_ms === undefined || entry.latency_ms === null) continue;
      if (!serviceLatencies.has(entry.service_id)) {
        serviceLatencies.set(entry.service_id, []);
      }
      serviceLatencies.get(entry.service_id)!.push(entry.latency_ms);
    }

    for (const [serviceId, latencies] of serviceLatencies.entries()) {
      if (latencies.length < MIN_LOCAL_ENTRIES) continue;

      const localP95 = this.calculateP95(latencies);
      const globalP95 = globalStats.serviceP95Latencies.get(serviceId);

      if (
        globalP95 !== undefined &&
        globalP95 > 0 &&
        localP95 > globalP95 * LATENCY_OUTLIER_MULTIPLIER
      ) {
        return {
          rule: 'latency_outlier',
          description: `服務 ${serviceId} 本批次 p95 延遲遠超全體`,
          evidence: `本批次 p95 ${localP95}ms，全體 p95 ${globalP95}ms（超出 ${LATENCY_OUTLIER_MULTIPLIER}x 門檻）`,
        };
      }
    }

    return null;
  }

  // 規則 3：上報頻率異常
  // 條件：同一裝置 1 小時內上報 > 3 次
  private checkExcessiveFrequency(deviceId: string): AnomalyReason | null {
    const result = this.db.query<BatchCountRow>(
      `SELECT COUNT(*) as count FROM telemetry_batches
       WHERE device_id = ?
         AND received_at > datetime('now', '-1 hour')`,
      [deviceId],
    );

    const batchCount = result[0]?.count ?? 0;

    if (batchCount > MAX_BATCHES_PER_HOUR) {
      return {
        rule: 'excessive_frequency',
        description: '上報頻率過高',
        evidence: `1 小時內已上報 ${batchCount} 次（上限 ${MAX_BATCHES_PER_HOUR}）`,
      };
    }

    return null;
  }

  // 規則 4：新帳號大量數據
  // 條件：帳號建立 < 3 天，且本次批次 + 歷史累計 > 500 條
  private checkNewAccountBulk(
    batch: TelemetryBatch,
    deviceId: string,
  ): AnomalyReason | null {
    // 查詢裝置建立時間
    const deviceResult = this.db.query<{ created_at: string }>(
      'SELECT created_at FROM devices WHERE device_id = ?',
      [deviceId],
    );

    if (deviceResult.length === 0) return null;

    const deviceCreatedAt = new Date(deviceResult[0]!.created_at);
    const now = new Date();
    const daysSinceCreated =
      (now.getTime() - deviceCreatedAt.getTime()) / (1000 * 60 * 60 * 24);

    // 帳號超過 3 天 → 不觸發此規則
    if (daysSinceCreated >= NEW_ACCOUNT_DAYS) return null;

    // 計算已上報的總條目數
    const existingResult = this.db.query<BatchCountRow>(
      `SELECT COALESCE(SUM(total_requests), 0) as count
       FROM telemetry_batches
       WHERE device_id = ?`,
      [deviceId],
    );

    const existingEntries = existingResult[0]?.count ?? 0;
    const totalEntries = existingEntries + batch.entries.length;

    if (totalEntries > MAX_ENTRIES_NEW_ACCOUNT) {
      return {
        rule: 'new_account_bulk',
        description: '新帳號上報大量數據',
        evidence: `帳號建立 ${daysSinceCreated.toFixed(1)} 天，累計上報 ${totalEntries} 條（上限 ${MAX_ENTRIES_NEW_ACCOUNT}）`,
      };
    }

    return null;
  }

  // 計算 p95 延遲（工具方法）
  private calculateP95(latencies: number[]): number {
    if (latencies.length === 0) return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95Index = Math.min(
      Math.ceil(sorted.length * 0.95) - 1,
      sorted.length - 1,
    );
    return sorted[Math.max(0, p95Index)]!;
  }

  // 將異常記錄寫入 anomaly_detections 表
  private recordAnomaly(
    deviceId: string,
    action: AnomalyReport['action'],
    reasons: AnomalyReason[],
  ): void {
    const anomalyType = reasons.map((r) => r.rule).join(',');
    const reasonsText = reasons.map((r) => r.evidence).join(' | ');

    this.db.run(
      `INSERT INTO anomaly_detections (device_id, anomaly_type, reasons, action_taken, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [deviceId, anomalyType, reasonsText, action],
    );

    // 更新裝置的 anomaly_count
    this.db.run(
      `UPDATE devices
       SET anomaly_count = anomaly_count + 1, updated_at = datetime('now')
       WHERE device_id = ?`,
      [deviceId],
    );
  }

  // 暫停裝置（suspend 動作）
  private suspendDevice(deviceId: string, reasons: AnomalyReason[]): void {
    const suspendReason = `異常行為（${reasons.length} 條規則觸發）：${reasons.map((r) => r.rule).join(', ')}`;

    this.db.run(
      `UPDATE devices
       SET status = 'suspended',
           suspended_reason = ?,
           updated_at = datetime('now')
       WHERE device_id = ?`,
      [suspendReason, deviceId],
    );

    console.warn(`[AnomalyDetector] 裝置 ${deviceId} 已被暫停：${suspendReason}`);
  }
}

// 匯出常數供測試使用
export {
  LOCAL_SUCCESS_LOW,
  GLOBAL_SUCCESS_HIGH,
  MIN_GLOBAL_SAMPLE_FOR_CONTRADICTION,
  LATENCY_OUTLIER_MULTIPLIER,
  MAX_BATCHES_PER_HOUR,
  NEW_ACCOUNT_DAYS,
  MAX_ENTRIES_NEW_ACCOUNT,
};
