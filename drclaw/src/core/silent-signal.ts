/**
 * Debug 醫生 — 沈默訊號偵測 + Session 清理
 *
 * 沈默訊號：龍蝦問完問題後 24 小時沒帶著類似問題回來
 * → 弱正向訊號（不代表成功，只是沒再出問題）
 * → 不污染正式驗證數據，獨立記錄
 *
 * Session 清理：過期的望聞問切 session 標記為 expired
 */

import { createLogger } from '../logger';
import { getDb } from '../database';
import { DIAGNOSIS_SESSION_TTL_MS } from './constants';

const log = createLogger('SilentSignal');

/** 確保 no_revisit_count 欄位存在（只跑一次，不用每次 ALTER TABLE） */
let _columnEnsured = false;

/**
 * 沈默訊號偵測：24 小時內龍蝦沒帶著類似問題回來 → 弱正向訊號（不等於成功）
 * - 不寫入 debug_feedback（不污染正式驗證數據）
 * - 只更新 debug_knowledge.no_revisit_count（獨立欄位）
 * - 排名時當作「弱加分」，不等同於社群驗證
 * 在 GET /debug-ai 時順便跑（每次最多處理 50 筆，避免阻塞）
 */
export function detectSilentSignal(): number {
  try {
    const db = getDb();
    // 確保欄位存在（只跑一次）
    if (!_columnEnsured) {
      try { db.run('ALTER TABLE debug_knowledge ADD COLUMN no_revisit_count INTEGER NOT NULL DEFAULT 0'); } catch { /* 已存在 */ }
      _columnEnsured = true;
    }

    // 找出 >24h 前的 KB 命中交易，且：
    // 1. 沒有正式回饋紀錄
    // 2. 龍蝦 24h 內沒帶類似問題回來（沒回診 = 弱正向）
    // 3. 只看最近 7 天的交易（避免掃太遠）
    const candidates = db.prepare(`
      SELECT DISTINCT
        CAST(REPLACE(REPLACE(lt.ref_id, 'drclaw_', ''), 'kb_', '') AS INTEGER) as kb_id,
        lt.lobster_id
      FROM lobster_transactions lt
      WHERE lt.type IN ('analyze_kb_hit', 'analyze_kb_augmented')
        AND lt.created_at < datetime('now', '-24 hours')
        AND lt.created_at > datetime('now', '-7 days')
        AND lt.ref_id IS NOT NULL AND lt.ref_id != ''
        AND NOT EXISTS (
          SELECT 1 FROM debug_feedback df
          WHERE df.kb_entry_id = CAST(
            REPLACE(REPLACE(lt.ref_id, 'drclaw_', ''), 'kb_', '') AS INTEGER
          )
          AND df.lobster_id = lt.lobster_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM lobster_transactions lt2
          WHERE lt2.lobster_id = lt.lobster_id
            AND lt2.type IN ('analyze_kb_hit', 'analyze_kb_augmented', 'analyze_opus', 'analyze_sonnet')
            AND lt2.created_at > lt.created_at
            AND lt2.created_at < datetime(lt.created_at, '+24 hours')
        )
      LIMIT 50
    `).all() as any[];

    let count = 0;
    const now = new Date().toISOString();
    for (const c of candidates) {
      if (!c.kb_id || isNaN(c.kb_id)) continue;
      // no_revisit_count +1（冪等：用 UNIQUE feedback 紀錄防重複）
      try {
        db.transaction(() => {
          // 用特殊 worked=-1 標記「沈默訊號」，與正式回饋區分
          db.run(
            'INSERT OR IGNORE INTO debug_feedback (kb_entry_id, lobster_id, worked, notes) VALUES (?, ?, -1, ?)',
            [c.kb_id, c.lobster_id, 'silent_signal: no revisit in 24h'],
          );
          db.run(
            'UPDATE debug_knowledge SET no_revisit_count = no_revisit_count + 1, updated_at = ? WHERE id = ?',
            [now, c.kb_id],
          );
        })();
        count++;
      } catch { /* UNIQUE 衝突 = 已處理過 */ }
    }
    if (count > 0) log.info(`未回診偵測 📋 ${count} 筆（沒出問題 ≠ 成功，僅記錄）`);
    return count;
  } catch (err: any) {
    log.warn(`沈默訊號偵測失敗: ${err.message?.substring(0, 100)}`);
    return 0;
  }
}

/** 清理過期 sessions（在 GET /debug-ai 時順便跑） */
export function cleanExpiredSessions(): number {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - DIAGNOSIS_SESSION_TTL_MS).toISOString();
    const result = db.run(
      "UPDATE debug_sessions SET status = 'expired', updated_at = ? WHERE status = 'active' AND created_at < ?",
      [new Date().toISOString(), cutoff],
    );
    return (result as any)?.changes || 0;
  } catch { return 0; }
}
