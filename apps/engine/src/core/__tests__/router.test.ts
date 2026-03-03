// Router 測試
// 驗證路由層判斷邏輯、L1/L2 分派、L3/L4 stub

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { determineLayer, isKnownModel, Router } from '../router';
import type { RouteRequest } from '../router';
import type { KeyPool } from '../key-pool';
import type { AdapterExecutor } from '../../adapters/executor';
import type { AdapterConfig } from '../../adapters/loader';
import type { L0Manager } from '../../l0/manager';

// ===== 測試用 Mock =====

/** 建立最簡化的 Mock KeyPool */
function createMockKeyPool(availableKey?: {
  id: number;
  service_id: string;
  key_value: string;
}): KeyPool {
  return {
    selectKey: mock(async () => availableKey
      ? {
          id: availableKey.id,
          service_id: availableKey.service_id,
          key_value: availableKey.key_value,
          pool_type: 'king',
          status: 'active',
          pinned: false,
          priority: 0,
          daily_used: 0,
          consecutive_failures: 0,
          rate_limit_until: null,
          last_success_at: null,
        }
      : null
    ),
    getServiceIds: mock(() => availableKey ? [availableKey.service_id] : []),
    selectKeyWithFallback: mock(async () => null),
    reportSuccess: mock(async () => {}),
    reportRateLimit: mock(async () => {}),
    reportAuthError: mock(async () => {}),
    reportError: mock(async () => {}),
    addKey: mock(async () => 1),
    removeKey: mock(async () => {}),
    listKeys: mock(async () => []),
    dailyReset: mock(async () => {}),
  } as unknown as KeyPool;
}

/** 建立成功回應的 Mock AdapterExecutor */
function createMockExecutor(responseData: unknown = { ok: true }): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: true,
      status: 200,
      data: responseData,
      latency_ms: 50,
    })),
  } as unknown as AdapterExecutor;
}

/** 建立失敗回應的 Mock AdapterExecutor */
function createFailingExecutor(status: number, error: string): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: false,
      status,
      error,
      latency_ms: 10,
    })),
  } as unknown as AdapterExecutor;
}

/** 建立測試用 Adapter */
function createMockAdapter(serviceId: string): AdapterConfig {
  return {
    schema_version: 1,
    adapter: {
      id: serviceId,
      name: `${serviceId} Adapter`,
      version: '1.0.0',
      category: 'llm',
      requires_key: true,
      free_tier: false,
    },
    auth: { type: 'bearer' },
    base_url: `https://api.${serviceId}.com/v1`,
    endpoints: {
      chat: { method: 'POST', path: '/chat/completions', response_type: 'json' },
    },
    capabilities: {
      chat: true,
      streaming: false,
      embeddings: false,
      images: false,
      audio: false,
      models: [{ id: 'llama3', name: 'LLaMA 3' }],
    },
  };
}

/** 建立 Mock L0Manager */
function createMockL0Manager(): L0Manager {
  return {
    start: mock(async () => {}),
    stop: mock(() => {}),
    selectKey: mock(() => ({ key: null, source: 'none', reason: 'Mock' })),
  } as unknown as L0Manager;
}

// ===== determineLayer 測試 =====

describe('determineLayer()', () => {
  it('「groq/llama3」含斜線 → 應判定為 L1', () => {
    expect(determineLayer('groq/llama3')).toBe('L1');
  });

  it('「openai/gpt-4o」含斜線 → 應判定為 L1', () => {
    expect(determineLayer('openai/gpt-4o')).toBe('L1');
  });

  it('「service/model/extra」多個斜線 → 應判定為 L1', () => {
    expect(determineLayer('service/model/extra')).toBe('L1');
  });

  it('「auto」→ 應判定為 L2', () => {
    expect(determineLayer('auto')).toBe('L2');
  });

  it('「ask」→ 應判定為 L3', () => {
    expect(determineLayer('ask')).toBe('L3');
  });

  it('「task」→ 應判定為 L4', () => {
    expect(determineLayer('task')).toBe('L4');
  });

  it('已知模型名稱「gpt-4o」→ 應判定為 L2', () => {
    expect(determineLayer('gpt-4o')).toBe('L2');
  });

  it('已知模型名稱「claude-3-5-sonnet」→ 應判定為 L2', () => {
    expect(determineLayer('claude-3-5-sonnet')).toBe('L2');
  });

  it('未知名稱「my-custom-model」→ 預設 L2', () => {
    expect(determineLayer('my-custom-model')).toBe('L2');
  });

  it('空字串 → 預設 L2', () => {
    expect(determineLayer('')).toBe('L2');
  });
});

// ===== isKnownModel 測試 =====

