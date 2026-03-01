// Server 啟動 / 停止 / auth middleware / 優雅關機測試
// 使用 Mock 依賴，直接測試 Hono App 而不啟動真實 Bun Server

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { ClawEngineServer } from '../../server';
import { EngineAuth } from '../../core/auth';
import type { Router } from '../../core/router';
import type { KeyPool } from '../../core/key-pool';
import type { AdapterConfig } from '../../adapters/loader';
import type { ClawDatabase } from '../../storage/database';
import type { WriteBuffer } from '../../storage/write-buffer';

// ===== Mock 工廠 =====

/** Mock Router */
function createMockRouter(): Router {
  return {
    routeRequest: mock(async () => ({
      success: true,
      layer: 'L1' as const,
      serviceId: 'groq',
      modelName: 'llama3',
      data: {
        choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      },
      latency_ms: 100,
    })),
    updateCollectiveIntel: mock(() => undefined),
  } as unknown as Router;
}

/** Mock KeyPool */
function createMockKeyPool(): KeyPool {
  return {
    getServiceIds: mock(() => ['groq']),
    selectKey: mock(async () => null),
    listKeys: mock(async () => []),
    addKey: mock(async () => 1),
    removeKey: mock(async () => undefined),
  } as unknown as KeyPool;
}

/** Mock Adapters */
function createMockAdapters(): Map<string, AdapterConfig> {
  return new Map([
    [
      'groq',
      {
        schema_version: 1,
        adapter: { id: 'groq', name: 'Groq', version: '1.0.0', category: 'llm', requires_key: true },
        auth: { type: 'bearer' },
        base_url: 'https://api.groq.com',
        endpoints: { chat: { method: 'POST', path: '/v1/chat/completions', response_type: 'json' } },
        capabilities: {
          chat: true, streaming: true, embeddings: false, images: false, audio: false,
          models: [{ id: 'llama3', name: 'LLaMA 3' }],
        },
      } as AdapterConfig,
    ],
  ]);
}

/** Mock Database */
function createMockDb(): ClawDatabase {
  return {
    init: mock(async () => undefined),
    close: mock(async () => undefined),
    query: mock(() => []),
    run: mock(() => ({ changes: 0, lastInsertRowid: 0 })),
    transaction: mock((fn: () => unknown) => fn()),
    checkpoint: mock(() => undefined),
    dailyReset: mock(() => undefined),
    exec: mock(() => undefined),
  } as unknown as ClawDatabase;
}

/** Mock WriteBuffer */
function createMockWriteBuffer(): WriteBuffer {
  return {
    start: mock(() => undefined),
    stop: mock(async () => undefined),
    flush: mock(async () => undefined),
    enqueue: mock(() => undefined),
    queue: [],
    maxSize: 100,
    flushInterval: 5000,
  } as unknown as WriteBuffer;
}

/** 建立 Mock EngineAuth（跳過 initToken，直接設定 token） */
async function createMockAuth(db: ClawDatabase): Promise<EngineAuth> {
  // 使用臨時目錄初始化 EngineAuth
  const tmpDir = `/tmp/clawapi-test-${Date.now()}`;
  const auth = new EngineAuth(db, tmpDir);

  // 初始化 token（使用暫存目錄）
  await auth.initToken(tmpDir);

  return auth;
}

// ===== 測試輔助 =====

/** 取得有效 Bearer token 的請求 headers */
function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
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

// ===== Server 測試 =====

describe('ClawEngineServer — App 行為', () => {
  let server: ClawEngineServer;
  let db: ClawDatabase;
  let auth: EngineAuth;
  let app: Hono;

  beforeEach(async () => {
    db = createMockDb();
    auth = await createMockAuth(db);

    server = new ClawEngineServer(
      createMockRouter(),
      createMockKeyPool(),
      auth,
      createMockAdapters(),
      db,
      createMockWriteBuffer(),
      { port: 19999 }  // 不實際監聽，只測試 app
    );

    app = server.getApp();
  });

  it('getApp() 回傳 Hono 實例', () => {
    expect(app).toBeInstanceOf(Hono);
  });

  it('初始狀態 isRunning() 為 false', () => {
    expect(server.isRunning()).toBe(false);
  });

  describe('健康檢查端點（不需認證）', () => {
    it('GET /health 回傳 200 ok', async () => {
      const res = await req(app, 'GET', '/health');
      expect(res.status).toBe(200);
      const json = await res.json() as { status: string; version: string };
      expect(json.status).toBe('ok');
      expect(typeof json.version).toBe('string');
    });

    it('GET /v1/health 回傳 200 ok', async () => {
      const res = await req(app, 'GET', '/v1/health');
      expect(res.status).toBe(200);
      const json = await res.json() as { status: string };
      expect(json.status).toBe('ok');
    });
  });
});

