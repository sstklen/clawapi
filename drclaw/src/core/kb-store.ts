/**
 * Debug 醫生 — 知識庫存取層（KB Store）
 *
 * 所有知識庫的讀寫操作集中在這裡：
 * - searchKnowledge：Qdrant 向量搜尋 → SQLite LIKE fallback
 * - contributeDebugKnowledge：寫入 SQLite + 非阻塞向量化
 * - vectorizeAndStore：Qdrant 向量寫入（帶重試）
 * - vectorRetryQueue：失敗自動重試佇列
 */

import { createLogger } from '../logger';
import { getDb } from '../database';
import { isQdrantReady, searchSimilar, upsertVector } from '../qdrant';
import { embedQuality } from '../embed';
import { SIMILARITY_THRESHOLD } from './constants';
import { incrementStat } from './stats';
import type { DebugEntry } from './types';

const log = createLogger('KBStore');

// ============================================
// 搜尋知識庫
// ============================================

/**
 * 搜尋知識庫（Qdrant 向量 → SQLite LIKE fallback）
 * 回傳最相似的解法，或空陣列
 */
export async function searchKnowledge(query: string, limit = 3): Promise<DebugEntry[]> {
  const db = getDb();

  // ── 優先用 Qdrant 向量搜尋 ──
  if (await isQdrantReady()) {
    try {
      const { result } = await embedQuality([query], 1024, 'query');
      if (result.embeddings.length > 0) {
        const hits = await searchSimilar('debug_knowledge', result.embeddings[0], limit, SIMILARITY_THRESHOLD);
        if (hits.length > 0) {
          const ids = hits.map(h => h.id);
          const placeholders = ids.map(() => '?').join(',');
          const rows = db.prepare(
            `SELECT * FROM debug_knowledge WHERE id IN (${placeholders}) ORDER BY CASE WHEN verified_count >= 3 THEN success_count * 1.0 / verified_count ELSE quality_score END DESC, verified_count DESC, hit_count DESC`,
          ).all(...ids) as DebugEntry[];
          if (rows.length > 0) {
            log.info(`向量搜尋命中 ${rows.length} 筆: scores=[${hits.map(h => h.score.toFixed(3)).join(',')}]`);
            return rows;
          }
        }
      }
    } catch (err: any) {
      log.warn(`向量搜尋失敗，退回 LIKE: ${err.message}`);
    }
  }

  // ── Fallback：SQLite LIKE ──
  const keywords = query.substring(0, 50).replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff.-]/g, ' ').trim();
  if (!keywords) return [];

  const likePattern = `%${keywords.substring(0, 30)}%`;
  const rows = db.prepare(
    `SELECT * FROM debug_knowledge WHERE error_description LIKE ? OR error_message LIKE ?
     ORDER BY CASE WHEN verified_count >= 3 THEN success_count * 1.0 / verified_count ELSE quality_score END DESC, verified_count DESC, hit_count DESC LIMIT ?`,
  ).all(likePattern, likePattern, limit) as DebugEntry[];

  if (rows.length > 0) {
    log.info(`SQLite LIKE 命中 ${rows.length} 筆`);
  }
  return rows;
}

// ============================================
// 寫入知識庫
// ============================================

/**
 * 將解坑經驗存入知識庫（SQLite + Qdrant 非阻塞）
 * 公開 export 給其他模組用（L1/L4 自動收集）
 */