describe('isKnownModel()', () => {
  it('gpt-4o 應為已知模型', () => {
    expect(isKnownModel('gpt-4o')).toBe(true);
  });

  it('random-unknown-model 應為未知模型', () => {
    expect(isKnownModel('random-unknown-model')).toBe(false);
  });
});

// ===== Router.routeRequest 測試 =====

describe('Router.routeRequest()', () => {
  let adapters: Map<string, AdapterConfig>;

  beforeEach(() => {
    adapters = new Map([['groq', createMockAdapter('groq')]]);
  });

  // --- L1 路由 ---
  it('model="groq/llama3" 應走 L1，layer 欄位為 L1', async () => {
    const keyPool = createMockKeyPool({
      id: 1,
      service_id: 'groq',
      key_value: 'gsk_test_key',
    });
    const executor = createMockExecutor({ answer: 42 });
    const router = new Router(keyPool, executor, adapters, createMockL0Manager());

    const req: RouteRequest = {
      model: 'groq/llama3',
      params: { messages: [{ role: 'user', content: 'Hi' }] },
    };

    const result = await router.routeRequest(req);

    expect(result.layer).toBe('L1');
    expect(result.success).toBe(true);
  });

  // --- L2 路由 ---
  it('model="auto" 應走 L2，layer 欄位為 L2', async () => {
    const keyPool = createMockKeyPool({
      id: 1,
      service_id: 'groq',
      key_value: 'gsk_test_key',
    });
    const executor = createMockExecutor();
    const router = new Router(keyPool, executor, adapters, createMockL0Manager());

    const req: RouteRequest = {
      model: 'auto',
      params: { messages: [{ role: 'user', content: 'Hi' }] },
    };

    const result = await router.routeRequest(req);

    expect(result.layer).toBe('L2');
  });

  // --- L3 AI 管家 ---
  it('model="ask" 應走 L3，回傳 layer="L3"', async () => {
    const keyPool = createMockKeyPool();
    const executor = createMockExecutor();
    const router = new Router(keyPool, executor, adapters, createMockL0Manager());

    const req: RouteRequest = {
      model: 'ask',
      params: {},
    };

    // L3 已實作，會嘗試取Claw Key（未設定），回傳失敗但 layer='L3'
    const result = await router.routeRequest(req);
    expect(result.layer).toBe('L3');
    // 沒有 LLM Key 時 → success=false + 錯誤說明
    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM Key');
  });

  // --- L4 已實作 ---
  it('model="task" 應走 L4，無Claw Key時回傳錯誤', async () => {
    const keyPool = createMockKeyPool();
    const executor = createMockExecutor();
    const router = new Router(keyPool, executor, adapters, createMockL0Manager());

    const req: RouteRequest = {
      model: 'task',
      params: { messages: [{ role: 'user', content: '測試任務' }] },
    };

    const result = await router.routeRequest(req);
    // L4 已實作，無Claw Key時回傳 success=false + 錯誤訊息
    expect(result.layer).toBe('L4');
    expect(result.success).toBe(false);
  });

  // --- L1 無 Key ---
  it('L1 沒有可用 Key → success=false，含友善錯誤訊息', async () => {
    const keyPool = createMockKeyPool();  // 沒有 Key
    const executor = createMockExecutor();
    const router = new Router(keyPool, executor, adapters, createMockL0Manager());

    const req: RouteRequest = {
      model: 'groq/llama3',
      params: { messages: [] },
    };

    const result = await router.routeRequest(req);

    expect(result.success).toBe(false);
    expect(result.layer).toBe('L1');
    expect(result.error).toBeTruthy();
  });

  // --- L1 executor 失敗 ---
  it('L1 executor 回傳 429 → success=false，含錯誤訊息', async () => {
    const keyPool = createMockKeyPool({
      id: 1,
      service_id: 'groq',
      key_value: 'gsk_test',
    });
    const executor = createFailingExecutor(429, '速率限制');
    const router = new Router(keyPool, executor, adapters, createMockL0Manager());

    const req: RouteRequest = {
      model: 'groq/llama3',
      params: { messages: [] },
    };

    const result = await router.routeRequest(req);

    expect(result.success).toBe(false);
    expect(result.layer).toBe('L1');
  });

  // --- L2 無服務 Key ---
  it('L2 無任何服務 Key → success=false，layer=L2', async () => {
    const keyPool = createMockKeyPool();  // getServiceIds 回傳空陣列
    const executor = createMockExecutor();
    const router = new Router(keyPool, executor, adapters, createMockL0Manager());

    const req: RouteRequest = {
      model: 'auto',
      params: { messages: [] },
    };

    const result = await router.routeRequest(req);

    expect(result.success).toBe(false);
    expect(result.layer).toBe('L2');
  });
});
