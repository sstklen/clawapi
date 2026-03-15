// OpenAI 相容 API 路由測試
// 使用 Mock 的 Router、KeyPool、Adapters，不啟動真實 server

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { createOpenAICompatRouter, _clearFileStore } from '../openai-compat';
import type { Router, RouteResult } from '../../core/router';
import type { KeyPool } from '../../core/key-pool';
import type { AdapterConfig } from '../../adapters/loader';

// ===== Mock 工廠 =====

/** 建立 Mock Router，可指定 routeRequest 的回傳值 */
function createMockRouter(routeResult: Partial<RouteResult> = {}): Router {
  const defaultResult: RouteResult = {
    success: true,
    layer: 'L1',
    serviceId: 'groq',
    modelName: 'llama-3.3-70b',
    data: {
      id: 'chatcmpl-test',
      choices: [
        {
          message: { role: 'assistant', content: 'Hello, World!' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    },
    latency_ms: 123,
    ...routeResult,
  };

  const router = {
    routeRequest: mock(async () => defaultResult),
    updateCollectiveIntel: mock(() => undefined),
  } as unknown as Router;

  return router;
}

/** 建立 Mock KeyPool，包含部分 service IDs */
function createMockKeyPool(serviceIds: string[] = ['groq', 'openai']): KeyPool {
  return {
    getServiceIds: mock(() => serviceIds),
    selectKey: mock(async () => null),
    listKeys: mock(async () => []),
    addKey: mock(async () => 1),
    removeKey: mock(async () => undefined),
    selectKeyWithFallback: mock(async () => null),
    reportSuccess: mock(async () => undefined),
    reportError: mock(async () => undefined),
    reportRateLimit: mock(async () => undefined),
    reportAuthError: mock(async () => undefined),
    dailyReset: mock(async () => undefined),
  } as unknown as KeyPool;
}

/** 建立 Mock Adapters Map */
function createMockAdapters(): Map<string, AdapterConfig> {
  const adapters = new Map<string, AdapterConfig>();

  // Groq Adapter
  adapters.set('groq', {
    schema_version: 1,
    adapter: {
      id: 'groq',
      name: 'Groq',
      version: '1.0.0',
      category: 'llm',
      requires_key: true,
    },
    auth: { type: 'bearer' },
    base_url: 'https://api.groq.com',
    endpoints: {
      chat: {
        method: 'POST',
        path: '/openai/v1/chat/completions',
        response_type: 'json',
      },
    },
    capabilities: {
      chat: true,
      streaming: true,
      embeddings: false,
      images: false,
      audio: false,
      models: [
        { id: 'llama-3.3-70b', name: 'LLaMA 3.3 70B' },
        { id: 'llama-3.1-8b', name: 'LLaMA 3.1 8B' },
      ],
    },
  } as AdapterConfig);

  // OpenAI Adapter
  adapters.set('openai', {
    schema_version: 1,
    adapter: {
      id: 'openai',
      name: 'OpenAI',
      version: '1.0.0',
      category: 'llm',
      requires_key: true,
    },
    auth: { type: 'bearer' },
    base_url: 'https://api.openai.com',
    endpoints: {
      chat: {
        method: 'POST',
        path: '/v1/chat/completions',
        response_type: 'json',
      },
    },
    capabilities: {
      chat: true,
      streaming: true,
      embeddings: true,
      images: true,
      audio: true,
      models: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      ],
    },
  } as AdapterConfig);

  return adapters;
}

/** 建立測試用的完整 Hono App（帶 Bearer token，繞過 auth middleware） */
function createTestApp(routeResult?: Partial<RouteResult>): {
  app: Hono;
  router: Router;
  keyPool: KeyPool;
  adapters: Map<string, AdapterConfig>;
} {
  const router = createMockRouter(routeResult);
  const keyPool = createMockKeyPool();
  const adapters = createMockAdapters();

  const app = new Hono();
  const openaiRouter = createOpenAICompatRouter(router, keyPool, adapters);
  app.route('/v1', openaiRouter);

  return { app, router, keyPool, adapters };
}

/** 執行請求並取得回應 */
async function req(
  app: Hono,
  method: string,
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const { body, headers = {} } = options;

  const requestInit: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  return app.fetch(new Request(`http://localhost${path}`, requestInit));
}

// ===== 測試套件 =====

describe('GET /v1/models — 模型清單', () => {
  it('回傳所有 key pool + adapter 的模型', async () => {
    const { app, keyPool, adapters } = createTestApp();
    const res = await req(app, 'GET', '/v1/models');

    expect(res.status).toBe(200);
    const json = await res.json() as { object: string; data: Array<{ id: string; owned_by: string }> };

    expect(json.object).toBe('list');
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);

    // 確認有 groq 的模型
    const groqModels = json.data.filter(m => m.owned_by === 'groq');
    expect(groqModels.length).toBeGreaterThan(0);

    // 確認有 service_id/model_name 格式的模型
    const groqLlama = json.data.find(m => m.id === 'groq/llama-3.3-70b');
    expect(groqLlama).toBeDefined();
    expect(groqLlama?.owned_by).toBe('groq');

    // 確認有 openai 的模型
    const openaiModels = json.data.filter(m => m.owned_by === 'openai');
    expect(openaiModels.length).toBeGreaterThan(0);
  });

  it('每個 model 物件都有正確格式', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'GET', '/v1/models');
    const json = await res.json() as { data: Array<{ id: string; object: string; created: number; owned_by: string }> };

    for (const model of json.data) {
      expect(typeof model.id).toBe('string');
      expect(model.object).toBe('model');
      expect(typeof model.created).toBe('number');
      expect(typeof model.owned_by).toBe('string');
    }
  });
});

