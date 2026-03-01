// Adapter 系統測試
// 測試 AdapterLoader、AdapterScanner、AdapterExecutor 以及 15 個官方 YAML

import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AdapterLoader } from '../loader';
import { AdapterScanner } from '../scanner';
import { AdapterExecutor } from '../executor';
import type { AdapterConfig } from '../loader';

// 官方 YAML 目錄路徑
const SCHEMAS_DIR = join(import.meta.dir, '../schemas');

// ===== AdapterLoader 測試 =====

describe('AdapterLoader', () => {

  // --- 測試 1：loadFromFile 載入 groq.yaml 成功 ---
  it('應可成功載入 groq.yaml', async () => {
    const loader = new AdapterLoader();
    const config = await loader.loadFromFile(join(SCHEMAS_DIR, 'groq.yaml'));

    expect(config.adapter.id).toBe('groq');
    expect(config.adapter.name).toBe('Groq');
    expect(config.schema_version).toBe(1);
    expect(config.auth.type).toBe('bearer');
    expect(config.base_url).toContain('api.groq.com');
    expect(config.capabilities.chat).toBe(true);
    expect(config.capabilities.models.length).toBeGreaterThan(0);
  });

  // --- 測試 2：validate 缺少必填欄位 → 拋錯 ---
  it('validate 缺少 schema_version 時應拋出錯誤', () => {
    const loader = new AdapterLoader();

    const invalidConfig = {
      // 缺少 schema_version
      adapter: {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        category: 'llm',
        requires_key: true,
      },
      auth: { type: 'bearer' },
      base_url: 'https://api.test.com',
      endpoints: {
        chat: { method: 'POST', path: '/v1/chat' },
      },
      capabilities: {
        chat: true,
        streaming: false,
        embeddings: false,
        images: false,
        audio: false,
        models: [],
      },
    };

    expect(() => loader.validate(invalidConfig)).toThrow('schema_version');
  });

  it('validate 缺少 adapter.id 時應拋出錯誤', () => {
    const loader = new AdapterLoader();

    const invalidConfig = {
      schema_version: 1,
      adapter: {
        // 缺少 id
        name: 'Test',
        version: '1.0.0',
        category: 'llm',
        requires_key: true,
      },
      auth: { type: 'bearer' },
      base_url: 'https://api.test.com',
      endpoints: {
        chat: { method: 'POST', path: '/v1/chat' },
      },
      capabilities: {
        chat: true,
        streaming: false,
        embeddings: false,
        images: false,
        audio: false,
        models: [],
      },
    };

    expect(() => loader.validate(invalidConfig)).toThrow();
  });

  it('validate 缺少 base_url 時應拋出錯誤', () => {
    const loader = new AdapterLoader();

    const invalidConfig = {
      schema_version: 1,
      adapter: {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        category: 'llm',
        requires_key: true,
      },
      auth: { type: 'bearer' },
      // 缺少 base_url
      endpoints: {
        chat: { method: 'POST', path: '/v1/chat' },
      },
      capabilities: {
        chat: true,
        streaming: false,
        embeddings: false,
        images: false,
        audio: false,
        models: [],
      },
    };

    expect(() => loader.validate(invalidConfig)).toThrow('base_url');
  });
});

// ===== AdapterScanner 測試 =====