export async function contributeDebugKnowledge(entry: Partial<DebugEntry>): Promise<number> {
  const db = getDb();

  const errorDesc = entry.error_description || '';
  const errorMsg = entry.error_message || '';
  const category = entry.error_category || 'general';
  const rootCause = entry.root_cause || '';
  const fixDesc = entry.fix_description || '';
  const fixPatch = entry.fix_patch || '';
  const env = entry.environment || '{}';
  const qualityScore = entry.quality_score ?? 0.7;
  const verified = entry.verified ?? 0;
  const contributedBy = entry.contributed_by || 'system';
  const source = entry.source || 'debug_request';

  // ── 0. 去重：相同 error_description 不重複寫入 ──
  const existing = db.prepare(
    'SELECT id, quality_score FROM debug_knowledge WHERE error_description = ?',
  ).get(errorDesc) as any;

  if (existing) {
    // 如果新的品質更高 → 更新；否則跳過
    if (qualityScore > (existing.quality_score || 0)) {
      db.run(
        `UPDATE debug_knowledge SET error_message=?, error_category=?, root_cause=?, fix_description=?, fix_patch=?, quality_score=?, contributed_by=?, source=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?`,
        [errorMsg, category, rootCause, fixDesc, fixPatch, qualityScore, contributedBy, source, existing.id],
      );
      log.info(`知識庫更新（品質更高）: id=${existing.id}, ${existing.quality_score}→${qualityScore}`);
    } else {
      log.info(`知識庫跳過重複: "${errorDesc.slice(0, 40)}..." (existing id=${existing.id})`);
    }
    return existing.id;
  }

  // ── 1. 寫入 SQLite ──
  db.run(
    `INSERT INTO debug_knowledge (error_description, error_message, error_category, root_cause, fix_description, fix_patch, environment, quality_score, verified, contributed_by, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [errorDesc, errorMsg, category, rootCause, fixDesc, fixPatch, env, qualityScore, verified, contributedBy, source],
  );

  const lastRow = db.prepare('SELECT last_insert_rowid() as id').get() as any;
  const rowId = lastRow?.id;

  log.info(`知識庫新增: id=${rowId}, category=${category}, quality=${qualityScore.toFixed(2)}, by=${contributedBy}`);
  incrementStat('contributions');

  // ── 2. 非阻塞寫入 Qdrant ──
  if (rowId) {
    vectorizeAndStore(rowId, errorDesc, errorMsg, category, qualityScore).catch(() => {});
  }

  return rowId;
}

// ============================================
// 向量化 + Qdrant 寫入（帶重試佇列）
// ============================================

/**
 * 向量化 + 寫入 Qdrant（帶重試 + 失敗排程）
 * @param fromRetryQueue 從重試佇列呼叫時為 true，失敗不再重新排入（防無限循環）
 */
export async function vectorizeAndStore(
  rowId: number,
  errorDesc: string,
  errorMsg: string,
  category: string,
  qualityScore: number,
  retryCount = 0,
  fromRetryQueue = false,
): Promise<void> {
  if (!(await isQdrantReady())) {
    // Qdrant 沒起來 → 排進重試佇列（重試佇列來的不再排入）
    if (!fromRetryQueue) scheduleVectorRetry(rowId, errorDesc, errorMsg, category, qualityScore);
    return;
  }
  try {
    const textToEmbed = `${errorDesc} ${errorMsg}`.substring(0, 500);
    const { result } = await embedQuality([textToEmbed], 1024, 'document');
    if (result.embeddings.length > 0) {
      const ok = await upsertVector('debug_knowledge', rowId, result.embeddings[0], {
        errorCategory: category,
        qualityScore,
      });
      if (ok) {
        log.info(`向量索引已寫入: debug_knowledge id=${rowId}`);
      }
    }
  } catch (err: any) {
    if (retryCount < 2) {
      log.warn(`向量索引失敗 (retry ${retryCount + 1}/2): ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * (retryCount + 1)));
      return vectorizeAndStore(rowId, errorDesc, errorMsg, category, qualityScore, retryCount + 1, fromRetryQueue);
    }
    log.warn(`向量索引寫入最終失敗 id=${rowId}: ${err.message}`);
    // 重試佇列來的不再排入，防無限循環
    if (!fromRetryQueue) scheduleVectorRetry(rowId, errorDesc, errorMsg, category, qualityScore);
  }
}

/** 失敗的向量化排進佇列，每 5 分鐘自動重試 */
const RETRY_QUEUE_MAX = 500;
const vectorRetryQueue: Array<{ rowId: number; errorDesc: string; errorMsg: string; category: string; qualityScore: number }> = [];
let vectorRetryTimer: ReturnType<typeof setInterval> | null = null;

function scheduleVectorRetry(rowId: number, errorDesc: string, errorMsg: string, category: string, qualityScore: number): void {
  // 避免重複排入
  if (vectorRetryQueue.some(q => q.rowId === rowId)) return;
  // 佇列大小上限，防 Qdrant 長期離線時記憶體爆炸
  if (vectorRetryQueue.length >= RETRY_QUEUE_MAX) {
    log.warn(`向量重試佇列已滿 (${RETRY_QUEUE_MAX})，丟棄 id=${rowId}`);
    return;
  }
  vectorRetryQueue.push({ rowId, errorDesc, errorMsg, category, qualityScore });
  log.info(`向量索引排入重試佇列: id=${rowId} (佇列長度: ${vectorRetryQueue.length})`);

  // 啟動定時器（如果還沒跑）
  if (!vectorRetryTimer) {
    vectorRetryTimer = setInterval(processVectorRetryQueue, 5 * 60 * 1000); // 每 5 分鐘
    log.info('向量重試定時器已啟動（每 5 分鐘）');
  }
}

async function processVectorRetryQueue(): Promise<void> {
  if (vectorRetryQueue.length === 0) {
    if (vectorRetryTimer) { clearInterval(vectorRetryTimer); vectorRetryTimer = null; }
    return;
  }

  log.info(`向量重試佇列: ${vectorRetryQueue.length} 筆待處理`);
  const batch = vectorRetryQueue.splice(0, 10); // 每次最多 10 筆

  for (const item of batch) {
    try {
      // fromRetryQueue=true → 失敗不再排回佇列
      await vectorizeAndStore(item.rowId, item.errorDesc, item.errorMsg, item.category, item.qualityScore, 0, true);
    } catch {
      // 再失敗就放棄
      log.warn(`向量重試最終放棄: id=${item.rowId}`);
    }
    await new Promise(r => setTimeout(r, 500)); // 禮貌間隔
  }
}