describe('POST /v1/chat/completions — 非 streaming', () => {
  it('成功回傳 OpenAI 格式回應', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'groq/llama-3.3-70b',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      x_clawapi: {
        requested_model: string;
        actual_model: string;
        service_id: string;
        layer: string;
        latency_ms: number;
        retry_count: number;
      };
    };

    // 標準欄位
    expect(json.id).toMatch(/^chatcmpl-/);
    expect(json.object).toBe('chat.completion');
    expect(typeof json.model).toBe('string');

    // choices
    expect(Array.isArray(json.choices)).toBe(true);
    expect(json.choices.length).toBe(1);
    expect(json.choices[0].message.role).toBe('assistant');
    expect(typeof json.choices[0].message.content).toBe('string');
    expect(json.choices[0].finish_reason).toBe('stop');

    // usage
    expect(typeof json.usage.prompt_tokens).toBe('number');
    expect(typeof json.usage.completion_tokens).toBe('number');
    expect(typeof json.usage.total_tokens).toBe('number');

    // x_clawapi 擴充欄位
    expect(json.x_clawapi).toBeDefined();
    expect(json.x_clawapi.requested_model).toBe('groq/llama-3.3-70b');
    expect(json.x_clawapi.service_id).toBe('groq');
    expect(json.x_clawapi.layer).toBe('L1');
    expect(typeof json.x_clawapi.latency_ms).toBe('number');
    expect(typeof json.x_clawapi.retry_count).toBe('number');
  });

  it('缺少 model 欄位時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });
    expect(res.status).toBe(400);
  });

  it('缺少 messages 時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: { model: 'groq/llama3' },
    });
    expect(res.status).toBe(400);
  });

  it('messages 為空陣列時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: { model: 'groq/llama3', messages: [] },
    });
    expect(res.status).toBe(400);
  });

  it('Router 回傳失敗時，回傳對應狀態碼', async () => {
    const { app } = createTestApp({
      success: false,
      error: '服務不可用',
      status: 502,
    });

    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'groq/llama3',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(res.status).toBe(502);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('routing_failed');
  });
});

