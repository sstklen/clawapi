// 路由更新處理器 — 從 VPS 接收 routing_intel 並寫入 DB
// 從 index.ts 提取出來以便單元測試

import type { ClawDatabase } from '../storage/database';

/** VPS 下發的路由更新項目 */
export interface RoutingUpdateItem {
  service_id?: string;
  region?: string;
  status?: string;
  confidence?: number;
  success_rate?: number | null;
  avg_latency_ms?: number | null;
  p95_latency_ms?: number | null;
  sample_size?: number | null;
  note?: string | null;
  valid_until?: string;
}

/**
 * 處理 VPS 下發的路由更新
 * 將有效項目寫入 routing_intel 表
 *
 * @param db - 資料庫連線
 * @param update - VPS 下發的更新資料（單項或陣列）
 * @returns 成功寫入的筆數
 */
export function handleRoutingUpdate(db: ClawDatabase, update: unknown): number {
  const items = Array.isArray(update) ? update : [update];
  let inserted = 0;

  for (const item of items) {
    // null/undefined 安全檢查
    if (item == null || typeof item !== 'object') continue;
    const r = item as RoutingUpdateItem;

    // 必填欄位驗證
    if (!r.service_id || !r.region || !r.status) continue;

    // 安全防護：clamp 數值範圍，防止惡意或異常的 VPS 數據影響路由評分
    const VALID_STATUSES = ['preferred', 'degraded', 'avoid', 'unknown'];
    const safeStatus = VALID_STATUSES.includes(r.status) ? r.status : 'unknown';
    const clampedConfidence = Math.max(0, Math.min(1, r.confidence ?? 0.5));
    const clampedSuccessRate = r.success_rate != null
      ? Math.max(0, Math.min(1, r.success_rate))
      : null;
    const clampedP95 = r.p95_latency_ms != null
      ? Math.max(0, Math.min(300000, r.p95_latency_ms))
      : null;

    db.run(
      `INSERT OR REPLACE INTO routing_intel
        (service_id, region, status, confidence, success_rate,
         avg_latency_ms, p95_latency_ms, sample_size, note,
         updated_at, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
      [
        r.service_id, r.region, safeStatus,
        clampedConfidence,
        clampedSuccessRate,
        r.avg_latency_ms ?? null,
        clampedP95,
        r.sample_size ?? null,
        r.note ?? null,
        r.valid_until ?? new Date(Date.now() + 86400000).toISOString(),
      ]
    );
    inserted++;
  }

  return inserted;
}

// ===== 爽點四：從 DB 載入路由智慧 =====

/** routing_intel 表的資料列 */
interface IntelRow {
  service_id: string;
  status: string;
  confidence: number;
  success_rate: number | null;
  p95_latency_ms: number | null;
}

/**
 * 從 routing_intel 表載入有效的集體智慧數據
 * 轉換為 L2Gateway 需要的 CollectiveIntel 格式
 *
 * 每個 service_id 取最新一筆（按 updated_at 降序）
 * 只回傳 valid_until 尚未過期的資料
 *
 * @param db - 資料庫連線
 * @returns CollectiveIntel 物件，無資料時回傳 null
 */
export function loadCollectiveIntelFromDB(db: ClawDatabase): Record<string, unknown> | null {
  const rows = db.query<IntelRow>(
    `SELECT service_id, status, confidence, success_rate, p95_latency_ms
     FROM routing_intel
     WHERE valid_until > datetime('now')
     ORDER BY updated_at DESC`
  );

  if (rows.length === 0) return null;

  const intel: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const row of rows) {
    // 每個 service_id 只取最新的一筆
    if (seen.has(row.service_id)) continue;
    seen.add(row.service_id);

    intel[row.service_id] = {
      success_rate: row.success_rate ?? 0.5,
      p95_latency_ms: row.p95_latency_ms ?? 5000,
      confidence: row.confidence,
      status: row.status,
    };
  }

  return Object.keys(intel).length > 0 ? intel : null;
}