describe('AdapterScanner', () => {

  /** 建立最小合法的 AdapterConfig（供測試用） */
  function makeConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
    return {
      schema_version: 1,
      adapter: {
        id: 'test',
        name: 'Test Adapter',
        version: '1.0.0',
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
      ...overrides,
    };
  }

  // --- 測試 3：安全掃描：合法 URL → pass ---
  it('官方 URL 應通過安全掃描（無 warning）', () => {
    const scanner = new AdapterScanner();
    const config = makeConfig({ base_url: 'https://api.groq.com' });
    const result = scanner.scan(config);

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // --- 測試 4：安全掃描：未知 URL → warning ---
  it('未知域名應觸發 warning（但不阻止使用）', () => {
    const scanner = new AdapterScanner();
    const config = makeConfig({ base_url: 'https://unknown-provider.example.com' });
    const result = scanner.scan(config);

    expect(result.passed).toBe(true); // 只有 warning，仍通過
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('unknown-provider.example.com');
  });

  // --- 測試 5：安全掃描：{{ key }} 模板 → error ---
  it('含有 {{ key }} 模板的 Adapter 應觸發錯誤', () => {
    const scanner = new AdapterScanner();
    const config = makeConfig({
      endpoints: {
        chat: {
          method: 'POST',
          path: '/v1/chat',
          body: {
            // 危險的模板：直接嵌入 API Key
            auth_token: '{{ key }}',
          },
        },
      },
    });
    const result = scanner.scan(config);

    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('key');
  });

  // --- 測試 6：安全掃描：eval() → error ---
  it('含有 eval 危險指令的 Adapter 應觸發錯誤', () => {
    const scanner = new AdapterScanner();
    const config = makeConfig({
      endpoints: {
        chat: {
          method: 'POST',
          path: '/v1/chat',
          body: {
            // 危險：嘗試注入 eval
            script: 'eval(maliciousCode)',
          },
        },
      },
    });
    const result = scanner.scan(config);

    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('eval');
  });

  it('含有 exec 危險指令應觸發錯誤', () => {
    const scanner = new AdapterScanner();
    const config = makeConfig({
      base_url: 'https://api.groq.com/exec(something)',
    });
    const result = scanner.scan(config);

    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('exec');
  });

  it('含有 {{ env.SECRET }} 模板應觸發錯誤', () => {
    const scanner = new AdapterScanner();
    const config = makeConfig({
      endpoints: {
        chat: {
          method: 'POST',
          path: '/v1/chat',
          body: {
            dangerous: '{{ env.SECRET_KEY }}',
          },
        },
      },
    });
    const result = scanner.scan(config);

    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ===== AdapterExecutor 模板替換測試 =====

describe('AdapterExecutor.renderTemplate', () => {
  // 建立一個假的 KeyPool（只測試模板替換，不需要真實 DB）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const executor = new AdapterExecutor(null as any);

  // --- 測試 7：renderTemplate 替換 {{ model }} ---
  it('應正確替換 {{ model }} 變數', () => {
    const result = executor.renderTemplate(
      '{"model": "{{ model }}"}',
      { model: 'llama-3.3-70b' }
    );
    expect(result).toBe('{"model": "llama-3.3-70b"}');
  });

  // --- 測試 8：renderTemplate 有 default 值 ---
  it('缺少參數時應使用 default 值', () => {
    const result = executor.renderTemplate(
      '{{ temperature | default: 0.7 }}',
      {} // 沒有提供 temperature
    );
    expect(result).toBe('0.7');
  });

  it('有提供參數時應忽略 default 值', () => {
    const result = executor.renderTemplate(
      '{{ temperature | default: 0.7 }}',
      { temperature: 0.5 }
    );
    expect(result).toBe('0.5');
  });

  it('應正確替換多個變數', () => {
    const result = executor.renderTemplate(
      'model={{ model }}&temp={{ temperature | default: 1.0 }}',
      { model: 'gpt-4o', temperature: 0.8 }
    );
    expect(result).toBe('model=gpt-4o&temp=0.8');
  });

  it('應將陣列/物件序列化為 JSON', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = executor.renderTemplate(
      '{{ messages }}',
      { messages }
    );
    expect(result).toBe(JSON.stringify(messages));
  });
});

// ===== 官方 YAML 批量測試 =====

describe('官方 Adapter YAML', () => {
  const OFFICIAL_ADAPTER_IDS = [
    'groq', 'gemini', 'cerebras', 'sambanova', 'qwen',
    'ollama', 'duckduckgo', 'openai', 'anthropic', 'deepseek',
    'brave-search', 'tavily', 'serper', 'openrouter', 'deepl',
  ];

  // --- 測試 9：15 個 YAML 全部載入成功 ---
  it('應可成功載入所有 15 個官方 Adapter', async () => {
    const loader = new AdapterLoader();
    const adapters = await loader.loadFromDirectory(SCHEMAS_DIR);

    // 確認 15 個都有
    expect(adapters.size).toBe(15);

    for (const id of OFFICIAL_ADAPTER_IDS) {
      expect(adapters.has(id)).toBe(true);
    }
  });

  // --- 測試 10：15 個 YAML 全部通過安全掃描 ---
  it('所有官方 Adapter 應通過安全掃描（無 errors）', async () => {
    const loader = new AdapterLoader();
    const scanner = new AdapterScanner();
    const adapters = await loader.loadFromDirectory(SCHEMAS_DIR);

    for (const [id, config] of adapters) {
      const result = scanner.scan(config);
      expect(result.errors).toHaveLength(0);
      // 官方 Adapter 不應有 errors（warnings 可以有）
      if (result.errors.length > 0) {
        console.error(`Adapter "${id}" 安全掃描失敗：`, result.errors);
      }
    }
  });

  // 逐一測試每個 Adapter 的基本 schema
  for (const adapterId of OFFICIAL_ADAPTER_IDS) {
    it(`${adapterId}.yaml 應有正確的必填欄位`, async () => {
      const loader = new AdapterLoader();
      const config = await loader.loadFromFile(join(SCHEMAS_DIR, `${adapterId}.yaml`));

      expect(config.adapter.id).toBe(adapterId);
      expect(config.schema_version).toBe(1);
      expect(config.base_url).toBeTruthy();
      expect(Object.keys(config.endpoints).length).toBeGreaterThan(0);
      expect(config.capabilities.models).toBeDefined();
      expect(typeof config.capabilities.chat).toBe('boolean');
      expect(typeof config.capabilities.streaming).toBe('boolean');
    });
  }

  // Ollama 不需要 Key
  it('ollama.yaml 的 requires_key 應為 false', async () => {
    const loader = new AdapterLoader();
    const config = await loader.loadFromFile(join(SCHEMAS_DIR, 'ollama.yaml'));
    expect(config.adapter.requires_key).toBe(false);
    expect(config.auth.type).toBe('none');
  });

  // DuckDuckGo 不需要 Key
  it('duckduckgo.yaml 的 requires_key 應為 false', async () => {
    const loader = new AdapterLoader();
    const config = await loader.loadFromFile(join(SCHEMAS_DIR, 'duckduckgo.yaml'));
    expect(config.adapter.requires_key).toBe(false);
    expect(config.auth.type).toBe('none');
  });

  // Anthropic 使用 header 認證
  it('anthropic.yaml 應使用 header 認證且有 header_name', async () => {
    const loader = new AdapterLoader();
    const config = await loader.loadFromFile(join(SCHEMAS_DIR, 'anthropic.yaml'));
    expect(config.auth.type).toBe('header');
    expect(config.auth.header_name).toBe('x-api-key');
  });

  // Gemini 使用 query_param 認證
  it('gemini.yaml 應使用 query_param 認證', async () => {
    const loader = new AdapterLoader();
    const config = await loader.loadFromFile(join(SCHEMAS_DIR, 'gemini.yaml'));
    expect(config.auth.type).toBe('query_param');
  });

  // loadFromDirectory 在空目錄中應回傳空 Map
  it('loadFromDirectory 在空目錄中應回傳空 Map', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-adapter-test-'));
    try {
      const loader = new AdapterLoader();
      const adapters = await loader.loadFromDirectory(tmpDir);
      expect(adapters.size).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
