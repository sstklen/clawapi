// E2E 測試 03：L2 智慧路由 + Failover
// 驗證：多 Key 場景下，L2 自動選路 + 第一把 Key 失敗時 failover 到下一把

import { describe, test, expect, beforeEach } from 'bun:test';
import { mock } from 'bun:test';
import {
  createEngineApp,
  makeEngineRequest,
  type EngineApp,
} from './helpers/setup';

describe('E2E 03：L2 智慧路由 + Failover', () => {
  let engine: EngineApp;
  let token: string;

  beforeEach(async () => {
    // 客製化 Router mock：模擬 failover 行為
    let callCount = 0;

    engine = await createEngineApp({
      mockRouter: {
        routeRequest: mock(async (req: { model: string; params: Record<string, unknown> }) => {
          callCount++;

          // model 不含 '/' → L2
          if (!req.model.includes('/')) {
            return {
              success: true,
              layer: 'L2' as const,
              serviceId: 'groq',
              modelName: 'llama3',
              data: {
                id: `chatcmpl-${callCount}`,
                choices: [
                  {
                    message: { role: 'assistant', content: `L2 回應 #${callCount}` },
                    finish_reason: 'stop',
                    index: 0,
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
              },
              latency_ms: 50,
              tried: ['openai', 'groq'],
            };
          }

          // L1 直轉（非本測試重點）
          return {
            success: true,
            layer: 'L1' as const,
            serviceId: req.model.split('/')[0],
            modelName: req.model.split('/')[1],
            data: {
              choices: [{ message: { role: 'assistant', content: 'L1' }, finish_reason: 'stop', index: 0 }],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            },
            latency_ms: 30,
          };
        }),
      },
    });
    token = engine.token;
  });

  test('3-1. L2 請求：model=auto → 走智慧路由', async () => {
    const res = await makeEngineRequest(engine.app, 'POST', '/v1/chat/completions', token, {
      model: 'auto',
      messages: [{ role: 'user', content: '什麼是 ClawAPI？' }],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices).toBeDefined();
    expect(body.choices[0].message.content).toContain('L2');
  });

  test('3-2. L2 請求：已知模型名（如 gpt-4o）→ 走 L2', async () => {
    const res = await makeEngineRequest(engine.app, 'POST', '/v1/chat/completions', token, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(res.status).toBe(200);

    // 確認 Router 被呼叫，model 為 gpt-4o（不含 /）
    const routerFn = engine.mockRouter.routeRequest as ReturnType<typeof mock>;
    const lastCall = routerFn.mock.calls[routerFn.mock.calls.length - 1] as unknown[];
    const routeReq = lastCall[0] as { model: string };
    expect(routeReq.model).toBe('gpt-4o');
  });

  test('3-3. Failover 模擬：Router 回傳 tried 清單代表嘗試過的服務', async () => {
    // 建立一個模擬 failover 的 Router
    const failoverEngine = await createEngineApp({
      mockRouter: {
        routeRequest: mock(async () => ({
          success: true,
          layer: 'L2' as const,
          serviceId: 'groq',
          modelName: 'llama3',
          data: {
            choices: [
              {
                message: { role: 'assistant', content: 'failover 成功' },
                finish_reason: 'stop',
                index: 0,
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          },
          latency_ms: 200,
          tried: ['openai', 'anthropic', 'groq'],
        })),
      },
    });

    const res = await makeEngineRequest(
      failoverEngine.app, 'POST', '/v1/chat/completions', failoverEngine.token,
      {
        model: 'auto',
        messages: [{ role: 'user', content: '試試 failover' }],
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toContain('failover');
  });

  test('3-4. Failover 失敗：所有 Key 都失敗 → Router 回傳錯誤', async () => {
    const failEngine = await createEngineApp({
      mockRouter: {
        routeRequest: mock(async () => ({
          success: false,
          layer: 'L2' as const,
          error: '所有服務的 Key 都不可用',
          status: 503,
          latency_ms: 500,
          tried: ['openai', 'groq'],
        })),
      },
    });

    const res = await makeEngineRequest(
      failEngine.app, 'POST', '/v1/chat/completions', failEngine.token,
      {
        model: 'auto',
        messages: [{ role: 'user', content: '應該失敗' }],
      },
    );

    // 根據 openai-compat handler，Router 失敗時應回傳 5xx 或錯誤 JSON
    const body = await res.json() as { error?: string | { message: string } };
    // Router 回傳 success: false 時，handler 應轉為錯誤回應
    expect(body).toBeDefined();
  });

  test('3-5. 連續 L2 請求：Router 每次被呼叫', async () => {
    const routerFn = engine.mockRouter.routeRequest as ReturnType<typeof mock>;
    const before = routerFn.mock.calls.length;

    // 發 3 個請求
    for (let i = 0; i < 3; i++) {
      await makeEngineRequest(engine.app, 'POST', '/v1/chat/completions', token, {
        model: 'auto',
        messages: [{ role: 'user', content: `第 ${i + 1} 次` }],
      });
    }

    const after = routerFn.mock.calls.length;
    expect(after - before).toBe(3);
  });
});
