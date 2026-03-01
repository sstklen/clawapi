// VPS 資料庫管理模組
// 使用 bun:sqlite（Bun 內建），WAL 模式

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { migration001 } from './migrations/001-init';

// 裝置資料型別（對應 devices 資料表）
export interface Device {
  device_id: string;
  device_fingerprint: string;
  device_token: string;
  token_expires_at: string;
  client_version: string;
  os: string;
  arch: string;
  locale: string;
  timezone: string;
  region: string;
  assigned_region: string;
  vps_public_key_id: string | null;
  reputation_weight: number;
  reputation_tier: string;
  anomaly_count: number;
  status: string;
  suspended_reason: string | null;
  google_id_hash: string | null;
  google_email_masked: string | null;
  nickname: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

// 寫入操作回傳型別
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

// VPS 資料庫管理類別
export class VPSDatabase {
  private db: Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // 初始化時先建立 Database 物件（不含 :memory: 也支援）
    this.db = new Database(dbPath);
  }

  // 初始化：設定 PRAGMA、執行 migration
  async init(): Promise<void> {
    // 啟用 WAL 模式 + 外鍵 + busy timeout
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);

    // 執行初始 migration
    this.applyMigration();
  }

  // 關閉資料庫連線
  async close(): Promise<void> {
    this.db.close();
  }

  // 執行查詢，回傳結果陣列
  query<T>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    if (params && params.length > 0) {
      return stmt.all(...(params as SQLQueryBindings[])) as T[];
    }
    return stmt.all() as T[];
  }

  // 執行寫入操作，回傳影響筆數與最後插入 ID
  run(sql: string, params?: unknown[]): RunResult {
    const stmt = this.db.prepare(sql);
    let result: { changes: number; lastInsertRowid: number | bigint };
    if (params && params.length > 0) {
      result = stmt.run(...(params as SQLQueryBindings[]));
    } else {
      result = stmt.run();
    }
    return {
      changes: result.changes,
      lastInsertRowid: typeof result.lastInsertRowid === 'bigint'
        ? Number(result.lastInsertRowid)
        : result.lastInsertRowid,
    };
  }

  // 在 transaction 中執行操作（原子性）
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // WAL checkpoint — 手動觸發將 WAL 寫回主 DB 檔
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  }

  // 更新裝置最後活動時間
  updateDeviceLastSeen(deviceId: string): void {
    this.run(
      `UPDATE devices SET last_seen_at = datetime('now'), updated_at = datetime('now')
       WHERE device_id = ?`,
      [deviceId],
    );
  }

  // ===== 裝置相關快捷方法 =====

  // 依 device_id 取得裝置資料
  getDevice(deviceId: string): Device | null {
    const results = this.query<Device>(
      'SELECT * FROM devices WHERE device_id = ?',
      [deviceId],
    );
    return results[0] ?? null;
  }

  // 依 device_token 取得裝置資料（認證用）
  getDeviceByToken(token: string): Device | null {
    const results = this.query<Device>(
      'SELECT * FROM devices WHERE device_token = ?',
      [token],
    );
    return results[0] ?? null;
  }

  // ===== 內部方法 =====

  // 執行 migration（若尚未套用）
  private applyMigration(): void {
    // 確認 schema_version 表存在，不存在則執行 up SQL
    const tableExists = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`,
      )
      .get();

    if (!tableExists) {
      // 首次初始化，執行整個 migration SQL
      this.db.exec(migration001.up);
      // 寫入版本記錄
      this.run(
        'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)',
        [migration001.version, migration001.description],
      );
    } else {
      // 檢查此版本是否已套用
      const applied = this.query<{ version: number }>(
        'SELECT version FROM schema_version WHERE version = ?',
        [migration001.version],
      );
      if (applied.length === 0) {
        this.db.exec(migration001.up);
        this.run(
          'INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)',
          [migration001.version, migration001.description],
        );
      }
    }
  }
}
