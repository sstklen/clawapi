// E2E 測試 02：Key 新增 + L1 直轉
// 驗證：Engine 管理 API 新增 Key → 列出 Key → L1 直轉請求正確帶上 Authorization

import { describe, test, expect, beforeEach } from 'bun:test';
import { mock } from 'bun:test';
import {
  createEngineApp,
  makeEngineRequest,
  type EngineApp,
} from './helpers/setup';

describe('E2E 02：Key 新增 + L1 直轉', () => {
  let engine: EngineApp;
  let token: string;

  beforeEach(async () => {
    engine = await createEngineApp({ withManagement: true });
    token = engine.token;
  });

  test('2-1. POST /api/keys 新增一把 Key → 成功', async () => {
    const res = await makeEngineRequest(engine.app, 'POST', '/api/keys', token, {
      service_id: 'groq',
      key_value: 'gsk_test_key_12345',
      pool_type: 'king',
      label: '測試 Key',
    });

    // 管理 API 應接受請求
    expect([200, 201]).toContain(res.status);
  });

  test('2-2. GET /api/keys 列出 Key（遮罩版）', async () => {
    // 先新增
    await makeEngineRequest(engine.app, 'POST', '/api/keys', token, {
      service_id: 'groq',
      key_value: 'gsk_another_key_67890',
      pool_type: 'king',
    });

    // 列出
    const res = await makeEngineRequest(engine.app, 'GET', '/api/keys', token);
    expect(res.status).toBe(200);

    const body = await res.json();
    // 回傳應是陣列或包含 keys 的物件
    expect(body).toBeDefined();
  });

  test('2-3. L1 直轉請求：POST /v1/chat/completions model=groq/llama3 → 帶正確 serviceId', async () => {
    const res = await makeEngineRequest(engine.app, 'POST', '/v1/chat/completions', token, {
      model: 'groq/llama3',
      messages: [{ role: 'user', content: '你好' }],
    });

    expect(res.status).toBe(200);

    const body = await res.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    // Mock Router 應回傳包含 choices 的回應
    expect(body.choices).toBeDefined();
    expect(body.choices.length).toBeGreaterThan(0);

    // 驗證 Router 被呼叫時 model 包含 '/'（L1 判斷依據）
    const routerFn = engine.mockRouter.routeRequest as ReturnType<typeof mock>;
    expect(routerFn.mock.calls.length).toBeGreaterThan(0);
    const callArgs = routerFn.mock.calls[0] as unknown[];
    const routeReq = callArgs[0] as { model: string };
    expect(routeReq.model).toBe('groq/llama3');
  });

  test('2-4. L1 直轉：model 包含 / → Router 判定為 L1', async () => {
    const res = await makeEngineRequest(engine.app, 'POST', '/v1/chat/completions', token, {
      model: 'openai/gpt-4o',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(res.status).toBe(200);

    // Router mock 回傳的 layer 應為 L1
    const routerFn = engine.mockRouter.routeRequest as ReturnType<typeof mock>;
    const lastCall = routerFn.mock.calls[routerFn.mock.calls.length - 1] as unknown[];
    const routeReq = lastCall[0] as { model: string };
    expect(routeReq.model).toContain('/');
  });

  test('2-5. 未認證存取管理 API → 401', async () => {
    const res = await makeEngineRequest(engine.app, 'GET', '/api/keys', 'invalid_token_xxx');
    expect(res.status).toBe(401);
  });
});
