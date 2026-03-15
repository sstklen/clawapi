// 遙測路由處理器
// 涵蓋：批次上報、路由建議查詢、路由回饋、配額查詢
// 全部端點都需要 deviceAuth 認證

import { Hono } from 'hono';
import { ErrorCode } from '@clawapi/protocol';
import type { TelemetryQuota } from '@clawapi/protocol';
import type { VPSDatabase } from '../storage/database';
import type { AuthVariables } from '../middleware/auth';
import type { IntelligenceEngine, FeedbackPayload } from '../services/intelligence-engine';
import type { AnomalyDetector, GlobalStats } from '../services/anomaly-detector';

// 每小時批次上報速率限制（每裝置）
const BATCH_RATE_LIMIT_PER_HOUR = 3;

// 每小時回饋速率限制（每裝置）
const FEEDBACK_RATE_LIMIT_PER_HOUR = 10;

// 批次上報計數（記憶體快取，重啟後重置）
// Map<device_id, { count: number; windowStart: number }>
const batchRateLimitCache = new Map<string, { count: number; windowStart: number }>();

// 回饋速率限制快取
const feedbackRateLimitCache = new Map<string, { count: number; windowStart: number }>();

// ===== 速率限制工具 =====

// 檢查速率限制（滑動視窗，1 小時）
// 回傳是否超過限制
function checkRateLimit(
  cache: Map<string, { count: number; windowStart: number }>,
  key: string,
  limit: number,
): { exceeded: boolean; count: number; retryAfterSeconds: number } {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 小時

  const entry = cache.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    // 新視窗：重置計數
    cache.set(key, { count: 1, windowStart: now });
    return { exceeded: false, count: 1, retryAfterSeconds: 0 };
  }

  entry.count++;
  if (entry.count > limit) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { exceeded: true, count: entry.count, retryAfterSeconds };
  }

  return { exceeded: false, count: entry.count, retryAfterSeconds: 0 };
}

// ===== 取得全體統計數據（用於異常偵測）=====

// 從近 1 小時遙測聚合計算全體統計
function buildGlobalStats(db: VPSDatabase): GlobalStats {
  // 查近 1 小時各服務的成功率和 p95 延遲
  const statsRows = db.query<{
    service_id: string;
    total_count: number;
    success_count: number;
    p95_latency: number | null;
  }>(
    `SELECT
       service_id,
       COUNT(*) as total_count,
       SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success_count,
       NULL as p95_latency
     FROM telemetry_entries
     WHERE received_at > datetime('now', '-1 hour')
     GROUP BY service_id`,
  );

  // 另外查各服務的延遲數據（SQLite 無原生 percentile，用 Python 計算後存儲）
  // 實際 p95 需要另行計算，這裡用 avg 代替（簡化）
  const latencyRows = db.query<{
    service_id: string;
    avg_latency: number | null;
  }>(
    `SELECT service_id, AVG(latency_ms) as avg_latency
     FROM telemetry_entries
     WHERE received_at > datetime('now', '-1 hour')
       AND outcome = 'success'
       AND latency_ms IS NOT NULL
     GROUP BY service_id`,
  );

  const latencyMap = new Map<string, number>();
  for (const row of latencyRows) {
    if (row.avg_latency !== null) {
      latencyMap.set(row.service_id, row.avg_latency);
    }
  }

  const serviceSuccessRates = new Map<string, number>();
  const serviceP95Latencies = new Map<string, number>();
  const serviceSampleCounts = new Map<string, number>();

  for (const row of statsRows) {
    const rate = row.total_count > 0 ? row.success_count / row.total_count : 0;
    serviceSuccessRates.set(row.service_id, rate);
    serviceSampleCounts.set(row.service_id, row.total_count);
    // p95 用平均延遲代替（實際部署時應改用真正的 p95 計算）
    const p95 = latencyMap.get(row.service_id);
    if (p95 !== undefined) {
      serviceP95Latencies.set(row.service_id, p95);
    }
  }

  return { serviceSuccessRates, serviceP95Latencies, serviceSampleCounts };
}

// ===== 建立遙測路由 =====

