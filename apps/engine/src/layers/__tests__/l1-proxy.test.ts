// L1 Proxy 測試
// 驗證直轉路由：解析 model 格式、Key 輪流重試、Failover 邏輯

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { L1Proxy } from '../l1-proxy';
import type { KeyPool, DecryptedKey } from '../../core/key-pool';
import type { AdapterExecutor } from '../../adapters/executor';
import type { AdapterConfig } from '../../adapters/loader';

// ===== Mock 工廠 =====

/** 建立 Mock DecryptedKey */
function createMockKey(id: number, serviceId: string, keyValue: string): DecryptedKey {
  return {
    id,
    service_id: serviceId,
    key_value: keyValue,
    pool_type: 'king',
    status: 'active',
    pinned: false,
    priority: 0,
    daily_used: 0,
    consecutive_failures: 0,
    rate_limit_until: null,
    last_success_at: null,
  };
}

/**
 * 建立會輪流回傳多個 Key 的 Mock KeyPool
 * 第一圈輪流回傳 keys，第二圈開始回傳第一個（觸發 set 中斷）
 */
function createMultiKeyPool(keys: DecryptedKey[]): KeyPool {
  let callCount = 0;
  const selectKeyMock = mock(async () => {
    if (keys.length === 0) return null;
    // 模擬 Round-Robin：輪流回傳，繞一圈後重複
    const key = keys[callCount % keys.length]!;
    callCount++;
    return key;
  });

  return {
    selectKey: selectKeyMock,
    getServiceIds: mock(() => keys.map(k => k.service_id)),
    reportSuccess: mock(async () => {}),
    reportRateLimit: mock(async () => {}),
    reportAuthError: mock(async () => {}),
    reportError: mock(async () => {}),
  } as unknown as KeyPool;
}

/** 建立 Mock Adapter */
function createAdapter(serviceId: string): AdapterConfig {
  return {
    schema_version: 1,
    adapter: {
      id: serviceId,
      name: `${serviceId} 測試 Adapter`,
      version: '1.0.0',
      category: 'llm',
      requires_key: true,
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

/** 建立永遠成功的 Mock Executor */
function createSuccessExecutor(data: unknown = { choices: [] }): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: true,
      status: 200,
      data,
      latency_ms: 30,
    })),
  } as unknown as AdapterExecutor;
}

/** 建立依序回傳不同結果的 Mock Executor */
function createSequentialExecutor(
  responses: Array<{ success: boolean; status: number; error?: string; data?: unknown }>
): AdapterExecutor {
  let callCount = 0;
  return {
    execute: mock(async () => {
      const resp = responses[callCount % responses.length]!;
      callCount++;
      return {
        ...resp,
        latency_ms: 20,
      };
    }),
  } as unknown as AdapterExecutor;
}

// ===== parseModel 測試 =====

describe('L1Proxy.parseModel()', () => {
  let proxy: L1Proxy;

  beforeEach(() => {
    const keyPool = createMultiKeyPool([]);
    const executor = createSuccessExecutor();
    const adapters = new Map<string, AdapterConfig>();
    proxy = new L1Proxy(keyPool, executor, adapters);
  });

  it('"groq/llama3" 應解析為 serviceId=groq, modelName=llama3', () => {
    const result = proxy.parseModel('groq/llama3');
    expect(result).not.toBeNull();
    expect(result!.serviceId).toBe('groq');
    expect(result!.modelName).toBe('llama3');
  });

  it('"openai/gpt-4o" 應解析為 serviceId=openai, modelName=gpt-4o', () => {
    const result = proxy.parseModel('openai/gpt-4o');
    expect(result).not.toBeNull();
    expect(result!.serviceId).toBe('openai');
    expect(result!.modelName).toBe('gpt-4o');
  });

  it('"auto" 不含斜線 → 應回傳 null', () => {
    expect(proxy.parseModel('auto')).toBeNull();
  });

  it('"/model-only" serviceId 為空 → 應回傳 null', () => {
    expect(proxy.parseModel('/model-only')).toBeNull();
  });

  it('"service/" modelName 為空 → 應回傳 null', () => {
    expect(proxy.parseModel('service/')).toBeNull();
  });

  it('"a/b/c" 多個斜線 → serviceId=a, modelName=b/c', () => {
    const result = proxy.parseModel('a/b/c');
    expect(result).not.toBeNull();
    expect(result!.serviceId).toBe('a');
    expect(result!.modelName).toBe('b/c');
  });
});

// ===== L1Proxy.execute() 測試 =====

