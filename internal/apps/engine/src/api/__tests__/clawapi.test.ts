// ClawAPI 簡化 API 路由測試
// 使用 Mock Router，不啟動真實 server

import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { createClawAPIRouter } from '../clawapi';
import type { Router, RouteResult } from '../../core/router';

// ===== Mock 工廠 =====

/**
 * 建立 Mock Router，可指定 routeRequest 的回傳值
 */
function createMockRouter(routeResult: Partial<RouteResult> = {}): Router {
  const defaultResult: RouteResult = {
    success: true,
    layer: 'L2',
    serviceId: 'groq',
    modelName: 'llama3',
    data: {
      choices: [
        {
          message: { role: 'assistant', content: '這是 AI 回應內容' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    },
    latency_ms: 150,
    ...routeResult,
  };

  return {
    routeRequest: mock(async () => defaultResult),
    updateCollectiveIntel: mock(() => undefined),
  } as unknown as Router;
}

/**
 * 建立測試用的 Hono App，包含簡化 API 路由
 */
function createTestApp(routeResult?: Partial<RouteResult>): {
  app: Hono;
  router: Router;
} {
  const router = createMockRouter(routeResult);
  const app = new Hono();
  const clawRouter = createClawAPIRouter(router);
  app.route('/api', clawRouter);
  return { app, router };
}

/**
 * 輔助：發送 JSON 請求
 */
async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const requestInit: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }
  return app.fetch(new Request(`http://localhost${path}`, requestInit));
}

// ===== 測試套件 =====

// =========================================================
// POST /api/llm
// =========================================================
describe('POST /api/llm — 簡化版 LLM 呼叫', () => {
  it('Happy Path：成功呼叫並回傳簡化格式', async () => {
    const { app } = createTestApp({
      success: true,
      layer: 'L2',
      serviceId: 'groq',
      modelName: 'llama3',
      data: {
        choices: [
          { message: { role: 'assistant', content: '台灣位於東亞' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
      },
      latency_ms: 200,
    });

    const res = await req(app, 'POST', '/api/llm', {
      prompt: '台灣在哪裡？',
      model: 'auto',
      options: { temperature: 0.7 },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as {
      text: string;
      model: string;
      tokens: number;
      latency_ms: number;
    };

    // 驗證回應格式
    expect(typeof json.text).toBe('string');
    expect(json.text).toBe('台灣位於東亞');
    expect(typeof json.model).toBe('string');
    expect(json.model).toBe('groq/llama3');
    expect(typeof json.tokens).toBe('number');
    expect(json.tokens).toBe(20);
    expect(typeof json.latency_ms).toBe('number');
    expect(json.latency_ms).toBe(200);
  });

  it('缺少 prompt → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/llm', { model: 'auto' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('invalid_request');
  });

  it('prompt 為空字串 → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/llm', { prompt: '' });
    expect(res.status).toBe(400);
  });

  it('無效 JSON body → 400', async () => {
    const { app } = createTestApp();
    const res = await app.fetch(new Request('http://localhost/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    }));
    expect(res.status).toBe(400);
  });

  it('Router 失敗 → 回傳對應狀態碼', async () => {
    const { app } = createTestApp({
      success: false,
      error: '服務不可用',
      status: 502,
    });

    const res = await req(app, 'POST', '/api/llm', { prompt: '測試' });
    expect(res.status).toBe(502);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('routing_failed');
  });

  it('Router 拋出例外 → 500', async () => {
    const router = {
      routeRequest: mock(async () => { throw new Error('內部錯誤'); }),
      updateCollectiveIntel: mock(() => undefined),
    } as unknown as Router;

    const app = new Hono();
    app.route('/api', createClawAPIRouter(router));

    const res = await req(app, 'POST', '/api/llm', { prompt: '測試' });
    expect(res.status).toBe(500);
  });

  it('預設 model 為 auto（Router 應收到 model=auto）', async () => {
    const { app, router } = createTestApp();
    await req(app, 'POST', '/api/llm', { prompt: '測試' });

    const mockFn = (router as unknown as { routeRequest: ReturnType<typeof mock> }).routeRequest;
    expect(mockFn).toHaveBeenCalledTimes(1);
    const callArg = mockFn.mock.calls[0]?.[0] as { model: string };
    expect(callArg.model).toBe('auto');
  });
});

// =========================================================
// POST /api/search
// =========================================================
describe('POST /api/search — 簡化版搜尋', () => {
  it('Happy Path：成功搜尋並回傳結果', async () => {
    const { app } = createTestApp({
      success: true,
      serviceId: 'brave-search',
      data: {
        results: [
          { title: 'ClawAPI 介紹', url: 'https://example.com/clawapi', snippet: '開源 API 管理器' },
          { title: 'GitHub - ClawAPI', url: 'https://github.com/clawapi', snippet: '原始碼' },
        ],
      },
      latency_ms: 500,
    });

    const res = await req(app, 'POST', '/api/search', {
      query: 'ClawAPI 是什麼',
      lang: 'zh-TW',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as {
      results: Array<{ title: string; url: string; snippet?: string }>;
      source: string;
      latency_ms: number;
    };

    expect(Array.isArray(json.results)).toBe(true);
    expect(json.results.length).toBe(2);
    expect(json.results[0].title).toBe('ClawAPI 介紹');
    expect(json.results[0].url).toBe('https://example.com/clawapi');
    expect(json.source).toBe('brave-search');
    expect(json.latency_ms).toBe(500);
  });

  it('缺少 query → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/search', { lang: 'zh-TW' });
    expect(res.status).toBe(400);
  });

  it('query 為空字串 → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/search', { query: '' });
    expect(res.status).toBe(400);
  });

  it('後端無結果時回傳空陣列', async () => {
    const { app } = createTestApp({
      success: true,
      data: null,
    });

    const res = await req(app, 'POST', '/api/search', { query: '罕見查詢' });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: unknown[] };
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.results.length).toBe(0);
  });
});

// =========================================================
// POST /api/translate
// =========================================================
describe('POST /api/translate — 簡化版翻譯', () => {
  it('Happy Path：成功翻譯並回傳結果', async () => {
    const { app } = createTestApp({
      success: true,
      serviceId: 'deepl',
      data: {
        choices: [
          { message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' },
        ],
      },
      latency_ms: 300,
    });

    const res = await req(app, 'POST', '/api/translate', {
      text: 'Hello',
      from: 'en',
      to: 'zh-TW',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as {
      translated: string;
      source: string;
      latency_ms: number;
    };

    expect(json.translated).toBe('你好');
    expect(typeof json.source).toBe('string');
    expect(json.latency_ms).toBe(300);
  });

  it('缺少 text → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/translate', { to: 'zh-TW' });
    expect(res.status).toBe(400);
  });

  it('缺少 to（目標語言）→ 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/translate', { text: 'Hello' });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('invalid_request');
  });

  it('不指定 from（自動偵測）也能正常工作', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/translate', {
      text: 'Hello',
      to: 'zh-TW',
    });
    // 不要求特定狀態碼，只要不報 400 缺少欄位
    expect(res.status).not.toBe(400);
  });
});

