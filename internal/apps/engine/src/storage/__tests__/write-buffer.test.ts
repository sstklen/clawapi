// write-buffer.test.ts — WriteBuffer 測試

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createDatabase, ClawDatabase } from '../database';
import { WriteBuffer } from '../write-buffer';

// ===== 輔助函式 =====

async function createTestDb(): Promise<ClawDatabase> {
  const db = createDatabase(':memory:');
  await db.init();
  return db;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 測試套件 =====

describe('WriteBuffer — critical 寫入', () => {
  let db: ClawDatabase;
  let buf: WriteBuffer;

  beforeEach(async () => {
    db = await createTestDb();
    buf = new WriteBuffer(db);
    // 不呼叫 start()，避免定時器干擾測試
  });

  afterEach(async () => {
    await buf.stop();
    await db.close();
  });

  it('critical 寫入應立即完成（不等 flush）', async () => {
    buf.enqueue({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      params: ['critical_test', 'value1'],
      priority: 'critical',
    });

    // 立即查詢，不等 flush
    // critical 操作是同步觸發的（但在 promise 中）
    // 等一個 tick 讓 promise resolve
    await sleep(10);

    const rows = db.query<{ key: string }>(
      "SELECT key FROM settings WHERE key = 'critical_test'"
    );
    expect(rows.length).toBe(1);
  });

  it('critical 寫入不應進入 queue', async () => {
    buf.enqueue({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      params: ['crit_key', 'val'],
      priority: 'critical',
    });

    // critical 操作不進 queue
    expect(buf.queue.length).toBe(0);
  });
});

describe('WriteBuffer — buffered 寫入', () => {
  let db: ClawDatabase;
  let buf: WriteBuffer;

  beforeEach(async () => {
    db = await createTestDb();
    buf = new WriteBuffer(db);
  });

  afterEach(async () => {
    await buf.stop();
    await db.close();
  });

  it('buffered 寫入應進入 queue', () => {
    buf.enqueue({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      params: ['buf_key1', 'val1'],
      priority: 'buffered',
    });

    expect(buf.queue.length).toBe(1);
  });

  it('buffered 寫入在 flush 前不應出現在 DB', () => {
    buf.enqueue({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      params: ['pre_flush_key', 'val'],
      priority: 'buffered',
    });

    // flush 前查不到
    const rows = db.query<{ key: string }>(
      "SELECT key FROM settings WHERE key = 'pre_flush_key'"
    );
    expect(rows.length).toBe(0);
  });

  it('flush 後 buffered 寫入應出現在 DB', async () => {
    buf.enqueue({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      params: ['post_flush_key', 'val'],
      priority: 'buffered',
    });

    await buf.flush();

    const rows = db.query<{ key: string }>(
      "SELECT key FROM settings WHERE key = 'post_flush_key'"
    );
    expect(rows.length).toBe(1);
  });

  it('flush 後 queue 應清空', async () => {
    buf.enqueue({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      params: ['flush_clear1', 'val'],
      priority: 'buffered',
    });
    buf.enqueue({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      params: ['flush_clear2', 'val'],
      priority: 'buffered',
    });

    expect(buf.queue.length).toBe(2);
    await buf.flush();
    expect(buf.queue.length).toBe(0);
  });

  it('批次 flush 應一次寫入多筆資料', async () => {
    for (let i = 0; i < 5; i++) {
      buf.enqueue({
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        params: [`batch_key_${i}`, `val_${i}`],
        priority: 'buffered',
      });
    }

    await buf.flush();

    const rows = db.query<{ key: string }>(
      "SELECT key FROM settings WHERE key LIKE 'batch_key_%'"
    );
    expect(rows.length).toBe(5);
  });
});

describe('WriteBuffer — maxSize 觸發 flush', () => {
  let db: ClawDatabase;
  let buf: WriteBuffer;

  beforeEach(async () => {
    db = await createTestDb();
    buf = new WriteBuffer(db);
  });

  afterEach(async () => {
    await buf.stop();
    await db.close();
  });

  it('queue 滿 100 時應自動 flush', async () => {
    // 插入 100 筆達到 maxSize
    for (let i = 0; i < 100; i++) {
      buf.enqueue({
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        params: [`maxsize_key_${i}`, `val_${i}`],
        priority: 'buffered',
      });
    }

    // 等待 flush 完成（flush 是 async，給一點時間）
    await sleep(50);

    const rows = db.query<{ key: string }>(
      "SELECT key FROM settings WHERE key LIKE 'maxsize_key_%'"
    );
    expect(rows.length).toBe(100);
  });
});

describe('WriteBuffer — stop', () => {
  it('stop 應執行最後一次 flush', async () => {
    const db = await createTestDb();
    const buf = new WriteBuffer(db);

    buf.enqueue({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
      params: ['stop_test_key', 'val'],
      priority: 'buffered',
    });

    // stop 會 flush 最後的 queue
    await buf.stop();

    const rows = db.query<{ key: string }>(
      "SELECT key FROM settings WHERE key = 'stop_test_key'"
    );
    expect(rows.length).toBe(1);

    await db.close();
  });
});

describe('WriteBuffer — 常數檢查', () => {
  it('maxSize 應為 100', () => {
    const buf = new WriteBuffer(null as unknown as ClawDatabase);
    expect(buf.maxSize).toBe(100);
  });

  it('flushInterval 應為 5000ms', () => {
    const buf = new WriteBuffer(null as unknown as ClawDatabase);
    expect(buf.flushInterval).toBe(5000);
  });
});
