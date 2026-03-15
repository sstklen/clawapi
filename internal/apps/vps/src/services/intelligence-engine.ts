// 集體智慧分析引擎
// 負責接收龍蝦上報的遙測批次、每小時聚合分析、路由建議生成
// 信譽加權機制確保老蝦資料更可信，新蝦資料只佔 0.3 倍權重

import { ErrorCode } from '@clawapi/protocol';
import type { TelemetryBatch, TelemetryEntry } from '@clawapi/protocol';
import type { VPSDatabase } from '../storage/database';
import type { Device } from '../storage/database';

// ===== 常數定義 =====

// 支援的服務清單（已知合法的 service_id）
const KNOWN_SERVICES = new Set([
  'groq', 'gemini', 'openai', 'anthropic', 'deepseek',
  'cerebras', 'sambanova', 'qwen', 'ollama',
  'brave-search', 'tavily', 'serper', 'duckduckgo',
  'deepl', 'openrouter',
]);

// 四個地區代碼
const REGIONS = ['asia', 'europe', 'americas', 'other'] as const;
type Region = typeof REGIONS[number];

// 信譽等級門檻（天數 / 批次數）
const REPUTATION_NEW_DAYS = 7;           // 新蝦：< 7 天
const REPUTATION_NEW_BATCH = 10;         // 新蝦：< 10 批
const REPUTATION_OLD_DAYS = 90;          // 老蝦：> 90 天
const REPUTATION_OLD_BATCH = 500;        // 老蝦：> 500 批

// 信譽加權倍數
const WEIGHT_NEW = 0.3;                  // 新蝦：0.3x
const WEIGHT_OLD = 1.5;                  // 老蝦：1.5x
const WEIGHT_NORMAL = 1.0;              // 普通蝦：1.0x
const WEIGHT_ANOMALY_PENALTY = 0.2;     // 每次異常 -0.2
const WEIGHT_MIN = 0.1;                  // 最低權重

// 批次去重快取 TTL（24 小時，毫秒）
const BATCH_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

// 驗證規則
const MAX_ENTRIES_PER_BATCH = 1000;     // 最多 1000 條
const MAX_PERIOD_HOURS = 2;              // 期間跨度最多 2 小時
const MAX_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;  // 容忍 5 分鐘未來時間
const MAX_LATENCY_MS = 300000;           // 最大延遲 300 秒
const MIN_LATENCY_MS = 0;               // 最小延遲 0

// 路由建議判定門檻
const STATUS_PREFERRED_SUCCESS_RATE = 0.95;  // preferred: 成功率 ≥ 95%
const STATUS_PREFERRED_P95_MS = 2000;        // preferred: p95 ≤ 2000ms
const STATUS_DEGRADED_SUCCESS_RATE = 0.70;   // degraded: 成功率 ≥ 70%

// 信心度門檻（使用者數）
const CONFIDENCE_HIGH_USERS = 100;      // > 100 → high
const CONFIDENCE_MEDIUM_USERS = 30;     // 30-100 → medium
const CONFIDENCE_LOW_VALUE = 0.3;
const CONFIDENCE_MEDIUM_VALUE = 0.6;
const CONFIDENCE_HIGH_VALUE = 0.9;

// 最少使用者數（低於此數跳過聚合）
const MIN_USERS_FOR_ANALYSIS = 10;

// 成功率下降警告門檻（15%）
const ALERT_SUCCESS_RATE_DROP = 0.15;

// 每批次每小時上報次數門檻（速率限制）
const RATE_LIMIT_BATCHES_PER_HOUR = 3;

// ===== 型別定義 =====

// 批次去重快取條目
interface BatchCacheEntry {
  deviceId: string;
  receivedAt: number;  // Unix timestamp（毫秒）
}

// 路由建議記錄（對應 routing_recommendations 表）
export interface RoutingRecommendation {
  recommendation_id: string;
  service_id: string;
  region: string;
  status: 'preferred' | 'degraded' | 'avoid';
  confidence: number;
  success_rate: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  sample_size: number;
  note?: string;
  generated_at: string;
  valid_until: string;
}

