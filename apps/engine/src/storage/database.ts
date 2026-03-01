// SQLite 資料庫管理模組
// 使用 bun:sqlite，WAL 模式，支援自動遷移

import { Database, type Statement } from 'bun:sqlite';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migration001 } from './migrations/001-init';

// ===== 型別定義 =====

export interface DatabaseModule {
  init(): Promise<void>;
  close(): Promise<void>;
  query<T>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
  transaction<T>(fn: () => T): T;
  checkpoint(): void;
  dailyReset(timezone: string): void;
}

// ===== DB 管理類別 =====

class ClawDatabase implements DatabaseModule {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath;
    } else {
      // 預設路徑：~/.clawapi/data.db
      const dataDir = join(homedir(), '.clawapi');
      this.dbPath = join(dataDir, 'data.db');
    }
  }

  /**
   * 初始化資料庫
   * 1. 確保資料目錄存在
   * 2. 開啟 DB 連線
   * 3. 設定 PRAGMA（WAL / foreign_keys / busy_timeout）
   * 4. 執行自動遷移
   */
  async init(): Promise<void> {
    // 確保目錄存在
    const dir = join(this.dbPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // 開啟 DB
    this.db = new Database(this.dbPath, { create: true });

    // 設定 WAL 模式和基本 PRAGMA
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA busy_timeout = 5000');

    // 執行遷移
    await this.runMigrations();
  }

  /**
   * 關閉資料庫
   * 先執行 WAL checkpoint，再關閉連線
   */
  async close(): Promise<void> {
    if (!this.db) return;
    try {
      // WAL checkpoint：把 WAL 檔合回主 DB 檔
      this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // checkpoint 失敗不阻止關閉
    }
    this.db.close();
    this.db = null;
  }

  /**
   * 執行多語句 SQL（不支援參數綁定）
   * 用於 migration 的 up/down SQL 等包含多個 statement 的情況
   */
  exec(sql: string): void {
    this.ensureDb().exec(sql);
  }

  /**
   * 查詢多列
   */
  query<T>(sql: string, params?: unknown[]): T[] {
    const stmt = this.getStatement(sql);
    if (params && params.length > 0) {
      return stmt.all(...params) as T[];
    }
    return stmt.all() as T[];
  }

  /**
   * 執行寫入操作，回傳 changes 和 lastInsertRowid
   */
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number } {
    const stmt = this.getStatement(sql);
    let result: ReturnType<Statement['run']>;
    if (params && params.length > 0) {
      result = stmt.run(...params);
    } else {
      result = stmt.run();
    }
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  /**
   * 包裝在單一 transaction 內執行
   */
  transaction<T>(fn: () => T): T {
    return this.ensureDb().transaction(fn)();
  }

  /**
   * WAL checkpoint（每 15 分鐘由 Scheduler 呼叫）
   */
  checkpoint(): void {
    if (!this.db) return;
    this.db.run('PRAGMA wal_checkpoint(PASSIVE)');
  }

  /**
   * 每日重置計數器（由 Scheduler 在本地時區 00:00 呼叫）
   * 重置：keys.daily_used、sub_keys.daily_used、gold_keys.daily_used、aid_config.daily_given
   */
  dailyReset(_timezone: string): void {
    this.transaction(() => {
      this.run('UPDATE keys       SET daily_used  = 0');
      this.run('UPDATE sub_keys   SET daily_used  = 0, rate_used_this_hour = 0, rate_hour_start = NULL');
      this.run('UPDATE gold_keys  SET daily_used  = 0');
      this.run('UPDATE aid_config SET daily_given = 0');
    });
  }

  // ===== 私有輔助方法 =====

  /** 確保 DB 已初始化，否則拋出錯誤 */
  private ensureDb(): Database {
    if (!this.db) {
      throw new Error('資料庫尚未初始化，請先呼叫 init()');
    }
    return this.db;
  }

  /** 取得預編譯的 Statement */
  private getStatement(sql: string): Statement {
    return this.ensureDb().prepare(sql);
  }

  /**
   * 執行所有未套用的遷移
   * 遷移邏輯：讀 schema_version → 找未執行的 → transaction 內逐一執行
   */
  private async runMigrations(): Promise<void> {
    const db = this.ensureDb();

    // 取得目前版本（如果 schema_version 不存在代表全新 DB）
    let currentVersion = 0;
    try {
      const rows = db
        .prepare('SELECT MAX(version) AS v FROM schema_version')
        .all() as Array<{ v: number | null }>;
      currentVersion = rows[0]?.v ?? 0;
    } catch {
      // 表格不存在，視為版本 0
      currentVersion = 0;
    }

    // 待執行的遷移清單（依版本號排序）
    const migrations = [migration001];
    const pending = migrations.filter(m => m.version > currentVersion);

    if (pending.length === 0) return;

    // 在單一 transaction 內逐一執行
    db.transaction(() => {
      for (const migration of pending) {
        // 執行 up SQL（可能包含多個語句，使用 exec）
        db.exec(migration.up);

        // 若是全新 DB，schema_version 剛被建立，插入版本記錄
        db.prepare(
          'INSERT INTO schema_version (version, description) VALUES (?, ?)'
        ).run(migration.version, migration.description);
      }
    })();
  }
}

// ===== 模組導出 =====

/** 全域單例（可被替換，例如測試時用記憶體 DB） */
let _instance: ClawDatabase | null = null;

/**
 * 取得 DB 實例（全域單例）
 */
export function getDatabase(): ClawDatabase {
  if (!_instance) {
    _instance = new ClawDatabase();
  }
  return _instance;
}

/**
 * 建立新的 DB 實例（測試或指定路徑用）
 */
export function createDatabase(dbPath?: string): ClawDatabase {
  return new ClawDatabase(dbPath);
}

/**
 * 替換全域單例（測試用）
 */
export function setDatabase(db: ClawDatabase): void {
  _instance = db;
}

export { ClawDatabase };
export default getDatabase;