describe('POST /v1/chat/completions — SSE streaming', () => {
  it('stream=true 回傳 text/event-stream Content-Type', async () => {
    const sseText = [
      'data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1709136000,"model":"llama-3.3-70b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1709136000,"model":"llama-3.3-70b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const { app } = createTestApp({
      success: true,
      data: sseText,
    });

    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'groq/llama-3.3-70b',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  });

  it('SSE streaming 包含正確的 data: {...}\\n\\n 格式', async () => {
    const sseText = [
      'data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1709136000,"model":"llama-3.3-70b","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1709136000,"model":"llama-3.3-70b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const { app } = createTestApp({
      success: true,
      data: sseText,
    });

    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'groq/llama-3.3-70b',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    const text = await res.text();

    // 確認 SSE 格式：每行以 data: 開頭
    const lines = text.split('\n').filter(l => l.length > 0);
    const dataLines = lines.filter(l => l.startsWith('data: '));
    expect(dataLines.length).toBeGreaterThan(0);

    // 確認最後一行是 data: [DONE]
    const doneLines = lines.filter(l => l === 'data: [DONE]');
    expect(doneLines.length).toBe(1);
  });

  it('SSE streaming 最後 chunk 包含 x_clawapi 擴充欄位', async () => {
    // 後端回傳 JSON 物件時，會模擬 streaming
    const { app } = createTestApp({
      success: true,
      layer: 'L2',
      serviceId: 'openai',
      modelName: 'gpt-4o',
      data: {
        choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    });

    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    const text = await res.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');

    // 找到含有 x_clawapi 的 chunk
    let foundXClawAPI = false;
    for (const line of dataLines) {
      try {
        const chunk = JSON.parse(line.slice(6));
        if (chunk.x_clawapi) {
          foundXClawAPI = true;
          expect(chunk.x_clawapi.layer).toBe('L2');
          expect(chunk.x_clawapi.service_id).toBe('openai');
          break;
        }
      } catch {
        // 忽略解析失敗的行
      }
    }
    expect(foundXClawAPI).toBe(true);
  });

  it('非 streaming 後端轉換為模擬 streaming 也包含 [DONE]', async () => {
    const { app } = createTestApp({
      success: true,
      data: {
        choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    });

    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'groq/llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    const text = await res.text();
    expect(text).toContain('data: [DONE]');
  });
});

