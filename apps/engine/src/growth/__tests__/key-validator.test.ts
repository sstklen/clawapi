import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { AdapterConfig } from '../../adapters/loader';
import { validateKey } from '../key-validator';

function createAdapter(overrides?: Partial<AdapterConfig>): AdapterConfig {
  return {
    schema_version: 1,
    adapter: {
      id: 'openai',
      name: 'OpenAI',
      version: '1.0.0',
      category: 'llm',
      requires_key: true,
    },
    auth: { type: 'bearer' },
    base_url: 'https://api.example.com',
    endpoints: {
      models: { method: 'GET', path: '/v1/models' },
      chat: { method: 'POST', path: '/v1/chat/completions' },
    },
    capabilities: {
      chat: true,
      streaming: true,
      embeddings: false,
      images: false,
      audio: false,
      models: [],
    },
    ...overrides,
  };
}

describe('key-validator', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('200 應視為有效 key', async () => {
    const adapter = createAdapter();
    const adapters = new Map<string, AdapterConfig>([['openai', adapter]]);

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 });
    }) as any;

    const result = await validateKey('openai', 'sk-test', adapters);
    expect(result.valid).toBe(true);
    expect(result.models_available).toEqual(['gpt-4o-mini']);
  });

  it('401/403 應視為無效 key', async () => {
    const adapter = createAdapter();
    const adapters = new Map<string, AdapterConfig>([['openai', adapter]]);

    globalThis.fetch = (async () => new Response(null, { status: 401 })) as any;
    const unauthorized = await validateKey('openai', 'sk-test', adapters);
    expect(unauthorized.valid).toBe(false);

    globalThis.fetch = (async () => new Response(null, { status: 403 })) as any;
    const forbidden = await validateKey('openai', 'sk-test', adapters);
    expect(forbidden.valid).toBe(false);
  });

  it('429 應視為有效但限速', async () => {
    const adapter = createAdapter();
    const adapters = new Map<string, AdapterConfig>([['openai', adapter]]);

    globalThis.fetch = (async () => new Response(null, { status: 429 })) as any;
    const result = await validateKey('openai', 'sk-test', adapters);

    expect(result.valid).toBe(true);
    expect(result.error).toContain('429');
  });

  it('找不到 adapter 時應回傳不支援的服務', async () => {
    const result = await validateKey('missing', 'sk-test', new Map());
    expect(result.valid).toBe(false);
    expect(result.error).toBe('不支援的服務');
  });

  it('timeout 應回傳逾時錯誤', async () => {
    const adapter = createAdapter();
    const adapters = new Map<string, AdapterConfig>([['openai', adapter]]);

    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as any;

    const result = await validateKey('openai', 'sk-test', adapters);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('逾時');
  }, 7000);
});

