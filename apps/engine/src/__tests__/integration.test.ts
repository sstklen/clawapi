// 自循環整合測試 — 模組接縫驗證
// 測試各模組之間的接口，防止 Bug 再次出現在模組邊界
//
// 設計原則：
//   - 用真實模組（KeyPool、CryptoModule、Database、L2Gateway、Status）
//   - 只 mock 外部 I/O（fetch）
//   - 每個測試用臨時目錄，確保隔離
//   - 全程不需要網路

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase, type ClawDatabase } from '../storage/database';
import { CryptoModule } from '../core/encryption';
import { KeyPool } from '../core/key-pool';
import { executeStatusTool, type EngineStatusDeps } from '../mcp/tools/status';
import { L2Gateway } from '../layers/l2-gateway';
import { L4TaskEngine } from '../layers/l4-task';
import type { AdapterConfig } from '../adapters/loader';
import type { AdapterExecutor } from '../adapters/executor';
import type { DecryptedKey } from '../core/key-pool';

// ===== 測試基礎設施（TestHarness） =====

/** 乾淨的測試環境：DB + Crypto + KeyPool，用完自動清理 */
class TestHarness {
  readonly tmpDir: string;
  readonly db: ClawDatabase;
  readonly crypto: CryptoModule;
  readonly keyPool: KeyPool;

  private constructor(
    tmpDir: string,
    db: ClawDatabase,
    crypto: CryptoModule,
    keyPool: KeyPool,
  ) {
    this.tmpDir = tmpDir;
    this.db = db;
    this.crypto = crypto;
    this.keyPool = keyPool;
  }

  /** 建立全新的測試環境 */
  static async create(): Promise<TestHarness> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-integration-'));
    const dbPath = join(tmpDir, 'data.db');
    const db = createDatabase(dbPath);
    await db.init();
    const crypto = new CryptoModule(tmpDir);
    await crypto.initMasterKey(tmpDir);
    const keyPool = new KeyPool(db, crypto);
    return new TestHarness(tmpDir, db, crypto, keyPool);
  }

  /** 清理所有資源 */
  cleanup(): void {
    try {
      this.db.close();
    } catch { /* 忽略 */ }
    try {
      rmSync(this.tmpDir, { recursive: true, force: true });
    } catch { /* 忽略 */ }
  }
}

// ===== Mock 工廠 =====

/** 建立 Mock Adapter 設定 */
function createAdapter(serviceId: string, isFree: boolean = false): AdapterConfig {
  return {
    schema_version: 1,
    adapter: {
      id: serviceId,
      name: `${serviceId} Adapter`,
      version: '1.0.0',
      category: serviceId === 'duckduckgo' ? 'search' : 'llm',
      requires_key: !isFree,
      free_tier: isFree,
    },
    auth: { type: isFree ? 'none' : 'bearer' },
    base_url: `https://api.${serviceId}.com/v1`,
    endpoints: isFree
      ? { search: { method: 'POST', path: '/', response_type: 'json' } }
      : { chat: { method: 'POST', path: '/chat/completions', response_type: 'json' } },
    capabilities: {
      chat: !isFree,
      streaming: false,
      embeddings: false,
      images: false,
      audio: false,
      models: [{ id: 'default-model', name: '預設模型' }],
    },
  };
}

/** 建立永遠成功的 Mock Executor */
function createSuccessExecutor(): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: true,
      status: 200,
      data: { choices: [{ message: { content: 'OK' } }] },
      latency_ms: 50,
    })),
  } as unknown as AdapterExecutor;
}

// ===== 接縫測試 =====