describe('POST /v1/embeddings', () => {
  beforeEach(() => {
    _clearFileStore();
  });

  it('回傳 OpenAI embeddings 格式', async () => {
    const { app } = createTestApp({
      success: true,
      layer: 'L1',
      serviceId: 'openai',
      modelName: 'text-embedding-3-small',
      data: {
        object: 'list',
        data: [
          { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      },
    });

    const res = await req(app, 'POST', '/v1/embeddings', {
      body: {
        model: 'openai/text-embedding-3-small',
        input: 'Hello, World!',
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as {
      object: string;
      data: Array<{ object: string; index: number; embedding: number[] }>;
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
      x_clawapi: { requested_model: string; layer: string };
    };

    expect(json.object).toBe('list');
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data[0].object).toBe('embedding');
    expect(typeof json.data[0].index).toBe('number');
    expect(Array.isArray(json.data[0].embedding)).toBe(true);
    expect(typeof json.usage.prompt_tokens).toBe('number');
    expect(typeof json.usage.total_tokens).toBe('number');

    // x_clawapi 擴充欄位
    expect(json.x_clawapi).toBeDefined();
    expect(json.x_clawapi.requested_model).toBe('openai/text-embedding-3-small');
  });

  it('缺少 model 時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/embeddings', {
      body: { input: 'Hello' },
    });
    expect(res.status).toBe(400);
  });

  it('缺少 input 時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/embeddings', {
      body: { model: 'text-embedding-3-small' },
    });
    expect(res.status).toBe(400);
  });

  it('多筆 input 陣列回傳對應數量的 embeddings', async () => {
    const { app } = createTestApp({
      success: true,
      data: null, // 後端無回應，使用 mock 向量
    });

    const res = await req(app, 'POST', '/v1/embeddings', {
      body: {
        model: 'openai/text-embedding-3-small',
        input: ['Hello', 'World'],
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { data: unknown[] };
    // mock 資料：每個 input 都有對應的 embedding
    expect(json.data.length).toBe(2);
  });
});

describe('POST /v1/images/generations', () => {
  it('回傳 OpenAI images 格式 + x_clawapi', async () => {
    const { app } = createTestApp({
      success: true,
      layer: 'L1',
      serviceId: 'openai',
      modelName: 'dall-e-3',
      data: {
        created: Math.floor(Date.now() / 1000),
        data: [{ url: 'https://example.com/image.png', revised_prompt: 'A cat' }],
      },
    });

    const res = await req(app, 'POST', '/v1/images/generations', {
      body: {
        model: 'openai/dall-e-3',
        prompt: 'A cat',
        n: 1,
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as {
      created: number;
      data: Array<{ url?: string; revised_prompt?: string }>;
      x_clawapi: { requested_model: string };
    };

    expect(typeof json.created).toBe('number');
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.x_clawapi).toBeDefined();
    expect(json.x_clawapi.requested_model).toBe('openai/dall-e-3');
  });

  it('缺少 prompt 時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/images/generations', {
      body: { model: 'dall-e-3' },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/audio/transcriptions — multipart', () => {
  it('成功處理 multipart 表單（JSON 格式回應）', async () => {
    const { app } = createTestApp({
      success: true,
      layer: 'L1',
      serviceId: 'openai',
      modelName: 'whisper-1',
      data: { text: '這是轉錄的文字' },
    });

    // 使用 FormData 模擬 multipart
    const formData = new FormData();
    const audioBlob = new Blob(['fake audio data'], { type: 'audio/mp3' });
    formData.append('file', audioBlob, 'audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('language', 'zh');

    const res = await app.fetch(
      new Request('http://localhost/v1/audio/transcriptions', {
        method: 'POST',
        body: formData,
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json() as { text: string };
    expect(typeof json.text).toBe('string');
  });

  it('缺少 file 欄位時回傳 400', async () => {
    const { app } = createTestApp();

    const formData = new FormData();
    formData.append('model', 'whisper-1');

    const res = await app.fetch(
      new Request('http://localhost/v1/audio/transcriptions', {
        method: 'POST',
        body: formData,
      })
    );

    expect(res.status).toBe(400);
  });
});

describe('POST /v1/audio/speech — binary stream', () => {
  it('回傳 binary audio stream 與 X-ClawAPI-* headers', async () => {
    const audioData = new Uint8Array([0x49, 0x44, 0x33]); // 假的 MP3 header

    const { app } = createTestApp({
      success: true,
      layer: 'L1',
      serviceId: 'openai',
      modelName: 'tts-1',
      data: audioData,
    });

    const res = await req(app, 'POST', '/v1/audio/speech', {
      body: {
        model: 'openai/tts-1',
        input: 'Hello, World!',
        voice: 'alloy',
        response_format: 'mp3',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('audio/mpeg');

    // ClawAPI 擴充 Headers
    expect(res.headers.get('X-ClawAPI-Service')).toBe('openai');
    expect(res.headers.get('X-ClawAPI-Model')).toBe('tts-1');
    expect(res.headers.get('X-ClawAPI-Layer')).toBe('L1');
    expect(res.headers.get('X-ClawAPI-Latency')).toBeDefined();
  });

  it('缺少 model 時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/audio/speech', {
      body: { input: 'Hello', voice: 'alloy' },
    });
    expect(res.status).toBe(400);
  });

  it('缺少 input 時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/audio/speech', {
      body: { model: 'tts-1', voice: 'alloy' },
    });
    expect(res.status).toBe(400);
  });

  it('缺少 voice 時回傳 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/v1/audio/speech', {
      body: { model: 'tts-1', input: 'Hello' },
    });
    expect(res.status).toBe(400);
  });

  it('response_format=opus 回傳 audio/ogg Content-Type', async () => {
    const { app } = createTestApp({
      success: true,
      data: new Uint8Array(0),
    });

    const res = await req(app, 'POST', '/v1/audio/speech', {
      body: {
        model: 'openai/tts-1',
        input: 'Hello',
        voice: 'alloy',
        response_format: 'opus',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('audio/ogg');
  });
});

describe('Files CRUD lifecycle — 完整生命週期', () => {
  beforeEach(() => {
    _clearFileStore();
  });

  it('POST /v1/files — 上傳檔案', async () => {
    const { app } = createTestApp();

    const formData = new FormData();
    const fileBlob = new Blob(['file content here'], { type: 'text/plain' });
    formData.append('file', fileBlob, 'test.txt');
    formData.append('purpose', 'assistants');

    const res = await app.fetch(
      new Request('http://localhost/v1/files', {
        method: 'POST',
        body: formData,
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json() as {
      id: string;
      object: string;
      bytes: number;
      filename: string;
      purpose: string;
      status: string;
    };

    expect(json.id).toMatch(/^file-/);
    expect(json.object).toBe('file');
    expect(typeof json.bytes).toBe('number');
    expect(json.filename).toBe('test.txt');
    expect(json.purpose).toBe('assistants');
    expect(json.status).toBe('uploaded');
  });

  it('GET /v1/files — 列出所有檔案', async () => {
    const { app } = createTestApp();

    // 先上傳一個檔案
    const formData = new FormData();
    const fileBlob = new Blob(['test'], { type: 'text/plain' });
    formData.append('file', fileBlob, 'list-test.txt');
    formData.append('purpose', 'fine-tune');
    await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );

    const res = await req(app, 'GET', '/v1/files');
    expect(res.status).toBe(200);
    const json = await res.json() as { object: string; data: unknown[] };
    expect(json.object).toBe('list');
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBe(1);
  });

  it('GET /v1/files/:file_id — 取得單一檔案', async () => {
    const { app } = createTestApp();

    // 上傳檔案
    const formData = new FormData();
    const fileBlob = new Blob(['content'], { type: 'text/plain' });
    formData.append('file', fileBlob, 'single.txt');
    formData.append('purpose', 'assistants');
    const uploadRes = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    const uploaded = await uploadRes.json() as { id: string };
    const fileId = uploaded.id;

    // 取得單一檔案
    const res = await req(app, 'GET', `/v1/files/${fileId}`);
    expect(res.status).toBe(200);
    const json = await res.json() as { id: string; object: string };
    expect(json.id).toBe(fileId);
    expect(json.object).toBe('file');
  });

  it('GET /v1/files/:file_id — 不存在時回傳 404', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'GET', '/v1/files/file-nonexistent');
    expect(res.status).toBe(404);
  });

  it('DELETE /v1/files/:file_id — 刪除檔案', async () => {
    const { app } = createTestApp();

    // 上傳檔案
    const formData = new FormData();
    const fileBlob = new Blob(['delete me'], { type: 'text/plain' });
    formData.append('file', fileBlob, 'delete.txt');
    formData.append('purpose', 'assistants');
    const uploadRes = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    const uploaded = await uploadRes.json() as { id: string };
    const fileId = uploaded.id;

    // 刪除
    const deleteRes = await req(app, 'DELETE', `/v1/files/${fileId}`);
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json() as { id: string; deleted: boolean };
    expect(deleteJson.id).toBe(fileId);
    expect(deleteJson.deleted).toBe(true);

    // 確認已刪除
    const getRes = await req(app, 'GET', `/v1/files/${fileId}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /v1/files/:file_id — 不存在時回傳 404', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'DELETE', '/v1/files/file-nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('x_clawapi 擴充欄位正確性', () => {
  it('非 streaming：x_clawapi 包含所有必填欄位', async () => {
    const { app } = createTestApp({
      success: true,
      layer: 'L2',
      serviceId: 'openai',
      modelName: 'gpt-4o',
      latency_ms: 456,
      tried: ['groq', 'openai'],
    });

    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Test' }],
      },
    });

    const json = await res.json() as {
      x_clawapi: {
        requested_model: string;
        actual_model: string;
        service_id: string;
        layer: string;
        key_source: string;
        latency_ms: number;
        retry_count: number;
        warnings?: string[];
      };
    };

    const xc = json.x_clawapi;
    expect(xc.requested_model).toBe('auto');
    expect(xc.actual_model).toBe('gpt-4o');
    expect(xc.service_id).toBe('openai');
    expect(xc.layer).toBe('L2');
    expect(typeof xc.key_source).toBe('string');
    expect(xc.latency_ms).toBe(456);
    expect(typeof xc.retry_count).toBe('number');
    // tried 有值時，warnings 應該包含 Failover 資訊
    expect(xc.warnings).toBeDefined();
    expect(xc.warnings?.length).toBeGreaterThan(0);
  });

  it('Failover 後 warnings 包含嘗試過的服務', async () => {
    const { app } = createTestApp({
      success: true,
      layer: 'L2',
      serviceId: 'openai',
      modelName: 'gpt-4o',
      tried: ['groq', 'anthropic', 'openai'],
    });

    const res = await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Test' }],
      },
    });

    const json = await res.json() as { x_clawapi: { warnings?: string[] } };
    expect(json.x_clawapi.warnings).toBeDefined();
    const warningStr = json.x_clawapi.warnings?.[0] ?? '';
    expect(warningStr).toContain('groq');
    expect(warningStr).toContain('anthropic');
  });
});

describe('Router 呼叫驗證', () => {
  it('chat/completions 呼叫 router.routeRequest 帶正確參數', async () => {
    const { app, router } = createTestApp();

    await req(app, 'POST', '/v1/chat/completions', {
      body: {
        model: 'groq/llama3',
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.7,
        x_strategy: 'smart',
      },
    });

    const mockFn = (router as unknown as { routeRequest: ReturnType<typeof mock> }).routeRequest;
    expect(mockFn).toHaveBeenCalledTimes(1);

    const callArgs = mockFn.mock.calls[0]?.[0] as { model: string; strategy: string; params: Record<string, unknown> };
    expect(callArgs.model).toBe('groq/llama3');
    expect(callArgs.strategy).toBe('smart');
    expect(callArgs.params.temperature).toBe(0.7);
    expect(Array.isArray(callArgs.params.messages)).toBe(true);
  });

  it('embeddings 呼叫 router.routeRequest', async () => {
    const { app, router } = createTestApp({ success: true, data: null });

    await req(app, 'POST', '/v1/embeddings', {
      body: {
        model: 'openai/text-embedding-3-small',
        input: 'test text',
      },
    });

    const mockFn = (router as unknown as { routeRequest: ReturnType<typeof mock> }).routeRequest;
    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});

// ===== 突變測試：安全防護 =====
// 確保移除防護邏輯時測試會失敗

describe('POST /v1/files — 檔案類型白名單（突變偵測）', () => {
  beforeEach(() => {
    _clearFileStore();
  });

  it('上傳 .exe 執行檔應被擋（400）', async () => {
    const { app } = createTestApp();
    const formData = new FormData();
    const blob = new Blob(['MZ\x90\x00'], { type: 'application/octet-stream' });
    formData.append('file', blob, 'malware.exe');
    formData.append('purpose', 'assistants');

    const res = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    expect(res.status).toBe(400);
    const json = await res.json() as { error: { message: string } };
    expect(json.error.message).toContain('.exe');
  });

  it('上傳 .bat 批次檔應被擋（400）', async () => {
    const { app } = createTestApp();
    const formData = new FormData();
    const blob = new Blob(['@echo off\ndel /f /q C:\\*'], { type: 'application/octet-stream' });
    formData.append('file', blob, 'danger.bat');
    formData.append('purpose', 'assistants');

    const res = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    expect(res.status).toBe(400);
  });

  it('上傳無副檔名的檔案應被擋（400）', async () => {
    const { app } = createTestApp();
    const formData = new FormData();
    const blob = new Blob(['#!/bin/sh\nrm -rf /'], { type: 'application/octet-stream' });
    formData.append('file', blob, 'noext');
    formData.append('purpose', 'assistants');

    const res = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    expect(res.status).toBe(400);
  });

  it('上傳合法的 .txt 檔案應被允許（200）', async () => {
    const { app } = createTestApp();
    const formData = new FormData();
    const blob = new Blob(['Hello, world!'], { type: 'text/plain' });
    formData.append('file', blob, 'hello.txt');
    formData.append('purpose', 'assistants');

    const res = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { id: string; filename: string };
    expect(json.filename).toBe('hello.txt');
  });

  it('上傳合法的 .json 檔案應被允許（200）', async () => {
    const { app } = createTestApp();
    const formData = new FormData();
    const blob = new Blob(['{"key":"value"}'], { type: 'application/json' });
    formData.append('file', blob, 'data.json');
    formData.append('purpose', 'assistants');

    const res = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    expect(res.status).toBe(200);
  });

  it('大小寫混合副檔名 .TXT 應被允許', async () => {
    const { app } = createTestApp();
    const formData = new FormData();
    const blob = new Blob(['uppercase ext'], { type: 'text/plain' });
    formData.append('file', blob, 'document.TXT');
    formData.append('purpose', 'assistants');

    const res = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/files — 檔案上限（突變偵測）', () => {
  beforeEach(() => {
    _clearFileStore();
  });

  it('超過 100 個檔案應被拒（400）', async () => {
    const { app } = createTestApp();

    // 上傳 100 個小檔案
    for (let i = 0; i < 100; i++) {
      const formData = new FormData();
      const blob = new Blob([`file-${i}`], { type: 'text/plain' });
      formData.append('file', blob, `f${i}.txt`);
      formData.append('purpose', 'assistants');
      const res = await app.fetch(
        new Request('http://localhost/v1/files', { method: 'POST', body: formData })
      );
      expect(res.status).toBe(200);
    }

    // 第 101 個應該被拒（413 = 超過上限）
    const formData = new FormData();
    const blob = new Blob(['overflow'], { type: 'text/plain' });
    formData.append('file', blob, 'overflow.txt');
    formData.append('purpose', 'assistants');
    const res = await app.fetch(
      new Request('http://localhost/v1/files', { method: 'POST', body: formData })
    );
    expect(res.status).toBe(413);
  });
});
