/**
 * Debug 醫生 — 統計系統
 * 持久化到 SQLite，重啟不歸零
 */

import { createLogger } from '../logger';
import { getDb } from '../database';
import type { DebugStats } from './types';

const log = createLogger('DebugStats');

// ─── 記憶體中的統計快取 ───

export const debugStats: DebugStats = {
  totalRequests: 0,
  knowledgeHits: 0,
  sonnetAnalyses: 0,
  opusAnalyses: 0,
  contributions: 0,
  autoCollections: 0,
  searches: 0,
  startedAt: new Date().toISOString(),
};

/** 從 DB 載入累計統計，啟動時呼叫一次 */
export function loadStatsFromDb(): void {
  try {
    const db = getDb();
    // 確保 debug_stats 表存在（單行表）
    db.run(`
      CREATE TABLE IF NOT EXISTS debug_stats (
        id               INTEGER PRIMARY KEY CHECK (id = 1),
        total_requests   INTEGER NOT NULL DEFAULT 0,
        knowledge_hits   INTEGER NOT NULL DEFAULT 0,
        sonnet_analyses  INTEGER NOT NULL DEFAULT 0,
        opus_analyses    INTEGER NOT NULL DEFAULT 0,
        contributions    INTEGER NOT NULL DEFAULT 0,
        auto_collections INTEGER NOT NULL DEFAULT 0,
        searches         INTEGER NOT NULL DEFAULT 0,
        first_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.run(`INSERT OR IGNORE INTO debug_stats (id) VALUES (1)`);

    // 註：unsolved_queue 表也在這裡建（歷史原因，確保啟動時存在）
    db.run(`
      CREATE TABLE IF NOT EXISTS unsolved_queue (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        error_description TEXT NOT NULL,
        error_message     TEXT NOT NULL DEFAULT '',
        lobster_id        TEXT NOT NULL DEFAULT 'anonymous',
        environment       TEXT NOT NULL DEFAULT '{}',
        logs              TEXT NOT NULL DEFAULT '',
        tried             TEXT NOT NULL DEFAULT '[]',
        project_structure TEXT NOT NULL DEFAULT '',
        original_confidence REAL NOT NULL DEFAULT 0,
        original_analysis TEXT NOT NULL DEFAULT '{}',
        status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','resolved','wontfix')),
        resolved_entry_id INTEGER,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);

    const row: any = db.prepare('SELECT * FROM debug_stats WHERE id = 1').get();
    if (row) {
      debugStats.totalRequests = row.total_requests;
      debugStats.knowledgeHits = row.knowledge_hits;
      debugStats.sonnetAnalyses = row.sonnet_analyses;
      debugStats.opusAnalyses = row.opus_analyses;
      debugStats.contributions = row.contributions;
      debugStats.autoCollections = row.auto_collections;
      debugStats.searches = row.searches;
      debugStats.startedAt = row.first_started_at;
    }
    log.info(`📊 統計已從 DB 載入: ${debugStats.totalRequests} 請求, ${debugStats.searches} 搜尋, ${debugStats.knowledgeHits} 命中`);
  } catch (err: any) {
    log.warn(`📊 載入統計失敗（用預設值）: ${err.message}`);
  }
}

// ─── DB 欄位名對應 ───

const DB_FIELD_MAP: Record<string, string> = {
  totalRequests: 'total_requests',
  knowledgeHits: 'knowledge_hits',
  sonnetAnalyses: 'sonnet_analyses',
  opusAnalyses: 'opus_analyses',
  contributions: 'contributions',
  autoCollections: 'auto_collections',
  searches: 'searches',
};

/** 遞增統計並寫回 DB（fire-and-forget） */
export function incrementStat(field: keyof Omit<DebugStats, 'startedAt'>): void {
  debugStats[field]++;

  const col = DB_FIELD_MAP[field];
  if (!col) return;

  try {
    const db = getDb();
    // 安全：col 來自硬編碼 DB_FIELD_MAP，不是用戶輸入
    db.run(`UPDATE debug_stats SET ${col} = ${col} + 1 WHERE id = 1`);
  } catch (err: any) {
    log.warn(`📊 incrementStat(${field}) 寫入失敗: ${err.message}`);
  }
}

/** 今日自動收集計數器（key = 來源, value = { count, date }） */
export const autoCollectCounters: Map<string, { count: number; date: string }> = new Map();
