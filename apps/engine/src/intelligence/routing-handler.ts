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

    db.run(
      `INSERT OR REPLACE INTO routing_intel
        (service_id, region, status, confidence, success_rate,
         avg_latency_ms, p95_latency_ms, sample_size, note,
         updated_at, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
      [
        r.service_id, r.region, r.status,
        r.confidence ?? 0.5,
        r.success_rate ?? null,
        r.avg_latency_ms ?? null,
        r.p95_latency_ms ?? null,
        r.sample_size ?? null,
        r.note ?? null,
        r.valid_until ?? new Date(Date.now() + 86400000).toISOString(),
      ]
    );
    inserted++;
  }

  return inserted;
}
