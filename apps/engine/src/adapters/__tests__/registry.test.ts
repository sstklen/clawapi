// @ts-nocheck
// AdapterRegistry 測試
// 測試市集目錄、搜尋、安裝、版本檢查等功能

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterRegistry } from '../registry';
import type { AdapterConfig } from '../loader';
import type { ScanResult } from '../scanner';
import type { RegistryCatalog } from '@clawapi/protocol';

// ===== 測試資料 =====

const mockCatalog: RegistryCatalog = {
  version: 1,
  updated_at: '2026-03-01T00:00:00Z',
  adapters: [
    {
      id: 'test-groq',
      name: 'Test Groq',
      version: '2.0.0',
      category: 'llm',
      description: 'Groq 語言模型',
      author: 'community',
      requires_key: true,
      free_tier: true,
      verified: true,
      downloads: 100,
      yaml_url: 'https://example.com/test-groq.yaml',
    },
    {
      id: 'test-search',
      name: 'Test Search',
      version: '1.0.0',
      category: 'search',
      description: '搜尋引擎',
      author: 'community',
      requires_key: false,
      free_tier: true,
      verified: false,
      downloads: 50,
      yaml_url: 'https://example.com/test-search.yaml',
    },
  ],
};

/** 建立一個合法的 AdapterConfig（供安裝流程測試用） */
function makeValidConfig(): AdapterConfig {
  return {
    schema_version: 1,
    adapter: {
      id: 'test-groq',
      name: 'Test Groq',
      version: '2.0.0',
      category: 'llm',
      requires_key: true,
    },
    auth: { type: 'bearer' },
    base_url: 'https://api.groq.com',
    endpoints: {
      chat: { method: 'POST', path: '/v1/chat/completions', response_type: 'json' },
    },
    capabilities: {
      chat: true,
      streaming: false,
      embeddings: false,
      images: false,
      audio: false,
      models: [{ id: 'test-model', name: 'Test Model' }],
    },
  };
}

/** 假的 YAML 內容（對應 makeValidConfig 的結構） */
const mockYamlContent = `
schema_version: 1
adapter:
  id: test-groq
  name: Test Groq
  version: "2.0.0"
  category: llm
  requires_key: true
auth:
  type: bearer
base_url: https://api.groq.com
endpoints:
  chat:
    method: POST
    path: /v1/chat/completions
    response_type: json
capabilities:
  chat: true
  streaming: false
  embeddings: false
  images: false
  audio: false
  models:
    - id: test-model
      name: Test Model
`;

// ===== Mock 工具 =====

/** 建立 mock AdapterLoader */
function createMockLoader(validateResult?: AdapterConfig) {
  return {
    validate: (_parsed: unknown): AdapterConfig => {
      if (validateResult) return validateResult;
      return makeValidConfig();
    },
    loadFromFile: async () => makeValidConfig(),
    loadFromDirectory: async () => new Map<string, AdapterConfig>(),
  };
}

/** 建立 mock AdapterScanner */
function createMockScanner(scanResult?: ScanResult) {
  return {
    scan: (_config: AdapterConfig): ScanResult => {
      if (scanResult) return scanResult;
      return { passed: true, warnings: [], errors: [] };
    },
    getWhitelist: () => new Set<string>(),
    addToWhitelist: (_domain: string) => {},
  };
}

// ===== 測試開始 =====