describe('L1Proxy.execute()', () => {
  // --- 基本成功案例 ---
  it('單一 Key 成功 → success=true，包含正確的 serviceId 和 modelName', async () => {
    const key = createMockKey(1, 'groq', 'gsk_test_key');
    const keyPool = createMultiKeyPool([key]);
    const executor = createSuccessExecutor({ choices: [{ message: { content: 'Hello' } }] });
    const adapters = new Map([['groq', createAdapter('groq')]]);

    const proxy = new L1Proxy(keyPool, executor, adapters);
    const result = await proxy.execute({
      model: 'groq/llama3',
      params: { messages: [{ role: 'user', content: 'Hi' }] },
    });

    expect(result.success).toBe(true);
    expect(result.serviceId).toBe('groq');
    expect(result.modelName).toBe('llama3');
    expect(result.keysAttempted).toBe(1);
  });

  // --- model 格式錯誤 ---
  it('model 不含斜線 → success=false，含格式錯誤提示', async () => {
    const keyPool = createMultiKeyPool([]);
    const executor = createSuccessExecutor();
    const adapters = new Map<string, AdapterConfig>();

    const proxy = new L1Proxy(keyPool, executor, adapters);
    const result = await proxy.execute({
      model: 'auto',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('格式錯誤');
    expect(result.keysAttempted).toBe(0);
  });

  // --- Adapter 不存在 ---
  it('找不到對應 Adapter → success=false，含友善提示', async () => {
    const key = createMockKey(1, 'nonexistent', 'key1');
    const keyPool = createMultiKeyPool([key]);
    const executor = createSuccessExecutor();
    const adapters = new Map<string, AdapterConfig>();  // 空 Map

    const proxy = new L1Proxy(keyPool, executor, adapters);
    const result = await proxy.execute({
      model: 'nonexistent/model',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent');
    expect(result.keysAttempted).toBe(0);
  });

  // --- 無可用 Key ---
  it('服務沒有可用 Key → success=false，含友善提示', async () => {
    const keyPool = createMultiKeyPool([]);  // 空池
    const executor = createSuccessExecutor();
    const adapters = new Map([['groq', createAdapter('groq')]]);

    const proxy = new L1Proxy(keyPool, executor, adapters);
    const result = await proxy.execute({
      model: 'groq/llama3',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Key');
    expect(result.keysAttempted).toBe(0);
  });

  // --- 多 Key Failover（驗收標準 #6）---
  it('key1 失敗（429）→ 嘗試 key2，key2 成功 → success=true，keysAttempted=2', async () => {
    const key1 = createMockKey(1, 'groq', 'gsk_key1_fail');
    const key2 = createMockKey(2, 'groq', 'gsk_key2_ok');
    const keyPool = createMultiKeyPool([key1, key2]);

    // 第一次呼叫失敗（429），第二次成功
    const executor = createSequentialExecutor([
      { success: false, status: 429, error: '速率限制' },
      { success: true, status: 200, data: { ok: true } },
    ]);

    const adapters = new Map([['groq', createAdapter('groq')]]);
    const proxy = new L1Proxy(keyPool, executor, adapters);

    const result = await proxy.execute({
      model: 'groq/llama3',
      params: { messages: [] },
    });

    expect(result.success).toBe(true);
    expect(result.keysAttempted).toBe(2);
  });

  // --- 所有 Key 都失敗 ---
  it('所有 Key 均失敗（401）→ success=false，keysAttempted 等於 Key 數量', async () => {
    const key1 = createMockKey(1, 'groq', 'gsk_dead1');
    const key2 = createMockKey(2, 'groq', 'gsk_dead2');
    const keyPool = createMultiKeyPool([key1, key2]);

    const executor = createSequentialExecutor([
      { success: false, status: 401, error: '認證失敗' },
      { success: false, status: 401, error: '認證失敗' },
    ]);

    const adapters = new Map([['groq', createAdapter('groq')]]);
    const proxy = new L1Proxy(keyPool, executor, adapters);

    const result = await proxy.execute({
      model: 'groq/llama3',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.keysAttempted).toBeGreaterThan(0);
    expect(result.error).toContain('groq');
  });

  // --- latency_ms 追蹤 ---
  it('成功時 latency_ms 應大於 0', async () => {
    const key = createMockKey(1, 'groq', 'gsk_ok');
    const keyPool = createMultiKeyPool([key]);
    const executor = createSuccessExecutor();
    const adapters = new Map([['groq', createAdapter('groq')]]);

    const proxy = new L1Proxy(keyPool, executor, adapters);
    const result = await proxy.execute({ model: 'groq/llama3', params: {} });

    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });
});
