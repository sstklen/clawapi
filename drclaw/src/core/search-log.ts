/**
 * Debug 醫生 — 搜尋紀錄
 * 每次龍蝦問問題都記下來（fire-and-forget）
 * → 知道哪些 bug 最常被問
 * → 龍蝦的措辭變成搜尋語料
 */

import { getDb } from '../database';

/**
 * 記錄搜尋（fire-and-forget）
 * 不管有沒有命中，都把龍蝦的 query 存下來
 */
export function logSearchQuery(
  query: string,
  source: 'api' | 'mcp' | 'search',
  hit: boolean,
  hitEntryId?: number,
  callerInfo?: Record<string, any>,
  channel?: string,
): void {
  try {
    const db = getDb();
    db.run(
      `INSERT INTO debug_search_log (query, source, hit, hit_entry_id, caller_info, channel) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        query.substring(0, 1000),
        source,
        hit ? 1 : 0,
        hitEntryId ?? null,
        callerInfo ? JSON.stringify(callerInfo) : '{}',
        channel || 'unknown',
      ],
    );
  } catch {
    // fire-and-forget，絕不影響主流程
  }
}