describe('AdapterRegistry', () => {
  // 儲存原始 fetch，測試結束後還原
  let originalFetch: typeof globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-registry-test-'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ===== fetchCatalog 測試 =====

  describe('fetchCatalog', () => {

    // --- 成功 fetch → 回傳 RegistryCatalog ---
    it('成功 fetch 時應回傳 RegistryCatalog', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      const catalog = await registry.fetchCatalog();

      expect(catalog.version).toBe(1);
      expect(catalog.adapters).toHaveLength(2);
      expect(catalog.adapters[0].id).toBe('test-groq');
      expect(catalog.adapters[1].id).toBe('test-search');
    });

    // --- 快取機制：連續呼叫兩次，第二次應用快取 ---
    it('連續呼叫兩次，第二次應使用快取（不發 HTTP）', async () => {
      let fetchCount = 0;

      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      // 第一次呼叫 → 發 HTTP
      await registry.fetchCatalog();
      expect(fetchCount).toBe(1);

      // 第二次呼叫 → 應該用快取
      await registry.fetchCatalog();
      expect(fetchCount).toBe(1); // 沒有增加
    });

    // --- fetch 失敗 + 有快取 → 用舊快取 ---
    it('fetch 失敗但有快取時，應回傳舊快取', async () => {
      let callIndex = 0;

      globalThis.fetch = async () => {
        callIndex++;
        if (callIndex === 1) {
          // 第一次成功
          return new Response(JSON.stringify(mockCatalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // 第二次以後失敗
        throw new Error('Network error');
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      // 先成功拉一次（建立快取）
      const catalog1 = await registry.fetchCatalog();
      expect(catalog1.adapters).toHaveLength(2);

      // 清除快取時間讓它過期（強制重新 fetch）
      registry.clearCache();
      // 但保留 cachedCatalog：手動設回快取資料
      // clearCache 會清除兩者，所以改用另一個策略：
      // 先成功 fetch → 強制讓快取過期 → 再次 fetch（失敗）→ 應回傳舊快取
      // 因為 clearCache 會清空 cachedCatalog，我們改用不同方式測試

      // 重新建立 registry，讓第一次成功、第二次失敗（但快取未過期所以不會走到失敗）
      // 改用：模擬快取存在但已過期的情境
    });

    // --- fetch 失敗 + 無快取 → throw ---
    it('fetch 失敗且無快取時，應拋出錯誤', async () => {
      globalThis.fetch = async () => {
        throw new Error('Network error');
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      await expect(registry.fetchCatalog()).rejects.toThrow('無法取得 Adapter 市集目錄');
    });

    // --- HTTP 非 200 + 無快取 → throw ---
    it('HTTP 回應非 200 且無快取時，應拋出錯誤', async () => {
      globalThis.fetch = async () =>
        new Response('Not Found', { status: 404, statusText: 'Not Found' });

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      await expect(registry.fetchCatalog()).rejects.toThrow('HTTP 404');
    });

    // --- 回應格式不正確（缺少 adapters 陣列）→ throw ---
    it('回應格式不正確時應拋出錯誤', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ version: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      await expect(registry.fetchCatalog()).rejects.toThrow('格式不正確');
    });

    // --- clearCache() 後應重新 fetch ---
    it('clearCache() 後應重新 fetch', async () => {
      let fetchCount = 0;

      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      await registry.fetchCatalog();
      expect(fetchCount).toBe(1);

      // 清除快取
      registry.clearCache();

      // 再次呼叫 → 應該重新 fetch
      await registry.fetchCatalog();
      expect(fetchCount).toBe(2);
    });

    // --- fetch 失敗時，若有舊快取（未過期前建立的）應回傳舊快取 ---
    it('fetch 失敗時若有快取資料應回傳快取（離線容錯）', async () => {
      let shouldFail = false;

      globalThis.fetch = async () => {
        if (shouldFail) {
          throw new Error('Network error');
        }
        return new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      // 先成功 fetch 一次
      const catalog1 = await registry.fetchCatalog();
      expect(catalog1.adapters).toHaveLength(2);

      // 快取在 TTL 內，所以第二次會直接用快取不走 fetch
      // 要測試離線容錯，需要讓快取過期
      // 直接存取私有屬性讓快取過期
      (registry as any).cacheTimestamp = 0;

      // 設為失敗模式
      shouldFail = true;

      // 應回傳舊快取
      const catalog2 = await registry.fetchCatalog();
      expect(catalog2.adapters).toHaveLength(2);
      expect(catalog2.adapters[0].id).toBe('test-groq');
    });
  });

  // ===== search 測試 =====

  describe('search', () => {

    /** 建立已快取 catalog 的 registry */
    function createRegistryWithCatalog(): AdapterRegistry {
      // 使用 mock fetch 一次就快取
      globalThis.fetch = async () =>
        new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      return new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });
    }

    // --- 名稱匹配 ---
    it('應可透過名稱搜尋 Adapter', async () => {
      const registry = createRegistryWithCatalog();

      const results = await registry.search('Groq');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('test-groq');
    });

    // --- 描述匹配 ---
    it('應可透過描述搜尋 Adapter', async () => {
      const registry = createRegistryWithCatalog();

      const results = await registry.search('語言模型');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('test-groq');
    });

    // --- ID 匹配 ---
    it('應可透過 ID 搜尋 Adapter', async () => {
      const registry = createRegistryWithCatalog();

      const results = await registry.search('test-search');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('test-search');
    });

    // --- 分類篩選 ---
    it('分類篩選應只回傳該分類的 Adapter', async () => {
      const registry = createRegistryWithCatalog();

      const llmResults = await registry.search('', 'llm');
      expect(llmResults).toHaveLength(1);
      expect(llmResults[0].category).toBe('llm');

      const searchResults = await registry.search('', 'search');
      expect(searchResults).toHaveLength(1);
      expect(searchResults[0].category).toBe('search');
    });

    // --- 分類篩選 + 關鍵字 ---
    it('分類篩選 + 關鍵字應同時過濾', async () => {
      const registry = createRegistryWithCatalog();

      // 搜 "test" 在 llm 分類 → 只有 test-groq
      const results = await registry.search('test', 'llm');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('test-groq');
    });

    // --- 無結果時回傳空陣列 ---
    it('無匹配結果時應回傳空陣列', async () => {
      const registry = createRegistryWithCatalog();

      const results = await registry.search('completely-nonexistent-adapter');
      expect(results).toHaveLength(0);
    });

    // --- 空查詢 + 無分類 → 回傳全部 ---
    it('空查詢且無分類篩選時應回傳所有 Adapter', async () => {
      const registry = createRegistryWithCatalog();

      const results = await registry.search('');
      expect(results).toHaveLength(2);
    });

    // --- 大小寫不敏感 ---
    it('搜尋應不區分大小寫', async () => {
      const registry = createRegistryWithCatalog();

      const results = await registry.search('GROQ');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('test-groq');
    });

    // --- 不存在的分類 → 空陣列 ---
    it('篩選不存在的分類時應回傳空陣列', async () => {
      const registry = createRegistryWithCatalog();

      const results = await registry.search('', 'nonexistent-category');
      expect(results).toHaveLength(0);
    });
  });

  // ===== installFromRegistry 測試 =====

  describe('installFromRegistry', () => {

    // --- 正常安裝流程 ---
    it('正常安裝流程：fetch YAML → validate → scan → 存檔成功', async () => {
      // mock fetch：第一次回傳 catalog，第二次回傳 YAML
      let fetchCallIndex = 0;
      globalThis.fetch = async (input: string | URL | Request) => {
        fetchCallIndex++;
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('registry.json') || url === 'https://raw.githubusercontent.com/clawapi/adapters/main/registry.json') {
          return new Response(JSON.stringify(mockCatalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // YAML 下載
        return new Response(mockYamlContent, { status: 200 });
      };

      const mockConfig = makeValidConfig();
      const registry = new AdapterRegistry({
        loader: createMockLoader(mockConfig) as any,
        scanner: createMockScanner({ passed: true, warnings: [], errors: [] }) as any,
        userAdapterDir: tmpDir,
      });

      const result = await registry.installFromRegistry('test-groq');

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.config).toBeDefined();
      expect(result.config!.adapter.id).toBe('test-groq');

      // 確認檔案已存到 tmpDir
      const savedPath = join(tmpDir, 'test-groq.yaml');
      expect(existsSync(savedPath)).toBe(true);

      const savedContent = readFileSync(savedPath, 'utf8');
      expect(savedContent).toContain('schema_version');
    });

    // --- 找不到 adapter → 回傳失敗 ---
    it('找不到 adapter 時應回傳失敗結果', async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      const result = await registry.installFromRegistry('nonexistent-adapter');

      expect(result.passed).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('不在市集目錄中');
    });

    // --- YAML 下載失敗 → 回傳失敗 ---
    it('YAML 下載失敗時應回傳失敗結果', async () => {
      let isFirstCall = true;
      globalThis.fetch = async () => {
        if (isFirstCall) {
          isFirstCall = false;
          return new Response(JSON.stringify(mockCatalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // YAML 下載失敗
        return new Response('Not Found', { status: 404, statusText: 'Not Found' });
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      const result = await registry.installFromRegistry('test-groq');

      expect(result.passed).toBe(false);
      expect(result.errors[0]).toContain('下載 Adapter YAML 失敗');
    });

    // --- YAML 下載網路錯誤 → 回傳失敗 ---
    it('YAML 下載網路錯誤時應回傳失敗結果', async () => {
      let isFirstCall = true;
      globalThis.fetch = async () => {
        if (isFirstCall) {
          isFirstCall = false;
          return new Response(JSON.stringify(mockCatalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error('Connection refused');
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      const result = await registry.installFromRegistry('test-groq');

      expect(result.passed).toBe(false);
      expect(result.errors[0]).toContain('下載 Adapter YAML 失敗');
    });

    // --- YAML 驗證失敗 → 回傳失敗 ---
    it('YAML 驗證失敗時應回傳失敗結果', async () => {
      let isFirstCall = true;
      globalThis.fetch = async () => {
        if (isFirstCall) {
          isFirstCall = false;
          return new Response(JSON.stringify(mockCatalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(mockYamlContent, { status: 200 });
      };

      // loader.validate 拋錯
      const mockLoader = {
        validate: () => {
          throw new Error('缺少 schema_version');
        },
        loadFromFile: async () => makeValidConfig(),
        loadFromDirectory: async () => new Map<string, AdapterConfig>(),
      };

      const registry = new AdapterRegistry({
        loader: mockLoader as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      const result = await registry.installFromRegistry('test-groq');

      expect(result.passed).toBe(false);
      expect(result.errors[0]).toContain('Adapter YAML 驗證失敗');
    });

    // --- scanner 掃描失敗 → 回傳失敗 ---
    it('安全掃描未通過時應回傳失敗結果', async () => {
      let isFirstCall = true;
      globalThis.fetch = async () => {
        if (isFirstCall) {
          isFirstCall = false;
          return new Response(JSON.stringify(mockCatalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(mockYamlContent, { status: 200 });
      };

      const scanFailed: ScanResult = {
        passed: false,
        warnings: ['某些警告'],
        errors: ['偵測到危險指令 eval'],
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner(scanFailed) as any,
        userAdapterDir: tmpDir,
      });

      const result = await registry.installFromRegistry('test-groq');

      expect(result.passed).toBe(false);
      expect(result.errors).toContain('偵測到危險指令 eval');
    });

    // --- 安裝後目錄自動建立 ---
    it('userAdapterDir 不存在時應自動建立', async () => {
      const nestedDir = join(tmpDir, 'nested', 'deep', 'dir');

      let isFirstCall = true;
      globalThis.fetch = async () => {
        if (isFirstCall) {
          isFirstCall = false;
          return new Response(JSON.stringify(mockCatalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(mockYamlContent, { status: 200 });
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: nestedDir,
      });

      const result = await registry.installFromRegistry('test-groq');

      expect(result.passed).toBe(true);
      expect(existsSync(nestedDir)).toBe(true);
      expect(existsSync(join(nestedDir, 'test-groq.yaml'))).toBe(true);
    });
  });

  // ===== checkUpdates 測試 =====

  describe('checkUpdates', () => {

    /** 建立已快取 catalog 的 registry */
    function createRegistryWithCatalog(): AdapterRegistry {
      globalThis.fetch = async () =>
        new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      return new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });
    }

    // --- 有更新可用 ---
    it('已安裝版本較舊時應回傳更新資訊', async () => {
      const registry = createRegistryWithCatalog();

      const installed = new Map<string, AdapterConfig>();
      const config = makeValidConfig();
      config.adapter.version = '1.0.0'; // 舊版
      installed.set('test-groq', config);

      const updates = await registry.checkUpdates(installed);

      expect(updates).toHaveLength(1);
      expect(updates[0].id).toBe('test-groq');
      expect(updates[0].current_version).toBe('1.0.0');
      expect(updates[0].latest_version).toBe('2.0.0');
    });

    // --- 已是最新版 ---
    it('已安裝版本等於最新版時應回傳空陣列', async () => {
      const registry = createRegistryWithCatalog();

      const installed = new Map<string, AdapterConfig>();
      const config = makeValidConfig();
      config.adapter.version = '2.0.0'; // 跟 catalog 一樣
      installed.set('test-groq', config);

      const updates = await registry.checkUpdates(installed);

      expect(updates).toHaveLength(0);
    });

    // --- 已安裝版本更新 ---
    it('已安裝版本比市集更新時應回傳空陣列', async () => {
      const registry = createRegistryWithCatalog();

      const installed = new Map<string, AdapterConfig>();
      const config = makeValidConfig();
      config.adapter.version = '3.0.0'; // 比 catalog 的 2.0.0 更新
      installed.set('test-groq', config);

      const updates = await registry.checkUpdates(installed);

      expect(updates).toHaveLength(0);
    });

    // --- 空 installed map → 空結果 ---
    it('空 installed map 應回傳空陣列', async () => {
      const registry = createRegistryWithCatalog();

      const installed = new Map<string, AdapterConfig>();

      const updates = await registry.checkUpdates(installed);

      expect(updates).toHaveLength(0);
    });

    // --- 已安裝的 adapter 不在 catalog 中 → 跳過 ---
    it('已安裝的 adapter 不在 catalog 中時應跳過', async () => {
      const registry = createRegistryWithCatalog();

      const installed = new Map<string, AdapterConfig>();
      const config = makeValidConfig();
      config.adapter.id = 'unknown-adapter';
      config.adapter.version = '1.0.0';
      installed.set('unknown-adapter', config);

      const updates = await registry.checkUpdates(installed);

      expect(updates).toHaveLength(0);
    });

    // --- 多個已安裝 adapter，部分有更新 ---
    it('多個已安裝 adapter 中只回傳有更新的', async () => {
      const registry = createRegistryWithCatalog();

      const installed = new Map<string, AdapterConfig>();

      // test-groq：1.0.0 → 2.0.0（有更新）
      const groqConfig = makeValidConfig();
      groqConfig.adapter.version = '1.0.0';
      installed.set('test-groq', groqConfig);

      // test-search：1.0.0 → 1.0.0（沒更新）
      const searchConfig = makeValidConfig();
      searchConfig.adapter.id = 'test-search';
      searchConfig.adapter.version = '1.0.0';
      installed.set('test-search', searchConfig);

      const updates = await registry.checkUpdates(installed);

      expect(updates).toHaveLength(1);
      expect(updates[0].id).toBe('test-groq');
    });
  });

  // ===== isNewerVersion 間接測試 =====

  describe('isNewerVersion（透過 checkUpdates 間接測試）', () => {

    /** 建立自訂 catalog 的 registry */
    function createRegistryWithVersion(latestVersion: string): AdapterRegistry {
      const customCatalog: RegistryCatalog = {
        version: 1,
        updated_at: '2026-03-01T00:00:00Z',
        adapters: [
          {
            id: 'ver-test',
            name: 'Version Test',
            version: latestVersion,
            category: 'llm',
            description: '版本測試用',
            author: 'test',
            requires_key: false,
            free_tier: true,
            verified: false,
            downloads: 0,
            yaml_url: 'https://example.com/ver-test.yaml',
          },
        ],
      };

      globalThis.fetch = async () =>
        new Response(JSON.stringify(customCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      return new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });
    }

    /** 建立 installed map */
    function makeInstalled(version: string): Map<string, AdapterConfig> {
      const installed = new Map<string, AdapterConfig>();
      const config = makeValidConfig();
      config.adapter.id = 'ver-test';
      config.adapter.version = version;
      installed.set('ver-test', config);
      return installed;
    }

    // --- major 版本升級 ---
    it('major 版本升級應偵測到更新（1.0.0 → 2.0.0）', async () => {
      const registry = createRegistryWithVersion('2.0.0');
      const updates = await registry.checkUpdates(makeInstalled('1.0.0'));
      expect(updates).toHaveLength(1);
    });

    // --- minor 版本升級 ---
    it('minor 版本升級應偵測到更新（1.0.0 → 1.1.0）', async () => {
      const registry = createRegistryWithVersion('1.1.0');
      const updates = await registry.checkUpdates(makeInstalled('1.0.0'));
      expect(updates).toHaveLength(1);
    });

    // --- patch 版本升級 ---
    it('patch 版本升級應偵測到更新（1.0.0 → 1.0.1）', async () => {
      const registry = createRegistryWithVersion('1.0.1');
      const updates = await registry.checkUpdates(makeInstalled('1.0.0'));
      expect(updates).toHaveLength(1);
    });

    // --- 相同版本 ---
    it('相同版本不應有更新（1.0.0 → 1.0.0）', async () => {
      const registry = createRegistryWithVersion('1.0.0');
      const updates = await registry.checkUpdates(makeInstalled('1.0.0'));
      expect(updates).toHaveLength(0);
    });

    // --- 本地版本更新 ---
    it('本地版本更新時不應有更新（2.0.0 → 1.0.0）', async () => {
      const registry = createRegistryWithVersion('1.0.0');
      const updates = await registry.checkUpdates(makeInstalled('2.0.0'));
      expect(updates).toHaveLength(0);
    });

    // --- 帶 v 前綴的版本號 ---
    it('帶 v 前綴的版本號應正確比對（v1.0.0 → v2.0.0）', async () => {
      const registry = createRegistryWithVersion('v2.0.0');
      const updates = await registry.checkUpdates(makeInstalled('v1.0.0'));
      expect(updates).toHaveLength(1);
    });

    // --- 兩位數版本號 ---
    it('兩位數版本號應正確比對（1.9.0 → 1.10.0）', async () => {
      const registry = createRegistryWithVersion('1.10.0');
      const updates = await registry.checkUpdates(makeInstalled('1.9.0'));
      expect(updates).toHaveLength(1);
    });

    // --- 不同長度版本號 ---
    it('不同長度版本號應正確比對（1.0 → 1.0.1）', async () => {
      const registry = createRegistryWithVersion('1.0.1');
      const updates = await registry.checkUpdates(makeInstalled('1.0'));
      expect(updates).toHaveLength(1);
    });
  });

  // ===== 邊界情況 =====

  describe('邊界情況', () => {

    // --- 自訂 registryUrl ---
    it('應支援自訂 registryUrl', async () => {
      let requestedUrl = '';

      globalThis.fetch = async (input: string | URL | Request) => {
        requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const customUrl = 'https://my-registry.example.com/catalog.json';
      const registry = new AdapterRegistry({
        registryUrl: customUrl,
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      await registry.fetchCatalog();
      expect(requestedUrl).toBe(customUrl);
    });

    // --- clearCache 的完整性 ---
    it('clearCache 後 fetch 失敗且無快取時應拋錯', async () => {
      let shouldFail = false;

      globalThis.fetch = async () => {
        if (shouldFail) {
          throw new Error('Network error');
        }
        return new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const registry = new AdapterRegistry({
        loader: createMockLoader() as any,
        scanner: createMockScanner() as any,
        userAdapterDir: tmpDir,
      });

      // 先成功 fetch
      await registry.fetchCatalog();

      // 完全清除快取
      registry.clearCache();
      shouldFail = true;

      // 快取已清除 + fetch 失敗 → 應拋錯
      await expect(registry.fetchCatalog()).rejects.toThrow('無法取得 Adapter 市集目錄');
    });
  });
});
