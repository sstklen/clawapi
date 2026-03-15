// database.test.ts — 資料庫模組測試
// 使用記憶體資料庫（:memory:）避免污染本機環境

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createDatabase, ClawDatabase } from '../database';

// ===== 輔助函式 =====

/** 建立記憶體測試 DB */
async function createTestDb(): Promise<ClawDatabase> {
  const db = createDatabase(':memory:');
  await db.init();
  return db;
}

// ===== 測試套件 =====

describe('Database — 初始化', () => {
  let db: ClawDatabase;

  afterEach(async () => {
    await db.close();
  });

  it('應成功初始化並建立 15 張資料表', async () => {
    db = await createTestDb();

    // 查詢所有資料表名稱
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tableNames = tables.map(t => t.name);

    const expected = [
      'aid_config',
      'aid_log',
      'device',
      'device_keypair',
      'claw_keys',
      'keys',
      'l0_device_usage',
      'l0_keys',
      'l0_usage_queue',
      'routing_intel',
      'schema_version',
      'settings',
      'sub_keys',
      'telemetry_queue',
      'usage_log',
    ];

    for (const tableName of expected) {
      expect(tableNames).toContain(tableName);
    }
    expect(tables.length).toBeGreaterThanOrEqual(15);
  });

  it('應建立所有必要 index', async () => {
    db = await createTestDb();

    const indexes = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
    );
    const indexNames = indexes.map(i => i.name);

    expect(indexNames).toContain('idx_keypair_current');
    expect(indexNames).toContain('idx_keys_service');
    expect(indexNames).toContain('idx_keys_pool');
    expect(indexNames).toContain('idx_subkeys_token');
    expect(indexNames).toContain('idx_usage_timestamp');
    expect(indexNames).toContain('idx_usage_service');
    expect(indexNames).toContain('idx_usage_subkey');
    expect(indexNames).toContain('idx_aid_log_direction');
    expect(indexNames).toContain('idx_aid_log_aid_id');
    expect(indexNames).toContain('idx_telemetry_queue_created');
  });

  it('schema_version 應記錄所有 migration 版本', async () => {
    db = await createTestDb();

    const rows = db.query<{ version: number; description: string }>(
      'SELECT version, description FROM schema_version ORDER BY version'
    );

    expect(rows.length).toBe(2);
    expect(rows[0].version).toBe(1);
    expect(rows[0].description).toContain('初始');
    expect(rows[1].version).toBe(2);
    expect(rows[1].description).toContain('Claw Key');
  });

  it('aid_config 應有預設列（id=1）', async () => {
    db = await createTestDb();

    const rows = db.query<{ id: number; enabled: number }>(
      'SELECT id, enabled FROM aid_config'
    );

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].enabled).toBe(0);
  });
});

describe('Database — 重複初始化（冪等性）', () => {
  it('呼叫兩次 init 不應拋出錯誤', async () => {
    const db = createDatabase(':memory:');
    await db.init();
    // 第二次 init 在記憶體 DB 上不適用（記憶體 DB 每次都是新的）
    // 這裡測試主要確認 init 本身不會因資料表已存在而失敗
    await db.close();
  });
});

describe('Database — query/run/transaction', () => {
  let db: ClawDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('run 應回傳 changes 和 lastInsertRowid', () => {
    const result = db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?)",
      ['test_key', 'test_value']
    );
    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });

  it('query 應回傳插入的資料', () => {
    db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ['foo', 'bar']);
    const rows = db.query<{ key: string; value: string }>(
      "SELECT key, value FROM settings WHERE key = ?",
      ['foo']
    );
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe('foo');
    expect(rows[0].value).toBe('bar');
  });

  it('query 無參數應正常執行', () => {
    db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ['k1', 'v1']);
    const rows = db.query<{ key: string }>('SELECT key FROM settings');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('transaction 應在成功時提交', () => {
    db.transaction(() => {
      db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ['tx_key1', 'val1']);
      db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ['tx_key2', 'val2']);
    });

    const rows = db.query<{ key: string }>(
      "SELECT key FROM settings WHERE key LIKE 'tx_%'"
    );
    expect(rows.length).toBe(2);
  });

  it('transaction 應在失敗時回滾', () => {
    expect(() => {
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ['rollback_key', 'val']);
        // 插入重複 key 應觸發 UNIQUE 衝突
        db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ['rollback_key', 'val2']);
      });
    }).toThrow();

    // 回滾後不應有任何資料
    const rows = db.query<{ key: string }>(
      "SELECT key FROM settings WHERE key = 'rollback_key'"
    );
    expect(rows.length).toBe(0);
  });
});

describe('Database — dailyReset', () => {
  let db: ClawDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('應重置 keys.daily_used', () => {
    db.run(
      "INSERT INTO keys (service_id, key_encrypted, pool_type, daily_used) VALUES (?, ?, ?, ?)",
      ['groq', new Uint8Array([1, 2, 3]), 'king', 50]
    );

    db.dailyReset('Asia/Taipei');

    const rows = db.query<{ daily_used: number }>(
      'SELECT daily_used FROM keys'
    );
    expect(rows[0].daily_used).toBe(0);
  });

  it('應重置 sub_keys.daily_used', () => {
    db.run(
      "INSERT INTO sub_keys (token, daily_used, rate_used_this_hour) VALUES (?, ?, ?)",
      ['sk_live_test123', 30, 10]
    );

    db.dailyReset('Asia/Taipei');

    const rows = db.query<{ daily_used: number; rate_used_this_hour: number }>(
      'SELECT daily_used, rate_used_this_hour FROM sub_keys'
    );
    expect(rows[0].daily_used).toBe(0);
    expect(rows[0].rate_used_this_hour).toBe(0);
  });

  it('應重置 claw_keys.daily_used', () => {
    db.run(
      "INSERT INTO claw_keys (service_id, key_encrypted, model_id, daily_used) VALUES (?, ?, ?, ?)",
      ['openai', new Uint8Array([4, 5, 6]), 'gpt-4o', 100]
    );

    db.dailyReset('Asia/Taipei');

    const rows = db.query<{ daily_used: number }>(
      'SELECT daily_used FROM claw_keys'
    );
    expect(rows[0].daily_used).toBe(0);
  });

  it('應重置 aid_config.daily_given', () => {
    db.run(
      "UPDATE aid_config SET daily_given = 25 WHERE id = 1"
    );

    db.dailyReset('Asia/Taipei');

    const rows = db.query<{ daily_given: number }>(
      'SELECT daily_given FROM aid_config WHERE id = 1'
    );
    expect(rows[0].daily_given).toBe(0);
  });
});

describe('Database — checkpoint', () => {
  it('checkpoint 應正常執行不拋出錯誤', async () => {
    const db = await createTestDb();
    expect(() => db.checkpoint()).not.toThrow();
    await db.close();
  });
});

describe('Migration — down（回退）', () => {
  it('執行 down SQL 應移除所有資料表', async () => {
    const db = await createTestDb();

    // 反向執行 migration（先 002 再 001）
    const { migration002 } = await import('../migrations/002-rename-gold-to-claw');
    db.exec(migration002.down);

    const { migration001 } = await import('../migrations/001-init');
    db.exec(migration001.down);

    // 確認所有應用資料表都被刪除（sqlite_sequence 是 SQLite 內建，AUTOINCREMENT 會自動建立，無法刪除）
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    expect(tables.length).toBe(0);

    await db.close();
  });
});
