/**
 * Dr. Claw — SQLite 資料庫（獨立版）
 * 使用 bun:sqlite（Bun 內建，不需要 native addon）
 * 只含 Dr. Claw 需要的 8 個表，完全脫離 washin-api
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { createLogger } from './logger';
import { getEnv } from './config';

const log = createLogger('Database');

let db: Database | null = null;

/**
 * 取得 SQLite 單例實例
 * 介面與 washin-api 的 getDb() 相容（query / run / prepare / exec）
 */
export function getDb(): Database {
  if (db) return db;

  const dbPath = getEnv('SQLITE_PATH', resolve(process.cwd(), 'data/drclaw.db'));
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath, { create: true });

  // PRAGMA 設定
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  // 建表
  initTables(db);

  log.info(`📦 Dr. Claw DB 已初始化: ${dbPath}`);
  return db;
}

/**
 * 建立 Dr. Claw 所需的所有表（冪等）
 */
function initTables(db: Database): void {
  // ─── 1. 知識庫 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS debug_knowledge (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      error_description TEXT    NOT NULL,
      error_message     TEXT    NOT NULL DEFAULT '',
      error_category    TEXT    NOT NULL DEFAULT 'general',
      root_cause        TEXT    NOT NULL DEFAULT '',
      fix_description   TEXT    NOT NULL DEFAULT '',
      fix_patch         TEXT    NOT NULL DEFAULT '',
      environment       TEXT    NOT NULL DEFAULT '{}',
      quality_score     REAL    NOT NULL DEFAULT 0,
      verified          INTEGER NOT NULL DEFAULT 0,
      hit_count         INTEGER NOT NULL DEFAULT 0,
      contributed_by    TEXT    NOT NULL DEFAULT 'system',
      source            TEXT    NOT NULL DEFAULT 'debug_request',
      verified_count    INTEGER NOT NULL DEFAULT 0,
      success_count     INTEGER NOT NULL DEFAULT 0,
      fail_count        INTEGER NOT NULL DEFAULT 0,
      last_verified_at  TEXT,
      created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_knowledge_category ON debug_knowledge(error_category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_knowledge_quality ON debug_knowledge(quality_score DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_knowledge_hits ON debug_knowledge(hit_count DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_knowledge_verified ON debug_knowledge(verified)`);

  // ─── 2. 社群回饋 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS debug_feedback (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_entry_id INTEGER NOT NULL,
      lobster_id  TEXT    NOT NULL,
      worked      INTEGER NOT NULL,
      notes       TEXT    NOT NULL DEFAULT '',
      environment TEXT    NOT NULL DEFAULT '{}',
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (kb_entry_id) REFERENCES debug_knowledge(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_feedback_entry ON debug_feedback(kb_entry_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_feedback_created ON debug_feedback(created_at DESC)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_debug_feedback_unique ON debug_feedback(kb_entry_id, lobster_id)`);

  // ─── 3. 搜尋紀錄 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS debug_search_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      query        TEXT    NOT NULL,
      source       TEXT    NOT NULL DEFAULT 'api',
      hit          INTEGER NOT NULL DEFAULT 0,
      hit_entry_id INTEGER,
      caller_info  TEXT    NOT NULL DEFAULT '{}',
      channel      TEXT    NOT NULL DEFAULT 'unknown',
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_search_log_created ON debug_search_log(created_at DESC)`);

  // ─── 4. 龍蝦帳戶 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS lobster_accounts (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      lobster_id            TEXT    UNIQUE NOT NULL,
      display_name          TEXT    NOT NULL DEFAULT '',
      balance               REAL    NOT NULL DEFAULT 0,
      total_spent           REAL    NOT NULL DEFAULT 0,
      total_saved           REAL    NOT NULL DEFAULT 0,
      problems_solved       INTEGER NOT NULL DEFAULT 0,
      problems_contributed  INTEGER NOT NULL DEFAULT 0,
      onboarded             INTEGER NOT NULL DEFAULT 0,
      debug_maturity        INTEGER NOT NULL DEFAULT 0,
      channel               TEXT    NOT NULL DEFAULT 'api',
      created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lobster_accounts_id ON lobster_accounts(lobster_id)`);

  // ─── 5. 交易紀錄 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS lobster_transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      lobster_id    TEXT    NOT NULL,
      type          TEXT    NOT NULL,
      amount        REAL    NOT NULL,
      balance_after REAL    NOT NULL DEFAULT 0,
      description   TEXT    NOT NULL DEFAULT '',
      ref_id        TEXT,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lobster_tx_lobster ON lobster_transactions(lobster_id, created_at DESC)`);

  // ─── 6. 望聞問切 Session ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS debug_sessions (
      id                  TEXT    PRIMARY KEY,
      lobster_id          TEXT    NOT NULL,
      phase               TEXT    NOT NULL DEFAULT '望',
      round               INTEGER NOT NULL DEFAULT 1,
      initial_description TEXT    NOT NULL,
      initial_score       INTEGER NOT NULL DEFAULT 0,
      collected_info      TEXT    NOT NULL DEFAULT '{}',
      conversation        TEXT    NOT NULL DEFAULT '[]',
      diagnosis           TEXT,
      kb_candidates       TEXT    DEFAULT '[]',
      status              TEXT    NOT NULL DEFAULT 'active',
      created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_sessions_lobster ON debug_sessions(lobster_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_debug_sessions_status ON debug_sessions(status)`);

  // ─── 7. 統計（單行表） ───
  db.exec(`
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
  db.exec(`INSERT OR IGNORE INTO debug_stats (id) VALUES (1)`);

  // ─── 8. 未解佇列 ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS unsolved_queue (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      error_description   TEXT    NOT NULL,
      error_message       TEXT    NOT NULL DEFAULT '',
      lobster_id          TEXT    NOT NULL DEFAULT 'anonymous',
      environment         TEXT    NOT NULL DEFAULT '{}',
      logs                TEXT    NOT NULL DEFAULT '',
      tried               TEXT    NOT NULL DEFAULT '[]',
      project_structure   TEXT    NOT NULL DEFAULT '',
      original_confidence REAL    NOT NULL DEFAULT 0,
      original_analysis   TEXT    NOT NULL DEFAULT '{}',
      status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','resolved','wontfix')),
      resolved_entry_id   INTEGER,
      created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  // ─── 遷移：為既有 DB 加缺少的欄位 ───
  try { db.exec(`ALTER TABLE debug_search_log ADD COLUMN channel TEXT NOT NULL DEFAULT 'unknown'`); } catch { /* 欄位已存在 */ }
  try { db.exec(`ALTER TABLE lobster_accounts ADD COLUMN channel TEXT NOT NULL DEFAULT 'api'`); } catch { /* 欄位已存在 */ }

  log.info('🗄️ 8 個表已建立/確認');
}

/**
 * 關閉資料庫連線（shutdown 時呼叫）
 */
export function closeDb(): void {
  if (db) {
    try { db.close(); } catch { /* 忽略 */ }
    db = null;
    log.info('📦 DB 已關閉');
  }
}