// 聚合計算中間結果
interface ServiceRegionMetrics {
  service_id: string;
  region: string;
  weighted_success_sum: number;    // 加權成功次數
  total_weight: number;            // 總權重
  success_latencies: number[];     // 成功請求的延遲列表（用於計算 p95）
  weighted_latency_sum: number;    // 加權延遲總和
  unique_devices: Set<string>;     // 唯一裝置集合（計算信心度用）
}

// 回饋請求
export interface FeedbackPayload {
  recommendation_id: string;
  service_id: string;
  feedback: 'positive' | 'negative';
  reason?: string;
  comment?: string;
}

// 接收批次結果
export interface ReceiveBatchResult {
  success: boolean;
  batch_id: string;
  entries_stored: number;
  reputation_weight: number;
}

// 每小時分析結果摘要
export interface HourlyAnalysisResult {
  recommendations_generated: number;
  alerts_fired: number;
  services_analyzed: number;
}

// 冷啟動結果
export interface ColdStartResult {
  recommendations_loaded: number;
  source: '24hr_aggregate' | 'empty';
}

// 遙測條目 DB 記錄格式
interface TelemetryEntryRow {
  batch_id: string;
  device_id: string;
  region: string;
  service_id: string;
  model: string | null;
  tier: string;
  outcome: string;
  latency_ms: number | null;
  token_input: number | null;
  token_output: number | null;
  routing_strategy: string | null;
  retry_count: number;
  time_bucket: string | null;
  reputation_weight: number;
  received_at: string;
}

// 路由建議 DB 記錄格式
interface RoutingRecommendationRow {
  recommendation_id: string;
  service_id: string;
  region: string;
  status: string;
  confidence: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  sample_size: number | null;
  note: string | null;
  generated_at: string;
  valid_until: string;
}

// ===== IntelligenceEngine 主類別 =====

export class IntelligenceEngine {
  private db: VPSDatabase;

  // batch_id 去重快取：Map<batch_id, BatchCacheEntry>
  // 採記憶體快取（24hr TTL），重啟後自動清空（重複上報會被 DB UNIQUE 約束攔截）
  private batchDedupeCache: Map<string, BatchCacheEntry> = new Map();