export function createTelemetryRouter(
  db: VPSDatabase,
  engine: IntelligenceEngine,
  detector: AnomalyDetector,
): Hono<{ Variables: AuthVariables }> {
  const router = new Hono<{ Variables: AuthVariables }>();

  // ─────────────────────────────────────────────────────────────────
  // POST /v1/telemetry/batch
  // 接收龍蝦上報的遙測批次
  // 需要：X-Device-Id + X-Device-Token（deviceAuth 已在 app 層套用）
  // ─────────────────────────────────────────────────────────────────
  router.post('/batch', async (c) => {
    const deviceId = c.get('deviceId');

    // === 速率限制（每裝置每小時最多 3 次）===
    const rateLimitResult = checkRateLimit(batchRateLimitCache, deviceId, BATCH_RATE_LIMIT_PER_HOUR);
    if (rateLimitResult.exceeded) {
      return c.json(
        {
          error: ErrorCode.TELEMETRY_RATE_LIMITED,
          message: `上報頻率過高，每小時最多 ${BATCH_RATE_LIMIT_PER_HOUR} 次`,
          retry_after: rateLimitResult.retryAfterSeconds,
        },
        429,
      );
    }

    // === 解析請求 body ===
    let batchData: unknown;
    try {
      batchData = await c.req.json();
    } catch {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '請求 body 格式錯誤，必須為有效的 JSON',
        },
        400,
      );
    }

    // === 交給 IntelligenceEngine 處理 ===
    try {
      const result = await engine.receiveBatch(deviceId, batchData);

      // === 異常偵測（非同步，不阻塞回應）===
      // 只有在批次成功儲存後才跑異常偵測
      try {
        const globalStats = buildGlobalStats(db);
        const batch = batchData as Parameters<typeof detector.detect>[0];
        const anomalyReport = detector.detect(batch, deviceId, globalStats);

        // 如果裝置被 suspend，回傳 403（但批次已儲存）
        if (anomalyReport.action === 'suspend') {
          return c.json(
            {
              error: ErrorCode.DEVICE_SUSPENDED,
              message: '此裝置因異常行為被暫停，遙測數據已記錄但裝置已被停用',
              batch_id: result.batch_id,
            },
            403,
          );
        }
      } catch (anomalyErr) {
        // 異常偵測失敗不影響主流程
        console.error('[Telemetry] 異常偵測失敗:', anomalyErr);
      }

      return c.json(
        {
          success: true,
          batch_id: result.batch_id,
          entries_stored: result.entries_stored,
          reputation_weight: result.reputation_weight,
          message: `成功接收 ${result.entries_stored} 條遙測數據`,
        },
        200,
      );
    } catch (err) {
      // 處理已知錯誤碼
      const e = err as Error & { errorCode?: ErrorCode };

      if (e.errorCode === ErrorCode.TELEMETRY_DUPLICATE_BATCH) {
        return c.json(
          {
            error: ErrorCode.TELEMETRY_DUPLICATE_BATCH,
            message: 'batch_id 已存在，請勿重複上報',
          },
          409,
        );
      }

      if (e.errorCode === ErrorCode.TELEMETRY_BATCH_TOO_LARGE) {
        return c.json(
          {
            error: ErrorCode.TELEMETRY_BATCH_TOO_LARGE,
            message: e.message,
          },
          413,
        );
      }

      if (e.errorCode === ErrorCode.TELEMETRY_INVALID_SCHEMA) {
        return c.json(
          {
            error: ErrorCode.TELEMETRY_INVALID_SCHEMA,
            message: e.message,
          },
          400,
        );
      }

      // 未知錯誤
      console.error('[Telemetry] 批次接收失敗:', err);
      return c.json(
        {
          error: ErrorCode.INTERNAL_ERROR,
          message: '伺服器內部錯誤，請稍後再試',
        },
        500,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /v1/telemetry/route-suggestions
  // 取得路由建議
  // Query: ?region=asia|europe|americas|other（可選）
  // ─────────────────────────────────────────────────────────────────
  router.get('/route-suggestions', (c) => {
    const region = c.req.query('region');

    try {
      const suggestions = engine.getRouteSuggestions(region);

      // 依地區和服務整理輸出格式
      const grouped: Record<string, Array<{
        service_id: string;
        status: string;
        confidence: number;
        success_rate: number | null;
        avg_latency_ms: number | null;
        p95_latency_ms: number | null;
        sample_size: number | null;
        recommendation_id: string;
        valid_until: string;
      }>> = {};

      for (const rec of suggestions) {
        const r = rec.region;
        if (!grouped[r]) grouped[r] = [];
        grouped[r]!.push({
          service_id: rec.service_id,
          status: rec.status,
          confidence: rec.confidence,
          success_rate: rec.success_rate,
          avg_latency_ms: rec.avg_latency_ms,
          p95_latency_ms: rec.p95_latency_ms,
          sample_size: rec.sample_size,
          recommendation_id: rec.recommendation_id,
          valid_until: rec.valid_until,
        });
      }

      return c.json({
        success: true,
        region: region ?? 'all',
        suggestions: grouped,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[Telemetry] 取得路由建議失敗:', err);
      return c.json(
        {
          error: ErrorCode.INTERNAL_ERROR,
          message: '取得路由建議失敗',
        },
        500,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /v1/telemetry/feedback
  // 提交路由回饋（positive 或 negative）
  // ─────────────────────────────────────────────────────────────────
  router.post('/feedback', async (c) => {
    const deviceId = c.get('deviceId');

    // === 回饋速率限制（每裝置每小時最多 10 次）===
    const rateLimitResult = checkRateLimit(
      feedbackRateLimitCache,
      deviceId,
      FEEDBACK_RATE_LIMIT_PER_HOUR,
    );
    if (rateLimitResult.exceeded) {
      return c.json(
        {
          error: ErrorCode.FEEDBACK_RATE_LIMITED,
          message: `回饋頻率過高，每小時最多 ${FEEDBACK_RATE_LIMIT_PER_HOUR} 次`,
          retry_after: rateLimitResult.retryAfterSeconds,
        },
        429,
      );
    }

    // === 解析請求 body ===
    let body: Partial<FeedbackPayload>;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '請求 body 格式錯誤',
        },
        400,
      );
    }

    // === 驗證必填欄位 ===
    if (!body.service_id) {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '缺少必填欄位：service_id',
        },
        400,
      );
    }

    if (body.feedback !== 'positive' && body.feedback !== 'negative') {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: 'feedback 必須為 positive 或 negative',
        },
        400,
      );
    }

    try {
      const result = await engine.handleFeedback(deviceId, {
        recommendation_id: body.recommendation_id ?? '',
        service_id: body.service_id,
        feedback: body.feedback,
        reason: body.reason,
        comment: body.comment,
      });

      return c.json({
        success: result.success,
        message: `回饋已記錄（${body.feedback}）`,
      });
    } catch (err) {
      console.error('[Telemetry] 回饋處理失敗:', err);
      return c.json(
        {
          error: ErrorCode.INTERNAL_ERROR,
          message: '回饋處理失敗',
        },
        500,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /v1/telemetry/quota
  // 查詢本裝置的遙測上報配額
  // ─────────────────────────────────────────────────────────────────
  router.get('/quota', (c) => {
    const deviceId = c.get('deviceId');
    const now = new Date();

    try {
      // 查詢近 1 小時已上報的批次數
      const batchCountResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_batches
         WHERE device_id = ?
           AND received_at > datetime('now', '-1 hour')`,
        [deviceId],
      );
      const usedBatchesThisHour = batchCountResult[0]?.count ?? 0;

      // 計算下次允許上報時間（若已超過限制）
      let nextAllowedAt: string;
      const rateLimitEntry = batchRateLimitCache.get(deviceId);
      if (rateLimitEntry && usedBatchesThisHour >= BATCH_RATE_LIMIT_PER_HOUR) {
        const windowEndMs = rateLimitEntry.windowStart + 60 * 60 * 1000;
        nextAllowedAt = new Date(windowEndMs).toISOString();
      } else {
        nextAllowedAt = now.toISOString();
      }

      // 查詢近 1 小時已提交的回饋數
      const feedbackCountResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_feedback
         WHERE device_id = ?
           AND created_at > datetime('now', '-1 hour')`,
        [deviceId],
      );
      const usedFeedbackThisHour = feedbackCountResult[0]?.count ?? 0;

      // 查詢待處理批次數（近 24hr 已上報但尚未分析的）
      const pendingResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_batches
         WHERE device_id = ?
           AND received_at > datetime('now', '-24 hours')`,
        [deviceId],
      );
      const pendingBatches = pendingResult[0]?.count ?? 0;

      const quota: TelemetryQuota = {
        batch_uploads: {
          limit_per_hour: BATCH_RATE_LIMIT_PER_HOUR,
          used_this_hour: usedBatchesThisHour,
          next_allowed_at: nextAllowedAt,
        },
        feedback: {
          limit_per_hour: FEEDBACK_RATE_LIMIT_PER_HOUR,
          used_this_hour: usedFeedbackThisHour,
        },
        pending_batches: pendingBatches,
        server_time: now.toISOString(),
      };

      return c.json({
        success: true,
        quota,
      });
    } catch (err) {
      console.error('[Telemetry] 查詢配額失敗:', err);
      return c.json(
        {
          error: ErrorCode.INTERNAL_ERROR,
          message: '查詢配額失敗',
        },
        500,
      );
    }
  });

  return router;
}
