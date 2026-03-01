// Key 池管理模組測試
// 使用記憶體 SQLite + 臨時目錄，確保測試隔離

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../../storage/database';
import { CryptoModule } from '../encryption';
import { KeyPool } from '../key-pool';

// ===== 測試輔助函式 =====

/**
 * 建立測試用的 DB + CryptoModule + KeyPool
 * 使用臨時目錄，確保每次測試都是乾淨的狀態
 */
async function createTestKeyPool(): Promise<{
  keyPool: KeyPool;
  tmpDir: string;
  cleanup: () => void;
}> {
  // 建立臨時目錄
  const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-test-'));

  // 使用記憶體 DB
  const db = createDatabase(':memory:');
  await db.init();

  // 初始化 CryptoModule（使用臨時目錄存放 master.key）
  const crypto = new CryptoModule(tmpDir);
  await crypto.initMasterKey(tmpDir);

  // 建立 KeyPool
  const keyPool = new KeyPool(db, crypto);

  const cleanup = () => {
    try {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理錯誤
    }
  };

  return { keyPool, tmpDir, cleanup };
}

// ===== 測試案例 =====

describe('KeyPool', () => {
  // --- 測試 1：addKey + listKeys（遮罩顯示） ---
  it('應可新增 Key 並以遮罩格式列出', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      // 新增一個 king pool key
      const id = await keyPool.addKey('groq', 'gsk_1234567890abcdef1234', 'king', '測試用 Key');
      expect(id).toBeGreaterThan(0);

      // 列出所有 Key
      const keys = await keyPool.listKeys();
      expect(keys.length).toBe(1);

      const key = keys[0]!;
      expect(key.id).toBe(id);
      expect(key.service_id).toBe('groq');
      expect(key.pool_type).toBe('king');
      expect(key.label).toBe('測試用 Key');
      expect(key.status).toBe('active');
      expect(key.pinned).toBe(false);

      // 驗證遮罩格式（不含明文）
      expect(key.key_masked).not.toContain('1234567890abcdef1234');
      expect(key.key_masked).toContain('****');
    } finally {
      cleanup();
    }
  });

  // --- 測試 2：removeKey ---
  it('應可刪除指定 Key', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      const id = await keyPool.addKey('openai', 'sk-test1234567890abcdef', 'king');

      // 刪除前有一個
      let keys = await keyPool.listKeys();
      expect(keys.length).toBe(1);

      await keyPool.removeKey(id);

      // 刪除後變零個
      keys = await keyPool.listKeys();
      expect(keys.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  // --- 測試 3：同服務超過 5 把 → 拒絕 ---
  it('同服務超過 5 把 Key 時應拋出錯誤', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      // 新增 5 把（應成功）
      for (let i = 1; i <= 5; i++) {
        await keyPool.addKey('anthropic', `sk-ant-key${i}test12345678`, 'king');
      }

      // 第 6 把應拋出錯誤
      await expect(
        keyPool.addKey('anthropic', 'sk-ant-key6test12345678', 'king')
      ).rejects.toThrow('Key 數量上限');
    } finally {
      cleanup();
    }
  });

  // --- 測試 4：selectKey → Round-Robin 分布 ---
  it('selectKey 應輪流選取多把 Key', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      // 新增 3 把 Key
      await keyPool.addKey('groq', 'gsk_key1_1234567890abcde', 'king');
      await keyPool.addKey('groq', 'gsk_key2_1234567890abcde', 'king');
      await keyPool.addKey('groq', 'gsk_key3_1234567890abcde', 'king');

      // 選取 6 次，應覆蓋所有 Key
      const selected: string[] = [];
      for (let i = 0; i < 6; i++) {
        const key = await keyPool.selectKey('groq', 'king');
        expect(key).not.toBeNull();
        selected.push(key!.key_value);
      }

      // 每把 Key 應被選中 2 次
      const key1Count = selected.filter(k => k.includes('key1')).length;
      const key2Count = selected.filter(k => k.includes('key2')).length;
      const key3Count = selected.filter(k => k.includes('key3')).length;

      expect(key1Count).toBe(2);
      expect(key2Count).toBe(2);
      expect(key3Count).toBe(2);
    } finally {
      cleanup();
    }
  });

  // --- 測試 5：pinned Key 最優先 ---
  it('pinned Key 應排在最高優先級', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      // 新增一般 Key
      await keyPool.addKey('openai', 'sk-normal1234567890abcdef', 'king');
      await keyPool.addKey('openai', 'sk-normal9876543210fedcba', 'king');

      // 手動設定 pinned Key（直接寫 DB）
      // 先新增再用 DB 設定 pinned=1
      const pinnedId = await keyPool.addKey('openai', 'sk-pinned1234567890abcde', 'king', 'pinned Key');

      // 直接更新 DB 設定 pinned=1
      // 透過反射取得 db
      const db = (keyPool as unknown as { db: { run: (sql: string, params?: unknown[]) => void } }).db;
      db.run('UPDATE keys SET pinned = 1 WHERE id = ?', [pinnedId]);

      // 多次選取，都應選到 pinned Key
      for (let i = 0; i < 5; i++) {
        const key = await keyPool.selectKey('openai', 'king');
        expect(key).not.toBeNull();
        expect(key!.key_value).toContain('pinned');
      }
    } finally {
      cleanup();
    }
  });

  // --- 測試 6：跳過 dead 和冷卻中的 rate_limited ---
  it('selectKey 應跳過 dead 和冷卻中的 rate_limited Key', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      const id1 = await keyPool.addKey('groq', 'gsk_dead1234567890abcdef', 'king');
      const id2 = await keyPool.addKey('groq', 'gsk_limited123456789abc', 'king');
      const id3 = await keyPool.addKey('groq', 'gsk_active12345678901ab', 'king');

      // 讓 id1 變 dead
      await keyPool.reportAuthError(id1);

      // 讓 id2 變 rate_limited（冷卻中）
      await keyPool.reportRateLimit(id2);

      // 選取多次，只應選到 id3
      for (let i = 0; i < 3; i++) {
        const key = await keyPool.selectKey('groq', 'king');
        expect(key).not.toBeNull();
        expect(key!.id).toBe(id3);
      }
    } finally {
      cleanup();
    }
  });

  // --- 測試 7：reportSuccess → active + failures reset ---
  it('reportSuccess 應重置失敗計數並標記為 active', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      const id = await keyPool.addKey('openai', 'sk-success1234567890abc', 'king');

      // 先製造一些失敗紀錄
      const db = (keyPool as unknown as { db: { run: (sql: string, params?: unknown[]) => void } }).db;
      db.run('UPDATE keys SET consecutive_failures = 2 WHERE id = ?', [id]);

      // 回報成功
      await keyPool.reportSuccess(id);

      // 查詢 DB 確認
      const rows = (keyPool as unknown as { db: { query: <T>(sql: string, params?: unknown[]) => T[] } }).db
        .query<{ status: string; consecutive_failures: number; daily_used: number; last_success_at: string | null }>(
          'SELECT status, consecutive_failures, daily_used, last_success_at FROM keys WHERE id = ?',
          [id]
        );

      expect(rows[0]!.status).toBe('active');
      expect(rows[0]!.consecutive_failures).toBe(0);
      expect(rows[0]!.daily_used).toBe(1);
      expect(rows[0]!.last_success_at).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  // --- 測試 8：reportRateLimit → rate_limited + 退避時間 ---
  it('reportRateLimit 應設定冷卻時間（指數退避）', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      const id = await keyPool.addKey('groq', 'gsk_ratelimit12345678901', 'king');
      const before = new Date();

      await keyPool.reportRateLimit(id);

      const rows = (keyPool as unknown as { db: { query: <T>(sql: string, params?: unknown[]) => T[] } }).db
        .query<{ status: string; rate_limit_until: string | null; consecutive_failures: number }>(
          'SELECT status, rate_limit_until, consecutive_failures FROM keys WHERE id = ?',
          [id]
        );

      expect(rows[0]!.status).toBe('rate_limited');
      expect(rows[0]!.rate_limit_until).not.toBeNull();

      // 退避時間至少 1 秒
      const rateLimitUntil = new Date(rows[0]!.rate_limit_until!);
      expect(rateLimitUntil.getTime()).toBeGreaterThan(before.getTime());
    } finally {
      cleanup();
    }
  });

  // --- 測試 9：reportAuthError → dead ---
  it('reportAuthError 應將 Key 標記為 dead', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      const id = await keyPool.addKey('anthropic', 'sk-ant-autherr1234567890', 'king');

      await keyPool.reportAuthError(id);

      const rows = (keyPool as unknown as { db: { query: <T>(sql: string, params?: unknown[]) => T[] } }).db
        .query<{ status: string }>(
          'SELECT status FROM keys WHERE id = ?',
          [id]
        );

      expect(rows[0]!.status).toBe('dead');
    } finally {
      cleanup();
    }
  });

  // --- 測試 10：reportError × 3 → dead ---
  it('reportError 連續 3 次後應自動變 dead', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      const id = await keyPool.addKey('deepseek', 'sk-deepseek-err12345678', 'king');

      // 第 1 次錯誤
      await keyPool.reportError(id);
      let rows = (keyPool as unknown as { db: { query: <T>(sql: string, params?: unknown[]) => T[] } }).db
        .query<{ status: string; consecutive_failures: number }>(
          'SELECT status, consecutive_failures FROM keys WHERE id = ?',
          [id]
        );
      expect(rows[0]!.status).toBe('active');
      expect(rows[0]!.consecutive_failures).toBe(1);

      // 第 2 次錯誤
      await keyPool.reportError(id);
      rows = (keyPool as unknown as { db: { query: <T>(sql: string, params?: unknown[]) => T[] } }).db
        .query<{ status: string; consecutive_failures: number }>(
          'SELECT status, consecutive_failures FROM keys WHERE id = ?',
          [id]
        );
      expect(rows[0]!.status).toBe('active');
      expect(rows[0]!.consecutive_failures).toBe(2);

      // 第 3 次錯誤 → dead
      await keyPool.reportError(id);
      rows = (keyPool as unknown as { db: { query: <T>(sql: string, params?: unknown[]) => T[] } }).db
        .query<{ status: string; consecutive_failures: number }>(
          'SELECT status, consecutive_failures FROM keys WHERE id = ?',
          [id]
        );
      expect(rows[0]!.status).toBe('dead');
      expect(rows[0]!.consecutive_failures).toBe(3);
    } finally {
      cleanup();
    }
  });

  // --- 測試 11：dailyReset → daily_used = 0 ---
  it('dailyReset 應重置所有 Key 的 daily_used 為 0', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      const id1 = await keyPool.addKey('groq', 'gsk_daily1234567890abcde', 'king');
      const id2 = await keyPool.addKey('openai', 'sk-daily1234567890abcde', 'friend');

      // 模擬使用過
      await keyPool.reportSuccess(id1);
      await keyPool.reportSuccess(id1);
      await keyPool.reportSuccess(id2);

      // 確認 daily_used > 0
      const db = (keyPool as unknown as { db: { query: <T>(sql: string, params?: unknown[]) => T[] } }).db;
      let rows = db.query<{ daily_used: number }>(
        'SELECT daily_used FROM keys WHERE id IN (?, ?) ORDER BY id',
        [id1, id2]
      );
      expect(rows[0]!.daily_used).toBe(2);
      expect(rows[1]!.daily_used).toBe(1);

      // 執行每日重置
      await keyPool.dailyReset();

      // 確認重置為 0
      rows = db.query<{ daily_used: number }>(
        'SELECT daily_used FROM keys WHERE id IN (?, ?) ORDER BY id',
        [id1, id2]
      );
      expect(rows[0]!.daily_used).toBe(0);
      expect(rows[1]!.daily_used).toBe(0);
    } finally {
      cleanup();
    }
  });

  // --- 測試 12：selectKeyWithFallback: king 空 → friend ---
  it('selectKeyWithFallback 在 king 池空時應回退到 friend 池', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      // 只在 friend 池新增 Key
      await keyPool.addKey('openai', 'sk-friend1234567890abcde', 'friend');

      const result = await keyPool.selectKeyWithFallback('openai');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('friend');
      expect(result!.key.pool_type).toBe('friend');
    } finally {
      cleanup();
    }
  });

  // --- 附加測試：selectKeyWithFallback 優先 king ---
  it('selectKeyWithFallback 在 king 池有 Key 時應優先使用 king', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      await keyPool.addKey('groq', 'gsk_king1234567890abcdef', 'king');
      await keyPool.addKey('groq', 'gsk_friend123456789012a', 'friend');

      const result = await keyPool.selectKeyWithFallback('groq');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('king');
      expect(result!.key.pool_type).toBe('king');
    } finally {
      cleanup();
    }
  });

  // --- 附加測試：selectKeyWithFallback 全空回傳 null ---
  it('selectKeyWithFallback 在無可用 Key 時應回傳 null', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      const result = await keyPool.selectKeyWithFallback('groq');
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  // --- 附加測試：listKeys 用 serviceId 過濾 ---
  it('listKeys 可以按 serviceId 過濾', async () => {
    const { keyPool, cleanup } = await createTestKeyPool();
    try {
      await keyPool.addKey('groq', 'gsk_test1234567890abcdef', 'king');
      await keyPool.addKey('openai', 'sk-test1234567890abcdef', 'king');

      const groqKeys = await keyPool.listKeys('groq');
      expect(groqKeys.length).toBe(1);
      expect(groqKeys[0]!.service_id).toBe('groq');

      const allKeys = await keyPool.listKeys();
      expect(allKeys.length).toBe(2);
    } finally {
      cleanup();
    }
  });
});