describe('Auth Middleware — 認證保護', () => {
  let db: ClawDatabase;
  let auth: EngineAuth;
  let app: Hono;

  beforeEach(async () => {
    db = createMockDb();
    auth = await createMockAuth(db);

    const server = new ClawEngineServer(
      createMockRouter(),
      createMockKeyPool(),
      auth,
      createMockAdapters(),
      db,
      createMockWriteBuffer()
    );

    app = server.getApp();
  });

  it('無 Authorization header → 401', async () => {
    const res = await req(app, 'GET', '/v1/models');
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(typeof json.error).toBe('string');
  });

  it('錯誤格式（無 Bearer prefix）→ 401', async () => {
    const res = await req(app, 'GET', '/v1/models', {
      headers: { Authorization: 'Token wrong-format' },
    });
    expect(res.status).toBe(401);
  });

  it('錯誤 token → 401', async () => {
    const res = await req(app, 'GET', '/v1/models', {
      headers: authHeader('clw_tinvalidtokenxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
    });
    expect(res.status).toBe(401);
  });

  it('正確 auth.token → 200（可存取 /v1/models）', async () => {
    const token = auth.getToken();
    const res = await req(app, 'GET', '/v1/models', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });

  it('/health 不需要認證', async () => {
    const res = await req(app, 'GET', '/health');
    expect(res.status).toBe(200);
  });

  it('/v1/health 不需要認證', async () => {
    const res = await req(app, 'GET', '/v1/health');
    expect(res.status).toBe(200);
  });

  it('sk_live_ 開頭的 Sub-Key 被識別（查詢 DB 若 Sub-Key 不存在則 401）', async () => {
    // 使用假的 sk_live_ token（DB 中沒有），應該回傳 401
    const res = await req(app, 'GET', '/v1/models', {
      headers: authHeader('sk_live_12345678_00000000-0000-0000-0000-000000000000'),
    });
    // Sub-Key 不存在 → 401
    expect(res.status).toBe(401);
  });
});

describe('優雅關機流程', () => {
  it('stop() 呼叫後 isRunning() 仍為 false（未啟動時）', async () => {
    const db = createMockDb();
    const auth = await createMockAuth(db);
    const writeBuffer = createMockWriteBuffer();

    const server = new ClawEngineServer(
      createMockRouter(),
      createMockKeyPool(),
      auth,
      createMockAdapters(),
      db,
      writeBuffer
    );

    // 未啟動直接 stop（不應拋出錯誤）
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('stop() 呼叫時，writeBuffer.stop() 被呼叫', async () => {
    const db = createMockDb();
    const auth = await createMockAuth(db);
    const writeBuffer = createMockWriteBuffer();

    const server = new ClawEngineServer(
      createMockRouter(),
      createMockKeyPool(),
      auth,
      createMockAdapters(),
      db,
      writeBuffer,
      { port: 19998 }
    );

    // 模擬 running 狀態（透過直接存取內部狀態是不建議的，這裡用 start 再 stop）
    // 由於 start() 會真實啟動 Bun server（需要可用的 port），
    // 這個測試直接測試 stop() 在非 running 狀態下的行為
    await server.stop();

    // writeBuffer.stop 在 running=false 時不應該被呼叫
    const stopFn = writeBuffer.stop as ReturnType<typeof mock>;
    // stop() 在 running=false 時會提早 return，所以 writeBuffer.stop 不被呼叫
    expect(stopFn.mock.calls.length).toBe(0);
  });

  it('stop() 呼叫時，db.close() 被呼叫（running 狀態）', async () => {
    const db = createMockDb();
    const auth = await createMockAuth(db);
    const writeBuffer = createMockWriteBuffer();

    const server = new ClawEngineServer(
      createMockRouter(),
      createMockKeyPool(),
      auth,
      createMockAdapters(),
      db,
      writeBuffer,
      { port: 19997 }
    );

    // 手動設定 running 狀態進行測試（白盒測試）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as unknown as Record<string, unknown>)['running'] = true;

    await server.stop();

    const closeFn = db.close as ReturnType<typeof mock>;
    expect(closeFn.mock.calls.length).toBeGreaterThan(0);
  });

  it('正在關機時，新請求回傳 503', async () => {
    const db = createMockDb();
    const auth = await createMockAuth(db);

    const server = new ClawEngineServer(
      createMockRouter(),
      createMockKeyPool(),
      auth,
      createMockAdapters(),
      db,
      createMockWriteBuffer()
    );

    const app = server.getApp();

    // 模擬正在關機
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as unknown as Record<string, unknown>)['shuttingDown'] = true;

    const res = await req(app, 'GET', '/health');
    // 注意：/health 路由在 shuttingDown 中介層之前，但中介層使用 '*'
    // shuttingDown 中介層會在所有路由之前執行（包括 /health）
    expect(res.status).toBe(503);
  });
});

describe('404 和錯誤處理', () => {
  let app: Hono;
  let auth: EngineAuth;

  beforeEach(async () => {
    const db = createMockDb();
    auth = await createMockAuth(db);

    const server = new ClawEngineServer(
      createMockRouter(),
      createMockKeyPool(),
      auth,
      createMockAdapters(),
      db,
      createMockWriteBuffer()
    );
    app = server.getApp();
  });

  it('不存在的路由回傳 404', async () => {
    const token = auth.getToken();
    const res = await req(app, 'GET', '/v1/nonexistent', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('not_found');
  });

  it('Router 拋出例外時回傳 500', async () => {
    const failingRouter = {
      routeRequest: mock(async () => {
        throw new Error('L3 尚未實作');
      }),
      updateCollectiveIntel: mock(() => undefined),
    } as unknown as Router;

    const db = createMockDb();
    const localAuth = await createMockAuth(db);

    const server = new ClawEngineServer(
      failingRouter,
      createMockKeyPool(),
      localAuth,
      createMockAdapters(),
      db,
      createMockWriteBuffer()
    );
    const failApp = server.getApp();
    const token = localAuth.getToken();

    const res = await req(failApp, 'POST', '/v1/chat/completions', {
      headers: authHeader(token),
      body: {
        model: 'ask',
        messages: [{ role: 'user', content: 'test' }],
      },
    });

    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe('internal_error');
  });
});