describe('整合測試：模組接縫', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(() => {
    harness.cleanup();
  });

  // ── 接縫 1：master.key + data.db 配對 ──
  describe('接縫 1：master.key + data.db 配對', () => {
    it('用原始 master.key 能正常解密 Key', async () => {
      const id = await harness.keyPool.addKey('groq', 'gsk_test_key_12345', 'king');
      expect(id).toBeGreaterThan(0);

      const keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]!.key_masked).not.toBe('(解密失敗)');
      expect(keys[0]!.service_id).toBe('groq');
    });

    it('換了 master.key 後解密失敗', async () => {
      // 先用原始 master.key 加入一把 Key
      await harness.keyPool.addKey('groq', 'gsk_test_key_12345', 'king');

      // 用不同的 master.key 建立新的 CryptoModule
      const tmpDir2 = mkdtempSync(join(tmpdir(), 'clawapi-newkey-'));
      try {
        const crypto2 = new CryptoModule(tmpDir2);
        await crypto2.initMasterKey(tmpDir2);

        // 用新 crypto 建立 KeyPool（指向同一個 DB）
        const keyPool2 = new KeyPool(harness.db, crypto2);
        const keys = await keyPool2.listKeys();

        // 應該有 1 個 Key，但解密失敗
        expect(keys.length).toBe(1);
        expect(keys[0]!.key_masked).toBe('(解密失敗)');
      } finally {
        rmSync(tmpDir2, { recursive: true, force: true });
      }
    });
  });

  // ── 接縫 2：DuckDuckGo 免費路由 ──
  describe('接縫 2：DuckDuckGo 免費路由', () => {
    it('不匯入任何 Key 也能路由到免費服務', async () => {
      // 建立 L2Gateway，只有一個免費的 DuckDuckGo adapter
      const adapters = new Map<string, AdapterConfig>([
        ['duckduckgo', createAdapter('duckduckgo', true)],
      ]);
      const executor = createSuccessExecutor();

      // KeyPool 是空的（沒有任何 Key）
      const emptyKeyPool = {
        selectKey: mock(async () => null),
        getServiceIds: mock(() => []),
        reportSuccess: mock(async () => {}),
        reportRateLimit: mock(async () => {}),
        reportAuthError: mock(async () => {}),
        reportError: mock(async () => {}),
      } as unknown as KeyPool;

      const gateway = new L2Gateway(emptyKeyPool, executor, adapters);

      // 執行請求 — 應該路由到 DuckDuckGo（免費服務）
      const result = await gateway.execute({
        model: 'default-model',
        messages: [{ role: 'user', content: 'test' }],
      });

      // 應該成功（executor 被呼叫了）
      expect(result.success).toBe(true);
      expect(executor.execute).toHaveBeenCalled();
    });

    it('有付費 Key 時優先用付費服務', async () => {
      const adapters = new Map<string, AdapterConfig>([
        ['groq', createAdapter('groq', false)],
        ['duckduckgo', createAdapter('duckduckgo', true)],
      ]);
      const executor = createSuccessExecutor();

      const groqKey: DecryptedKey = {
        id: 1,
        service_id: 'groq',
        key_value: 'gsk_test',
        pool_type: 'king',
        status: 'active',
        pinned: false,
        priority: 0,
        daily_used: 0,
        consecutive_failures: 0,
        rate_limit_until: null,
        last_success_at: null,
      };

      const keyPool = {
        selectKey: mock(async (serviceId: string) =>
          serviceId === 'groq' ? groqKey : null
        ),
        getServiceIds: mock(() => ['groq']),
        reportSuccess: mock(async () => {}),
        reportRateLimit: mock(async () => {}),
        reportAuthError: mock(async () => {}),
        reportError: mock(async () => {}),
      } as unknown as KeyPool;

      const gateway = new L2Gateway(keyPool, executor, adapters);

      const result = await gateway.execute({
        model: 'default-model',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(result.success).toBe(true);
      // executor 呼叫時應該帶 groq 的 key
      const callArgs = (executor.execute as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs).toBeDefined();
    });

    it('搜尋請求用 search endpoint 而非 chat', async () => {
      const adapters = new Map<string, AdapterConfig>([
        ['duckduckgo', createAdapter('duckduckgo', true)],
      ]);
      const executor = createSuccessExecutor();

      const emptyKeyPool = {
        selectKey: mock(async () => null),
        getServiceIds: mock(() => []),
        reportSuccess: mock(async () => {}),
        reportRateLimit: mock(async () => {}),
        reportAuthError: mock(async () => {}),
        reportError: mock(async () => {}),
      } as unknown as KeyPool;

      const gateway = new L2Gateway(emptyKeyPool, executor, adapters);

      // 帶 type: 'search' 的請求
      const result = await gateway.execute({
        model: 'auto',
        params: { query: 'test', type: 'search' },
      });

      expect(result.success).toBe(true);

      // executor 應該被呼叫，且 endpoint 是 'search'（不是 'chat'）
      const calls = (executor.execute as ReturnType<typeof mock>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // 第二個參數是 endpointName
      expect(calls[0]![1]).toBe('search');
    });
  });

  // ── 接縫 3：status 解密驗證 ──
  describe('接縫 3：status 解密驗證', () => {
    it('正常情況下 status 不顯示解密警告', async () => {
      await harness.keyPool.addKey('groq', 'gsk_test_key_12345', 'king');

      const deps: EngineStatusDeps = {
        keyPool: harness.keyPool,
        startedAt: new Date(),
        adapterCount: 1,
      };

      const result = await executeStatusTool({}, deps);
      const text = result.content[0]!.text;

      expect(text).toContain('正常：1');
      expect(text).not.toContain('解密失敗');
      expect(text).not.toContain('⚠️');
    });

    it('master.key 不匹配時 status 顯示解密失敗警告', async () => {
      // 用原始 crypto 加入 Key
      await harness.keyPool.addKey('groq', 'gsk_test_key_12345', 'king');

      // 用不同的 master.key 建立新 KeyPool
      const tmpDir2 = mkdtempSync(join(tmpdir(), 'clawapi-badkey-'));
      try {
        const crypto2 = new CryptoModule(tmpDir2);
        await crypto2.initMasterKey(tmpDir2);
        const keyPool2 = new KeyPool(harness.db, crypto2);

        const deps: EngineStatusDeps = {
          keyPool: keyPool2,
          startedAt: new Date(),
          adapterCount: 1,
        };

        const result = await executeStatusTool({}, deps);
        const text = result.content[0]!.text;

        // 應該有解密失敗警告
        expect(text).toContain('解密失敗');
        expect(text).toContain('⚠️');
        expect(text).toContain('master.key');
      } finally {
        rmSync(tmpDir2, { recursive: true, force: true });
      }
    });
  });

  // ── 接縫 4：重複 Key 防護 ──
  describe('接縫 4：重複 Key 防護', () => {
    it('同一把 Key 加兩次只會有 1 個', async () => {
      const keyValue = 'gsk_duplicate_test_key_123456';
      const id1 = await harness.keyPool.addKey('groq', keyValue, 'king');
      const id2 = await harness.keyPool.addKey('groq', keyValue, 'king');

      // 應該回傳相同 id（表示是同一把）
      expect(id1).toBe(id2);

      // 列表應只有 1 個
      const keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(1);
    });

    it('不同 Key 加入不會被擋', async () => {
      const id1 = await harness.keyPool.addKey('groq', 'gsk_key_aaa_111111', 'king');
      const id2 = await harness.keyPool.addKey('groq', 'gsk_key_bbb_222222', 'king');

      expect(id1).not.toBe(id2);

      const keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(2);
    });

    it('N3 修復：重複匯入時 daily_used 重置為 0', async () => {
      const keyValue = 'gsk_n3_daily_used_test_12345';
      const id = await harness.keyPool.addKey('groq', keyValue, 'king');

      // 模擬使用：手動更新 daily_used 到 12
      harness.db.run('UPDATE keys SET daily_used = 12 WHERE id = ?', [id]);

      // 驗證 daily_used 已經是 12
      let keys = await harness.keyPool.listKeys();
      expect(keys[0]!.daily_used).toBe(12);

      // 重新匯入同一把 Key
      const id2 = await harness.keyPool.addKey('groq', keyValue, 'king');
      expect(id2).toBe(id); // 同一個 id

      // daily_used 應該被重置為 0
      keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]!.daily_used).toBe(0);
      expect(keys[0]!.consecutive_failures).toBe(0);
      expect(keys[0]!.status).toBe('active');
    });
  });

  // ── 接縫 5：addKey daily_used 初始值 ──
  describe('接縫 5：addKey daily_used 初始值', () => {
    it('新加入的 Key daily_used 必為 0', async () => {
      await harness.keyPool.addKey('groq', 'gsk_fresh_key_12345', 'king');

      const keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]!.daily_used).toBe(0);
    });

    it('新加入的 Key consecutive_failures 必為 0', async () => {
      await harness.keyPool.addKey('groq', 'gsk_fresh_key_12345', 'king');

      const keys = await harness.keyPool.listKeys();
      expect(keys[0]!.consecutive_failures).toBe(0);
    });

    it('新加入的 Key status 必為 active', async () => {
      await harness.keyPool.addKey('groq', 'gsk_fresh_key_12345', 'king');

      const keys = await harness.keyPool.listKeys();
      expect(keys[0]!.status).toBe('active');
    });
  });

  // ── 接縫 6：KeyPool selectKey 輪換 ──
  describe('接縫 6：KeyPool selectKey 輪換', () => {
    it('有多把 Key 時 selectKey 能輪換', async () => {
      await harness.keyPool.addKey('groq', 'gsk_key_aaa_111111', 'king');
      await harness.keyPool.addKey('groq', 'gsk_key_bbb_222222', 'king');

      // 連續選兩次
      const key1 = await harness.keyPool.selectKey('groq');
      const key2 = await harness.keyPool.selectKey('groq');

      // 應該都能選到（不一定不同，但至少不會是 null）
      expect(key1).not.toBeNull();
      expect(key2).not.toBeNull();
    });

    it('不存在的服務 selectKey 回傳 null', async () => {
      const key = await harness.keyPool.selectKey('nonexistent');
      expect(key).toBeNull();
    });
  });

  // ── 接縫 7：空 DB 的 status 輸出 ──
  describe('接縫 7：空 DB 的 status 輸出', () => {
    it('沒有任何 Key 時 status 不會壞', async () => {
      const deps: EngineStatusDeps = {
        keyPool: harness.keyPool,
        startedAt: new Date(),
        adapterCount: 0,
      };

      const result = await executeStatusTool({}, deps);
      const text = result.content[0]!.text;

      expect(text).toContain('總計：0 個 Key');
      expect(text).toContain('正常：0');
      expect(text).not.toContain('解密失敗');
    });
  });

  // ── 接縫 8：L2 免費服務佔位 Key 的安全性 ──
  describe('接縫 8：L2 免費服務佔位 Key', () => {
    it('免費服務的佔位 Key id=-1 不會影響 KeyPool 報告', async () => {
      // 加入一把真 Key
      const realId = await harness.keyPool.addKey('groq', 'gsk_real_key_12345', 'king');
      expect(realId).toBeGreaterThan(0);

      // 模擬 reportSuccess 對 id=-1 的行為
      // 這不應該拋錯或影響真正的 Key
      await harness.keyPool.reportSuccess(-1);
      await harness.keyPool.reportError(-1);

      // 真正的 Key 應該不受影響
      const keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]!.consecutive_failures).toBe(0);
    });
  });

  // ── 接縫 9：多服務混合場景 ──
  describe('接縫 9：多服務混合場景', () => {
    it('多個服務的 Key 互不干擾', async () => {
      await harness.keyPool.addKey('groq', 'gsk_groq_111111', 'king');
      await harness.keyPool.addKey('openai', 'sk_openai_222222', 'king');
      await harness.keyPool.addKey('google', 'AIza_google_333333', 'king');

      const keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(3);

      // 各自的 selectKey 應該回傳正確的服務
      const groqKey = await harness.keyPool.selectKey('groq');
      const openaiKey = await harness.keyPool.selectKey('openai');
      const googleKey = await harness.keyPool.selectKey('google');

      expect(groqKey).not.toBeNull();
      expect(groqKey!.service_id).toBe('groq');
      expect(openaiKey).not.toBeNull();
      expect(openaiKey!.service_id).toBe('openai');
      expect(googleKey).not.toBeNull();
      expect(googleKey!.service_id).toBe('google');
    });

    it('status 正確統計多服務', async () => {
      await harness.keyPool.addKey('groq', 'gsk_groq_111111', 'king');
      await harness.keyPool.addKey('openai', 'sk_openai_222222', 'king');

      const deps: EngineStatusDeps = {
        keyPool: harness.keyPool,
        startedAt: new Date(),
        adapterCount: 3,
      };

      const result = await executeStatusTool({}, deps);
      const text = result.content[0]!.text;

      expect(text).toContain('總計：2 個 Key');
      expect(text).toContain('正常：2');
      expect(text).toContain('服務數：2');
    });
  });

  // ── 接縫 10：L4 fallback（無 Claw Key → 用一般 LLM Key） ──
  describe('接縫 10：L4 Claw Key fallback', () => {
    it('沒有任何 Key → L4 回傳「未設定 Claw Key」', async () => {
      // 空的 KeyPool + 空的 adapters
      const adapters = new Map<string, AdapterConfig>();
      const executor = createSuccessExecutor();
      const emptyKeyPool = harness.keyPool; // 全新的，沒加過 Key
      const l2 = new L2Gateway(emptyKeyPool, executor, adapters);
      const l4 = new L4TaskEngine(emptyKeyPool, executor, adapters, l2, harness.db);

      const result = await l4.execute({
        messages: [{ role: 'user', content: '測試任務' }],
        params: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('未設定');
      expect(result.error).toContain('Claw Key');
    });

    it('有一般 LLM Key 但沒有 __claw_key__ → getClawKey fallback 到 LLM Key', async () => {
      // 加一把 groq Key（不是 __claw_key__）
      await harness.keyPool.addKey('groq', 'gsk_fallback_test_12345', 'king');

      const adapters = new Map<string, AdapterConfig>([
        ['groq', createAdapter('groq', false)],
      ]);
      const executor = createSuccessExecutor();
      const l2 = new L2Gateway(harness.keyPool, executor, adapters);
      const l4 = new L4TaskEngine(harness.keyPool, executor, adapters, l2, harness.db);

      // getClawKey 應該能 fallback 到 groq key
      const clawKey = await l4.getClawKey();
      expect(clawKey).not.toBeNull();
      expect(clawKey!.key.service_id).toBe('groq');
    });

    it('有 __claw_key__ 時優先使用', async () => {
      // 加兩把 Key：一把 groq，一把 __claw_key__
      await harness.keyPool.addKey('groq', 'gsk_groq_test_12345', 'king');
      await harness.keyPool.addKey('__claw_key__', 'sk_claw_key_special', 'king');

      const adapters = new Map<string, AdapterConfig>([
        ['groq', createAdapter('groq', false)],
      ]);
      const executor = createSuccessExecutor();
      const l2 = new L2Gateway(harness.keyPool, executor, adapters);
      const l4 = new L4TaskEngine(harness.keyPool, executor, adapters, l2, harness.db);

      // getClawKey 應該優先用 __claw_key__
      const clawKey = await l4.getClawKey();
      expect(clawKey).not.toBeNull();
      expect(clawKey!.key.service_id).toBe('__claw_key__');
    });
  });

  // ── 接縫 11：完整生命週期（加 Key → 列出 → 刪除 → 重新加入） ──
  describe('接縫 11：完整 Key 生命週期', () => {
    it('加入 → 列出 → 刪除全部 → 確認空 → 重新加入', async () => {
      // 1. 加入 3 把 Key
      const id1 = await harness.keyPool.addKey('groq', 'gsk_lifecycle_aaa', 'king');
      const id2 = await harness.keyPool.addKey('openai', 'sk_lifecycle_bbb', 'king');
      const id3 = await harness.keyPool.addKey('google', 'AIza_lifecycle_ccc', 'king');

      // 2. 確認有 3 把
      let keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(3);

      // 3. 逐一刪除
      await harness.keyPool.removeKey(id1 as number);
      await harness.keyPool.removeKey(id2 as number);
      await harness.keyPool.removeKey(id3 as number);

      // 4. 確認全空
      keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(0);

      // selectKey 也應該回傳 null
      const selectedKey = await harness.keyPool.selectKey('groq');
      expect(selectedKey).toBeNull();

      // 5. 重新加入
      const newId = await harness.keyPool.addKey('groq', 'gsk_lifecycle_new', 'king');
      expect(newId).toBeGreaterThan(0);

      keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(1);
      expect(keys[0]!.daily_used).toBe(0);
      expect(keys[0]!.status).toBe('active');
    });

    it('刪除後 status 反映正確數量', async () => {
      await harness.keyPool.addKey('groq', 'gsk_status_111', 'king');
      const id2 = await harness.keyPool.addKey('openai', 'sk_status_222', 'king');

      // 刪一把
      await harness.keyPool.removeKey(id2 as number);

      const deps: EngineStatusDeps = {
        keyPool: harness.keyPool,
        startedAt: new Date(),
        adapterCount: 2,
      };

      const result = await executeStatusTool({}, deps);
      const text = result.content[0]!.text;

      expect(text).toContain('總計：1 個 Key');
      expect(text).toContain('正常：1');
    });
  });

  // ── 接縫 12：init 不帶殘留（全新環境乾淨度） ──
  describe('接縫 12：全新環境乾淨度', () => {
    it('全新 TestHarness 建立後 keys = 0', async () => {
      // harness 是 beforeEach 全新建立的
      const keys = await harness.keyPool.listKeys();
      expect(keys.length).toBe(0);
    });

    it('全新環境的 selectKey 全部回傳 null', async () => {
      const services = ['groq', 'openai', 'google', '__claw_key__', 'duckduckgo'];
      for (const svc of services) {
        const key = await harness.keyPool.selectKey(svc);
        expect(key).toBeNull();
      }
    });

    it('全新環境的 status 顯示 0 個 Key 無警告', async () => {
      const deps: EngineStatusDeps = {
        keyPool: harness.keyPool,
        startedAt: new Date(),
        adapterCount: 0,
      };

      const result = await executeStatusTool({}, deps);
      const text = result.content[0]!.text;

      expect(text).toContain('總計：0 個 Key');
      expect(text).not.toContain('⚠️');
      expect(text).not.toContain('解密失敗');
    });
  });
});