  // 每小時分析定時器
  private hourlyTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: VPSDatabase) {
    this.db = db;
  }

  // ===== 1. receiveBatch — 接收遙測批次 =====

  // 接收並儲存龍蝦上報的遙測批次
  // 包含：解碼 → 去重 → 驗證 → 信譽加權 → 寫入 DB
  async receiveBatch(
    deviceId: string,
    batchData: unknown,
  ): Promise<ReceiveBatchResult> {
    // === 1.1 解碼（目前只支援 JSON，MessagePack 留給 v2）===
    const batch = this.decodeBatch(batchData);

    // === 1.2 batch_id 去重（記憶體 + DB 雙重保障）===
    this.cleanExpiredBatchCache();
    if (this.batchDedupeCache.has(batch.batch_id)) {
      const err = new Error(`重複的 batch_id: ${batch.batch_id}`);
      (err as Error & { errorCode: ErrorCode }).errorCode = ErrorCode.TELEMETRY_DUPLICATE_BATCH;
      throw err;
    }

    // === 1.3 Schema 驗證 ===
    this.validateBatch(batch);

    // === 1.4 取得裝置資料，計算信譽加權 ===
    const device = this.db.getDevice(deviceId);
    const reputationWeight = this.calculateReputationWeight(device);

    // === 1.5 取得裝置地區 ===
    const region = device?.assigned_region ?? device?.region ?? 'other';

    // === 1.6 寫入 telemetry_batches 表 ===
    // 使用 INSERT OR IGNORE + 後續檢查，確保 UNIQUE 衝突被轉換為正確錯誤碼
    const successRate = batch.summary?.success_rate ?? null;
    const totalRequests = batch.summary?.total_requests ?? batch.entries.length;

    try {
      this.db.run(
        `INSERT INTO telemetry_batches (
          batch_id, device_id, region, schema_version,
          period_from, period_to, total_requests, success_rate,
          reputation_weight, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          batch.batch_id,
          deviceId,
          region,
          batch.schema_version,
          batch.period.from,
          batch.period.to,
          totalRequests,
          successRate,
          reputationWeight,
        ],
      );
    } catch (e) {
      // SQLite UNIQUE 衝突 → 轉換為重複 batch 錯誤
      if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
        const err = new Error(`重複的 batch_id: ${batch.batch_id}`);
        (err as Error & { errorCode: ErrorCode }).errorCode = ErrorCode.TELEMETRY_DUPLICATE_BATCH;
        throw err;
      }
      throw e;
    }

    // === 1.7 批次寫入 telemetry_entries 表 ===
    let entriesStored = 0;
    for (const entry of batch.entries) {
      // 只存 KNOWN_SERVICES 中的 service_id（驗證已在 validateBatch 做過）
      this.db.run(
        `INSERT INTO telemetry_entries (
          batch_id, device_id, region, service_id,
          model, tier, outcome, latency_ms,
          token_input, token_output, routing_strategy,
          retry_count, time_bucket, reputation_weight, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          batch.batch_id,
          deviceId,
          region,
          entry.service_id,
          entry.model ?? null,
          entry.tier,
          entry.outcome,
          entry.latency_ms,
          entry.token_usage?.input ?? null,
          entry.token_usage?.output ?? null,
          entry.routing_strategy ?? null,
          entry.retry_count ?? 0,
          entry.time_bucket ?? null,
          reputationWeight,
        ],
      );
      entriesStored++;
    }

    // === 1.8 記憶體快取 batch_id（防止短時間內重複上報）===
    this.batchDedupeCache.set(batch.batch_id, {
      deviceId,
      receivedAt: Date.now(),
    });

    return {
      success: true,
      batch_id: batch.batch_id,
      entries_stored: entriesStored,
      reputation_weight: reputationWeight,
    };
  }

  // ===== 2. runHourlyAnalysis — 每小時聚合分析 =====

  // 分析過去 1 小時的遙測數據，產生各地區各服務的路由建議
  // 同時偵測成功率大幅下降並發出 alert
  async runHourlyAnalysis(): Promise<HourlyAnalysisResult> {
    const result: HourlyAnalysisResult = {
      recommendations_generated: 0,
      alerts_fired: 0,
      services_analyzed: 0,
    };

    // === 2.1 取過去 1 小時的遙測條目 ===
    const entries = this.db.query<TelemetryEntryRow>(
      `SELECT te.*, tb.device_id as device_id_from_batch
       FROM telemetry_entries te
       JOIN telemetry_batches tb ON te.batch_id = tb.batch_id
       WHERE te.received_at > datetime('now', '-1 hour')`,
    );

    if (entries.length === 0) {
      return result;
    }

    // === 2.2 建立聚合中間結果 Map<region_service_key, metrics> ===
    const metricsMap = new Map<string, ServiceRegionMetrics>();

    for (const entry of entries) {
      const region = this.normalizeRegion(entry.region);
      const key = `${region}::${entry.service_id}`;

      if (!metricsMap.has(key)) {
        metricsMap.set(key, {
          service_id: entry.service_id,
          region,
          weighted_success_sum: 0,
          total_weight: 0,
          success_latencies: [],
          weighted_latency_sum: 0,
          unique_devices: new Set(),
        });
      }

      const metrics = metricsMap.get(key)!;
      const weight = entry.reputation_weight;

      // 追蹤唯一裝置（信心度計算用）
      metrics.unique_devices.add(entry.device_id);

      // 累計總權重
      metrics.total_weight += weight;

      // 判定成功（outcome === 'success'）
      const isSuccess = entry.outcome === 'success';
      if (isSuccess) {
        metrics.weighted_success_sum += weight;

        // 只計算成功的延遲
        if (entry.latency_ms !== null && entry.latency_ms !== undefined) {
          metrics.success_latencies.push(entry.latency_ms);
          metrics.weighted_latency_sum += entry.latency_ms * weight;
        }
      }
    }

    // === 2.3 取得前一小時的路由建議（用於 alert 比較）===
    const previousRecs = this.db.query<RoutingRecommendationRow>(
      `SELECT * FROM routing_recommendations
       WHERE generated_at > datetime('now', '-2 hours')
         AND generated_at <= datetime('now', '-1 hour')`,
    );
    const previousRecsMap = new Map<string, RoutingRecommendationRow>();
    for (const rec of previousRecs) {
      previousRecsMap.set(`${rec.region}::${rec.service_id}`, rec);
    }

    // === 2.4 產生路由建議 ===
    const now = new Date();
    const generatedAt = now.toISOString();
    // 建議有效期：2 小時後
    const validUntil = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();

    const servicesSeen = new Set<string>();

    for (const [key, metrics] of metricsMap.entries()) {
      const uniqueDeviceCount = metrics.unique_devices.size;

      // 使用者不足 10 人 → 跳過
      if (uniqueDeviceCount < MIN_USERS_FOR_ANALYSIS) {
        continue;
      }

      servicesSeen.add(metrics.service_id);

      // 計算加權成功率
      const successRate = metrics.total_weight > 0
        ? metrics.weighted_success_sum / metrics.total_weight
        : 0;

      // 計算平均延遲（只算成功的）
      const avgLatencyMs = metrics.success_latencies.length > 0
        ? Math.round(
            metrics.success_latencies.reduce((sum, v) => sum + v, 0) /
            metrics.success_latencies.length,
          )
        : 0;

      // 計算 p95 延遲（排序取 95%）
      const p95LatencyMs = this.calculateP95(metrics.success_latencies);

      // 判定路由狀態
      let status: 'preferred' | 'degraded' | 'avoid';
      if (successRate >= STATUS_PREFERRED_SUCCESS_RATE && p95LatencyMs <= STATUS_PREFERRED_P95_MS) {
        status = 'preferred';
      } else if (successRate >= STATUS_DEGRADED_SUCCESS_RATE) {
        status = 'degraded';
      } else {
        status = 'avoid';
      }

      // 計算信心度（依唯一裝置數）
      let confidence: number;
      if (uniqueDeviceCount > CONFIDENCE_HIGH_USERS) {
        confidence = CONFIDENCE_HIGH_VALUE;
      } else if (uniqueDeviceCount >= CONFIDENCE_MEDIUM_USERS) {
        confidence = CONFIDENCE_MEDIUM_VALUE;
      } else {
        confidence = CONFIDENCE_LOW_VALUE;
      }

      // 產生唯一建議 ID
      const recommendationId = `rec_${metrics.region}_${metrics.service_id}_${now.getTime()}`;

      // 寫入 routing_recommendations 表
      this.db.run(
        `INSERT OR REPLACE INTO routing_recommendations (
          recommendation_id, service_id, region, status,
          confidence, success_rate, avg_latency_ms, p95_latency_ms,
          sample_size, generated_at, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          recommendationId,
          metrics.service_id,
          metrics.region,
          status,
          confidence,
          successRate,
          avgLatencyMs,
          p95LatencyMs,
          uniqueDeviceCount,
          generatedAt,
          validUntil,
        ],
      );
      result.recommendations_generated++;

      // === 2.5 成功率下降警告（與前一小時比較）===
      const prevKey = key;
      const prevRec = previousRecsMap.get(prevKey);
      if (prevRec && prevRec.success_rate !== null) {
        const drop = prevRec.success_rate - successRate;
        if (drop > ALERT_SUCCESS_RATE_DROP) {
          // 寫入 service_alerts
          this.db.run(
            `INSERT INTO service_alerts (severity, service_id, region, message, started_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [
              'warning',
              metrics.service_id,
              metrics.region,
              `成功率從 ${(prevRec.success_rate * 100).toFixed(1)}% 下降至 ${(successRate * 100).toFixed(1)}%（下降 ${(drop * 100).toFixed(1)}%）`,
            ],
          );
          result.alerts_fired++;
        }
      }
    }

    result.services_analyzed = servicesSeen.size;

    // === 2.6 清理過期去重快取 ===
    this.cleanExpiredBatchCache();

    return result;
  }

  // ===== 3. getRouteSuggestions — 取得路由建議 =====

  // 回傳最新的路由建議，可按地區篩選
  // region 未指定時回傳所有地區
  getRouteSuggestions(region?: string): RoutingRecommendationRow[] {
    if (region) {
      const normalizedRegion = this.normalizeRegion(region);
      return this.db.query<RoutingRecommendationRow>(
        `SELECT * FROM routing_recommendations
         WHERE region = ?
           AND valid_until > datetime('now')
         ORDER BY generated_at DESC, confidence DESC`,
        [normalizedRegion],
      );
    }

    return this.db.query<RoutingRecommendationRow>(
      `SELECT * FROM routing_recommendations
       WHERE valid_until > datetime('now')
       ORDER BY generated_at DESC, region, confidence DESC`,
    );
  }

  // ===== 4. handleFeedback — 路由回饋 =====

  // 接收龍蝦對路由建議的回饋
  // positive → confidence +5%（上限 0.99）
  // negative → confidence -10%（下限 0.01）
  async handleFeedback(
    deviceId: string,
    feedback: FeedbackPayload,
  ): Promise<{ success: boolean }> {
    // === 4.1 寫入 telemetry_feedback 表 ===
    this.db.run(
      `INSERT INTO telemetry_feedback (
        device_id, recommendation_id, service_id, feedback, reason, comment, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        deviceId,
        feedback.recommendation_id,
        feedback.service_id,
        feedback.feedback,
        feedback.reason ?? null,
        feedback.comment ?? null,
      ],
    );

    // === 4.2 更新 routing_recommendations.confidence ===
    // 找到目標建議（依 recommendation_id，若無指定則依 service_id 取最新）
    const targetRec = feedback.recommendation_id
      ? this.db.query<RoutingRecommendationRow>(
          'SELECT * FROM routing_recommendations WHERE recommendation_id = ?',
          [feedback.recommendation_id],
        )[0]
      : this.db.query<RoutingRecommendationRow>(
          `SELECT * FROM routing_recommendations
           WHERE service_id = ?
           ORDER BY generated_at DESC LIMIT 1`,
          [feedback.service_id],
        )[0];

    if (targetRec) {
      const delta = feedback.feedback === 'positive' ? 0.05 : -0.10;
      const newConfidence = Math.min(0.99, Math.max(0.01, targetRec.confidence + delta));

      this.db.run(
        `UPDATE routing_recommendations
         SET confidence = ?
         WHERE recommendation_id = ?`,
        [newConfidence, targetRec.recommendation_id],
      );
    }

    // === 4.3 更新 feedback_aggregation 表（按小時聚合）===
    const periodHour = new Date().toISOString().slice(0, 13) + ':00:00Z';
    const region = targetRec?.region ?? 'global';

    if (feedback.feedback === 'positive') {
      this.db.run(
        `INSERT INTO feedback_aggregation (service_id, region, period_hour, positive_count, negative_count)
         VALUES (?, ?, ?, 1, 0)
         ON CONFLICT (service_id, region, period_hour)
         DO UPDATE SET positive_count = positive_count + 1`,
        [feedback.service_id, region, periodHour],
      );
    } else {
      this.db.run(
        `INSERT INTO feedback_aggregation (service_id, region, period_hour, positive_count, negative_count)
         VALUES (?, ?, ?, 0, 1)
         ON CONFLICT (service_id, region, period_hour)
         DO UPDATE SET negative_count = negative_count + 1`,
        [feedback.service_id, region, periodHour],
      );
    }

    return { success: true };
  }

  // ===== 5. coldStart — 冷啟動 =====

  // VPS 重啟後從 24hr 聚合數據產生過渡建議
  // 確保重啟後立即有路由建議可用，不需等下一次小時分析
  async coldStart(): Promise<ColdStartResult> {
    // === 5.1 檢查是否有近 24hr 的聚合數據 ===
    const recentAggregated = this.db.query<{
      provider: string;
      model: string | null;
      region: string;
      success_rate: number;
      latency_p95: number;
      sample_count: number;
      aggregated_at: string;
    }>(
      `SELECT * FROM telemetry_aggregated
       WHERE aggregated_at > datetime('now', '-24 hours')
       ORDER BY aggregated_at DESC`,
    );

    if (recentAggregated.length === 0) {
      // 沒有歷史數據，檢查 routing_recommendations 是否還有有效的建議
      const validRecs = this.db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM routing_recommendations
         WHERE valid_until > datetime('now')`,
      );

      if ((validRecs[0]?.count ?? 0) > 0) {
        return { recommendations_loaded: validRecs[0]!.count, source: '24hr_aggregate' };
      }

      return { recommendations_loaded: 0, source: 'empty' };
    }

    // === 5.2 從聚合數據產生過渡建議 ===
    const now = new Date();
    const generatedAt = now.toISOString();
    // 過渡建議有效期：2 小時（等待第一次小時分析完成後會被覆蓋）
    const validUntil = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();

    let loaded = 0;

    // 依 provider + region 分組取最新聚合
    const providerRegionMap = new Map<string, typeof recentAggregated[0]>();
    for (const row of recentAggregated) {
      const key = `${row.region}::${row.provider}`;
      if (!providerRegionMap.has(key)) {
        providerRegionMap.set(key, row);
      }
    }

    for (const [, row] of providerRegionMap.entries()) {
      // 判定狀態
      let status: 'preferred' | 'degraded' | 'avoid';
      if (row.success_rate >= STATUS_PREFERRED_SUCCESS_RATE && row.latency_p95 <= STATUS_PREFERRED_P95_MS) {
        status = 'preferred';
      } else if (row.success_rate >= STATUS_DEGRADED_SUCCESS_RATE) {
        status = 'degraded';
      } else {
        status = 'avoid';
      }

      // 冷啟動來自歷史數據，信心度固定為 low
      const confidence = CONFIDENCE_LOW_VALUE;
      const recommendationId = `rec_cold_${row.region}_${row.provider}_${now.getTime()}`;

      this.db.run(
        `INSERT OR IGNORE INTO routing_recommendations (
          recommendation_id, service_id, region, status,
          confidence, success_rate, avg_latency_ms, p95_latency_ms,
          sample_size, note, generated_at, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          recommendationId,
          row.provider,
          row.region,
          status,
          confidence,
          row.success_rate,
          row.latency_p95,  // 冷啟動無法區分平均和 p95，用同一值
          row.latency_p95,
          row.sample_count,
          '冷啟動過渡建議（來自 24hr 聚合）',
          generatedAt,
          validUntil,
        ],
      );
      loaded++;
    }

    return { recommendations_loaded: loaded, source: '24hr_aggregate' };
  }

  // ===== 定時器管理 =====

  // 啟動每小時自動分析定時器
  startHourlyAnalysis(): void {
    if (this.hourlyTimer) return;
    this.hourlyTimer = setInterval(async () => {
      try {
        await this.runHourlyAnalysis();
      } catch (err) {
        console.error('[IntelligenceEngine] 每小時分析失敗:', err);
      }
    }, 60 * 60 * 1000);
  }

  // 停止定時器
  stopHourlyAnalysis(): void {
    if (this.hourlyTimer) {
      clearInterval(this.hourlyTimer);
      this.hourlyTimer = null;
    }
  }

  // ===== 工具方法（公開，供測試 mock 覆蓋）=====

  // 計算裝置的信譽加權
  // 新蝦（< 7天 或 < 10批）→ 0.3x
  // 老蝦（> 90天 且 > 500批）→ 1.5x
  // 普通蝦 → 1.0x
  // 每次異常 -0.2，最低 0.1
  calculateReputationWeight(device: Device | null): number {
    if (!device) return WEIGHT_NEW;

    const createdAt = new Date(device.created_at);
    const now = new Date();
    const daysSinceCreated = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

    // 查詢該裝置的上報批次數
    const batchCountResult = this.db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM telemetry_batches WHERE device_id = ?',
      [device.device_id],
    );
    const batchCount = batchCountResult[0]?.count ?? 0;

    // 判定基礎信譽等級
    let baseWeight: number;
    if (daysSinceCreated < REPUTATION_NEW_DAYS || batchCount < REPUTATION_NEW_BATCH) {
      baseWeight = WEIGHT_NEW;
    } else if (daysSinceCreated > REPUTATION_OLD_DAYS && batchCount > REPUTATION_OLD_BATCH) {
      baseWeight = WEIGHT_OLD;
    } else {
      baseWeight = WEIGHT_NORMAL;
    }

    // 套用異常懲罰
    const anomalyPenalty = (device.anomaly_count ?? 0) * WEIGHT_ANOMALY_PENALTY;
    const finalWeight = Math.max(WEIGHT_MIN, baseWeight - anomalyPenalty);

    return finalWeight;
  }

  // ===== 私有工具方法 =====

  // 解碼批次資料（只支援 JSON，MessagePack 留 v2）
  private decodeBatch(batchData: unknown): TelemetryBatch {
    if (typeof batchData !== 'object' || batchData === null) {
      const err = new Error('批次資料格式錯誤：必須為 JSON 物件');
      (err as Error & { errorCode: ErrorCode }).errorCode = ErrorCode.TELEMETRY_INVALID_SCHEMA;
      throw err;
    }
    return batchData as TelemetryBatch;
  }

  // 驗證批次資料合法性
  // 任何驗證失敗都拋出帶 TELEMETRY_INVALID_SCHEMA 的 Error
  private validateBatch(batch: TelemetryBatch): void {
    const throwInvalid = (msg: string) => {
      const err = new Error(msg);
      (err as Error & { errorCode: ErrorCode }).errorCode = ErrorCode.TELEMETRY_INVALID_SCHEMA;
      throw err;
    };

    // schema_version ≥ 1
    if (!batch.schema_version || batch.schema_version < 1) {
      throwInvalid('schema_version 必須 ≥ 1');
    }

    // batch_id 必須存在
    if (!batch.batch_id || typeof batch.batch_id !== 'string') {
      throwInvalid('batch_id 必須為非空字串');
    }

    // entries 必須存在且 ≤ 1000
    if (!Array.isArray(batch.entries)) {
      throwInvalid('entries 必須為陣列');
    }
    if (batch.entries.length > MAX_ENTRIES_PER_BATCH) {
      const err = new Error(`entries 超過上限（${batch.entries.length} > ${MAX_ENTRIES_PER_BATCH}）`);
      (err as Error & { errorCode: ErrorCode }).errorCode = ErrorCode.TELEMETRY_BATCH_TOO_LARGE;
      throw err;
    }

    // period 驗證
    if (!batch.period?.from || !batch.period?.to) {
      throwInvalid('period.from 和 period.to 必須存在');
    }

    const periodFrom = new Date(batch.period.from);
    const periodTo = new Date(batch.period.to);

    if (isNaN(periodFrom.getTime()) || isNaN(periodTo.getTime())) {
      throwInvalid('period 時間格式無效');
    }

    // period 跨度 ≤ 2 小時
    const periodSpanMs = periodTo.getTime() - periodFrom.getTime();
    if (periodSpanMs > MAX_PERIOD_HOURS * 60 * 60 * 1000) {
      throwInvalid(`period 跨度超過 ${MAX_PERIOD_HOURS} 小時`);
    }

    // period.to 不得在未來（容忍 5 分鐘）
    const now = new Date();
    if (periodTo.getTime() > now.getTime() + MAX_FUTURE_TOLERANCE_MS) {
      throwInvalid('period.to 不得在未來時間');
    }

    // 驗證每個 entry
    for (const entry of batch.entries) {
      this.validateEntry(entry);
    }
  }

  // 驗證單一遙測條目
  private validateEntry(entry: TelemetryEntry): void {
    const throwInvalid = (msg: string) => {
      const err = new Error(msg);
      (err as Error & { errorCode: ErrorCode }).errorCode = ErrorCode.TELEMETRY_INVALID_SCHEMA;
      throw err;
    };

    // service_id 必須在已知清單中
    if (!entry.service_id || !KNOWN_SERVICES.has(entry.service_id)) {
      throwInvalid(`未知的 service_id: ${entry.service_id}`);
    }

    // latency_ms 範圍：0-300000
    if (
      entry.latency_ms !== undefined &&
      (entry.latency_ms < MIN_LATENCY_MS || entry.latency_ms > MAX_LATENCY_MS)
    ) {
      throwInvalid(`latency_ms 超出範圍（${entry.latency_ms}），必須在 0-300000 之間`);
    }
  }

  // 清理過期的 batch_id 快取（TTL 24hr）
  private cleanExpiredBatchCache(): void {
    const now = Date.now();
    const cutoff = now - BATCH_DEDUP_TTL_MS;
    for (const [batchId, entry] of this.batchDedupeCache.entries()) {
      if (entry.receivedAt < cutoff) {
        this.batchDedupeCache.delete(batchId);
      }
    }
  }

  // 計算 p95 延遲
  // 傳入延遲列表，排序後取第 95 百分位
  private calculateP95(latencies: number[]): number {
    if (latencies.length === 0) return 0;

    const sorted = [...latencies].sort((a, b) => a - b);
    // p95 索引：Math.ceil(n * 0.95) - 1，至少取第一個
    const p95Index = Math.min(
      Math.ceil(sorted.length * 0.95) - 1,
      sorted.length - 1,
    );
    return sorted[Math.max(0, p95Index)]!;
  }

  // 將地區字串正規化為 4 個標準值之一
  private normalizeRegion(region: string | undefined | null): Region {
    if (!region) return 'other';
    const lower = region.toLowerCase();
    if (lower === 'asia' || lower === 'europe' || lower === 'americas') {
      return lower as Region;
    }
    return 'other';
  }

  // 供測試存取去重快取（測試用）
  _getBatchCacheSize(): number {
    return this.batchDedupeCache.size;
  }

  // 直接向快取注入 batch_id（測試用）
  _injectBatchCache(batchId: string, deviceId: string, receivedAt?: number): void {
    this.batchDedupeCache.set(batchId, {
      deviceId,
      receivedAt: receivedAt ?? Date.now(),
    });
  }
}

// 匯出常數供測試使用
export {
  KNOWN_SERVICES,
  WEIGHT_NEW,
  WEIGHT_OLD,
  WEIGHT_NORMAL,
  REPUTATION_NEW_DAYS,
  REPUTATION_NEW_BATCH,
  REPUTATION_OLD_DAYS,
  REPUTATION_OLD_BATCH,
  MIN_USERS_FOR_ANALYSIS,
  STATUS_PREFERRED_SUCCESS_RATE,
  STATUS_PREFERRED_P95_MS,
  STATUS_DEGRADED_SUCCESS_RATE,
  RATE_LIMIT_BATCHES_PER_HOUR,
};
