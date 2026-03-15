import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { detectOllama, fullScan, maskKey, scanEnvVars } from '../env-scanner';
import type { KeyPool } from '../../core/key-pool';

describe('env-scanner', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it('maskKey 應回傳前 4 + **** + 後 4', () => {
    expect(maskKey('sk-test-1234567890abcd')).toBe('sk-t****abcd');
  });

  it('maskKey 遇到短 key 應全遮罩', () => {
    expect(maskKey('short-key')).toBe('****');
  });

  it('scanEnvVars 應掃出存在的環境變數', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-1234567890abcd';
    process.env.GROQ_API_KEY = 'gsk_groq_1234567890abcd';
    process.env.DEEPL_API_KEY = '   ';
    process.env.CLAWAPI_SKIP_DOTENV = '1'; // 測試只驗證 process.env，不掃 .env 檔案

    const result = scanEnvVars();
    expect(result.some(r => r.env_var === 'OPENAI_API_KEY')).toBe(true);
    expect(result.some(r => r.env_var === 'GROQ_API_KEY')).toBe(true);
    expect(result.some(r => r.env_var === 'DEEPL_API_KEY')).toBe(false);
  });

  it('detectOllama 成功時應解析 models', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }],
      }), { status: 200 });
    }) as any;

    const result = await detectOllama('http://localhost:11434');
    expect(result.detected).toBe(true);
    expect(result.models).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
  });

  it('detectOllama 失敗時應回傳 detected=false', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network error');
    }) as any;

    const result = await detectOllama('http://localhost:11434');
    expect(result.detected).toBe(false);
    expect(result.models).toEqual([]);
  });

  it('fullScan 應標記 already_managed', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-1234567890abcd';
    process.env.GROQ_API_KEY = 'gsk_groq_1234567890abcd';

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as any;

    const keyPool = {
      listKeys: async () => [
        {
          id: 1,
          service_id: 'openai',
          key_masked: 'sk-o****abcd',
          pool_type: 'king',
          label: null,
          status: 'active',
          priority: 0,
          pinned: false,
          daily_used: 0,
          consecutive_failures: 0,
          rate_limit_until: null,
          last_success_at: null,
          created_at: new Date().toISOString(),
        },
      ],
    } as unknown as KeyPool;

    const result = await fullScan(keyPool);
    const openai = result.found_keys.find(k => k.service_id === 'openai');
    const groq = result.found_keys.find(k => k.service_id === 'groq');

    expect(openai?.already_managed).toBe(true);
    expect(groq?.already_managed).toBe(false);
  });
});