// =========================================================
// POST /api/ask
// =========================================================
describe('POST /api/ask — L3 AI 管家入口', () => {
  it('Happy Path：成功呼叫 L3 管家並回傳答案', async () => {
    const { app, router } = createTestApp({
      success: true,
      layer: 'L3',
      data: '今天的天氣很好，適合出門散步。',
      latency_ms: 800,
    });

    const res = await req(app, 'POST', '/api/ask', {
      message: '今天天氣如何？',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { answer: string; latency_ms: number };
    expect(typeof json.answer).toBe('string');
    expect(json.latency_ms).toBe(800);

    // 驗證 Router 被呼叫時 model='ask'
    const mockFn = (router as unknown as { routeRequest: ReturnType<typeof mock> }).routeRequest;
    const callArg = mockFn.mock.calls[0]?.[0] as { model: string };
    expect(callArg.model).toBe('ask');
  });

  it('缺少 message → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/ask', {});
    expect(res.status).toBe(400);
  });

  it('帶 history 對話歷史，Router 收到合併的 messages', async () => {
    const { app, router } = createTestApp();

    await req(app, 'POST', '/api/ask', {
      message: '請繼續說',
      history: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '您好！有什麼需要？' },
      ],
    });

    const mockFn = (router as unknown as { routeRequest: ReturnType<typeof mock> }).routeRequest;
    const callArg = mockFn.mock.calls[0]?.[0] as { params: { messages: Array<{ role: string; content: string }> } };
    expect(callArg.params.messages.length).toBe(3);
    expect(callArg.params.messages[2].content).toBe('請繼續說');
  });
});

// =========================================================
// POST /api/task
// =========================================================
describe('POST /api/task — L4 任務引擎入口', () => {
  it('L4 stub 拋出例外時回傳 501', async () => {
    const router = {
      routeRequest: mock(async () => {
        throw new Error("L4（任務引擎）尚未實作，model='task'");
      }),
      updateCollectiveIntel: mock(() => undefined),
    } as unknown as Router;

    const app = new Hono();
    app.route('/api', createClawAPIRouter(router));

    const res = await req(app, 'POST', '/api/task', {
      task: '幫我分析這份報告',
    });

    expect(res.status).toBe(501);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('not_implemented');
  });

  it('缺少 task → 400', async () => {
    const router = {
      routeRequest: mock(async () => {
        throw new Error('L4 stub');
      }),
      updateCollectiveIntel: mock(() => undefined),
    } as unknown as Router;

    const app = new Hono();
    app.route('/api', createClawAPIRouter(router));

    const res = await req(app, 'POST', '/api/task', {});
    expect(res.status).toBe(400);
  });

  it('Router 收到 model=task', async () => {
    const router = {
      routeRequest: mock(async () => {
        throw new Error('L4 stub');
      }),
      updateCollectiveIntel: mock(() => undefined),
    } as unknown as Router;

    const app = new Hono();
    app.route('/api', createClawAPIRouter(router));

    await req(app, 'POST', '/api/task', { task: '測試任務' });

    const mockFn = (router as unknown as { routeRequest: ReturnType<typeof mock> }).routeRequest;
    const callArg = mockFn.mock.calls[0]?.[0] as { model: string };
    expect(callArg.model).toBe('task');
  });
});
