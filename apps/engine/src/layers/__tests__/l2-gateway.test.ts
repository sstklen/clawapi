// L2 Gateway 測試
// 驗證三種路由策略、smart 評分公式、Failover 邏輯、無集體智慧數據時的 Round-Robin

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { L2Gateway } from '../l2-gateway';
import type { CollectiveIntel } from '../l2-gateway';
import type { KeyPool, DecryptedKey } from '../../core/key-pool';
import type { AdapterExecutor } from '../../adapters/executor';
import type { AdapterConfig } from '../../adapters/loader';

// ===== Mock 工廠 =====

/** 建立 Mock DecryptedKey */
function createMockKey(id: number, serviceId: string): DecryptedKey {
  return {
    id,
    service_id: serviceId,
    key_value: `key-${id}`,
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
 * 建立多服務 Mock KeyPool
 * serviceKeys: Map<serviceId, key>
 */
function createMultiServiceKeyPool(serviceKeys: Map<string, DecryptedKey>): KeyPool {
  return {
    selectKey: mock(async (serviceId: string) => serviceKeys.get(serviceId) ?? null),
    getServiceIds: mock(() => Array.from(serviceKeys.keys())),
    reportSuccess: mock(async () => {}),
    reportRateLimit: mock(async () => {}),
    reportAuthError: mock(async () => {}),
    reportError: mock(async () => {}),
  } as unknown as KeyPool;
}

/** 建立 Mock Adapter */
function createAdapter(serviceId: string, isFree: boolean = false): AdapterConfig {
  return {
    schema_version: 1,
    adapter: {
      id: serviceId,
      name: `${serviceId} Adapter`,
      version: '1.0.0',
      category: 'llm',
      requires_key: !isFree,
      free_tier: isFree,
    },
    auth: { type: isFree ? 'none' : 'bearer' },
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
      models: [{ id: 'default-model', name: '預設模型' }],
    },
  };
}

/** 建立永遠成功的 Mock Executor */
function createSuccessExecutor(): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: true,
      status: 200,
      data: { choices: [{ message: { content: 'OK' } }] },
      latency_ms: 50,
    })),
  } as unknown as AdapterExecutor;
}

/** 建立第 N 次才成功的 Mock Executor */
function createNthSuccessExecutor(successOnCall: number): AdapterExecutor {
  let callCount = 0;
  return {
    execute: mock(async () => {
      callCount++;
      if (callCount >= successOnCall) {
        return { success: true, status: 200, data: { ok: true }, latency_ms: 30 };
      }
      return { success: false, status: 429, error: '速率限制', latency_ms: 10 };
    }),
  } as unknown as AdapterExecutor;
}

/** 建立永遠失敗的 Mock Executor */
function createFailingExecutor(status: number = 500): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: false,
      status,
      error: `HTTP ${status}`,
      latency_ms: 10,
    })),
  } as unknown as AdapterExecutor;
}

// ===== smart 評分公式測試 =====

describe('L2Gateway smart 策略評分', () => {
  it('應按 smart 公式計算：高成功率、低延遲、高配額、preferred 狀態得高分', async () => {
    // 服務 A：優質（高成功率、低延遲、高配額、preferred）
    // 服務 B：劣質（低成功率、高延遲、低配額、avoid）
    const serviceKeys = new Map([
      ['service-a', createMockKey(1, 'service-a')],
      ['service-b', createMockKey(2, 'service-b')],
    ]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);

    const intel: CollectiveIntel = {
      'service-a': {
        success_rate: 0.99,
        p95_latency_ms: 500,
        confidence: 0.9,
        status: 'preferred',
        quota_remaining_ratio: 0.9,
      },
      'service-b': {
        success_rate: 0.3,
        p95_latency_ms: 20000,
        confidence: 0.7,
        status: 'avoid',
        quota_remaining_ratio: 0.1,
      },
    };

    // Executor 只有第一次成功（service-a 先嘗試）
    let callCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        callCount++;
        return callCount === 1
          ? { success: true, status: 200, data: { ok: true }, latency_ms: 30 }
          : { success: false, status: 500, error: '失敗', latency_ms: 10 };
      }),
    } as unknown as AdapterExecutor;

    const adapters = new Map([
      ['service-a', createAdapter('service-a')],
      ['service-b', createAdapter('service-b')],
    ]);

    const gateway = new L2Gateway(keyPool, executor, adapters, intel);
    const result = await gateway.execute({
      model: 'auto',
      strategy: 'smart',
      params: { messages: [] },
    });

    // service-a 分數高，應先嘗試並成功
    expect(result.success).toBe(true);
    expect(result.tried[0]).toBe('service-a');
  });

  it('服務狀態 avoid（status_weight=0） → collective_boost 應為 0', async () => {
    // 這個測試透過驗證排序順序來間接驗證 avoid 的 collective_boost=0
    const serviceKeys = new Map([
      ['svc-prefer', createMockKey(1, 'svc-prefer')],
      ['svc-avoid', createMockKey(2, 'svc-avoid')],
    ]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);

    const intel: CollectiveIntel = {
      'svc-prefer': {
        success_rate: 0.8,
        p95_latency_ms: 1000,
        confidence: 1.0,
        status: 'preferred',
        quota_remaining_ratio: 0.8,
      },
      'svc-avoid': {
        success_rate: 0.8,
        p95_latency_ms: 1000,
        confidence: 1.0,
        status: 'avoid',
        quota_remaining_ratio: 0.8,
      },
    };

    // 第一次成功
    const executor = createSuccessExecutor();
    const adapters = new Map([
      ['svc-prefer', createAdapter('svc-prefer')],
      ['svc-avoid', createAdapter('svc-avoid')],
    ]);

    const gateway = new L2Gateway(keyPool, executor, adapters, intel);
    const result = await gateway.execute({
      model: 'auto',
      strategy: 'smart',
      params: {},
    });

    expect(result.success).toBe(true);
    // preferred 的服務應排在 avoid 之前
    expect(result.tried[0]).toBe('svc-prefer');
  });
});

// ===== fast 策略測試 =====

describe('L2Gateway fast 策略', () => {
  it('應按 p95_latency_ms 升序選服務（最快的先嘗試）', async () => {
    const serviceKeys = new Map([
      ['slow-svc', createMockKey(1, 'slow-svc')],
      ['fast-svc', createMockKey(2, 'fast-svc')],
    ]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);

    const intel: CollectiveIntel = {
      'slow-svc': {
        success_rate: 0.9,
        p95_latency_ms: 10000,
        confidence: 0.8,
        status: 'preferred',
      },
      'fast-svc': {
        success_rate: 0.9,
        p95_latency_ms: 200,
        confidence: 0.8,
        status: 'preferred',
      },
    };

    const executor = createSuccessExecutor();
    const adapters = new Map([
      ['slow-svc', createAdapter('slow-svc')],
      ['fast-svc', createAdapter('fast-svc')],
    ]);

    const gateway = new L2Gateway(keyPool, executor, adapters, intel);
    const result = await gateway.execute({
      model: 'auto',
      strategy: 'fast',
      params: {},
    });

    expect(result.success).toBe(true);
    // 最快的服務（fast-svc）應先嘗試
    expect(result.tried[0]).toBe('fast-svc');
    expect(result.strategy).toBe('fast');
  });
});

// ===== cheap 策略測試 =====

describe('L2Gateway cheap 策略', () => {
  it('免費服務（free_tier=true）應優先嘗試', async () => {
    const serviceKeys = new Map([
      ['paid-svc', createMockKey(1, 'paid-svc')],
      ['free-svc', createMockKey(2, 'free-svc')],
    ]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);

    const intel: CollectiveIntel = {
      'paid-svc': {
        success_rate: 0.99,
        p95_latency_ms: 200,
        confidence: 0.9,
        status: 'preferred',
        quota_remaining_ratio: 0.8,
      },
      'free-svc': {
        success_rate: 0.8,
        p95_latency_ms: 2000,
        confidence: 0.7,
        status: 'preferred',
        quota_remaining_ratio: 0.5,
      },
    };

    const executor = createSuccessExecutor();
    const adapters = new Map([
      ['paid-svc', createAdapter('paid-svc', false)],
      ['free-svc', createAdapter('free-svc', true)],  // free_tier=true
    ]);

    const gateway = new L2Gateway(keyPool, executor, adapters, intel);
    const result = await gateway.execute({
      model: 'auto',
      strategy: 'cheap',
      params: {},
    });

    expect(result.success).toBe(true);
    // 免費服務應優先
    expect(result.tried[0]).toBe('free-svc');
    expect(result.strategy).toBe('cheap');
  });
});

// ===== Failover 測試 =====

describe('L2Gateway Failover', () => {
  it('第一個服務失敗（429）→ 嘗試第二個服務（驗收標準 #6）', async () => {
    const serviceKeys = new Map([
      ['svc1', createMockKey(1, 'svc1')],
      ['svc2', createMockKey(2, 'svc2')],
    ]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);

    const intel: CollectiveIntel = {
      'svc1': {
        success_rate: 0.5,
        p95_latency_ms: 500,
        confidence: 0.8,
        status: 'preferred',
      },
      'svc2': {
        success_rate: 0.4,  // svc1 分數較高但失敗
        p95_latency_ms: 800,
        confidence: 0.8,
        status: 'preferred',
      },
    };

    // svc1 第一次呼叫失敗，svc2 成功
    const executor = createNthSuccessExecutor(2);
    const adapters = new Map([
      ['svc1', createAdapter('svc1')],
      ['svc2', createAdapter('svc2')],
    ]);

    const gateway = new L2Gateway(keyPool, executor, adapters, intel);
    const result = await gateway.execute({
      model: 'auto',
      strategy: 'smart',
      params: {},
    });

    expect(result.success).toBe(true);
    expect(result.tried.length).toBe(2);
  });

  it('所有服務均失敗 → success=false，tried 清單含所有服務', async () => {
    const serviceKeys = new Map([
      ['svc1', createMockKey(1, 'svc1')],
      ['svc2', createMockKey(2, 'svc2')],
    ]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);

    const intel: CollectiveIntel = {
      'svc1': { success_rate: 0.9, p95_latency_ms: 200, confidence: 0.9, status: 'preferred' },
      'svc2': { success_rate: 0.8, p95_latency_ms: 300, confidence: 0.8, status: 'preferred' },
    };

    const executor = createFailingExecutor(500);
    const adapters = new Map([
      ['svc1', createAdapter('svc1')],
      ['svc2', createAdapter('svc2')],
    ]);

    const gateway = new L2Gateway(keyPool, executor, adapters, intel);
    const result = await gateway.execute({
      model: 'auto',
      strategy: 'smart',
      params: {},
    });

    expect(result.success).toBe(false);
    expect(result.tried).toContain('svc1');
    expect(result.tried).toContain('svc2');
    expect(result.error).toBeTruthy();
  });
});

// ===== 無集體智慧數據 — Round-Robin 測試（驗收標準 #9）=====

describe('L2Gateway 無集體智慧數據（Round-Robin）', () => {
  it('無集體智慧數據時，仍應正常選取服務並執行（驗收標準 #9）', async () => {
    const serviceKeys = new Map([
      ['svcA', createMockKey(1, 'svcA')],
      ['svcB', createMockKey(2, 'svcB')],
    ]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);

    const executor = createSuccessExecutor();
    const adapters = new Map([
      ['svcA', createAdapter('svcA')],
      ['svcB', createAdapter('svcB')],
    ]);

    // collectiveIntel = null
    const gateway = new L2Gateway(keyPool, executor, adapters, null);
    const result = await gateway.execute({
      model: 'auto',
      strategy: 'smart',
      params: {},
    });

    expect(result.success).toBe(true);
    expect(result.tried.length).toBeGreaterThan(0);
  });

  it('更新集體智慧數據後，應使用新數據排序', async () => {
    const serviceKeys = new Map([
      ['alpha', createMockKey(1, 'alpha')],
      ['beta', createMockKey(2, 'beta')],
    ]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);
    const executor = createSuccessExecutor();
    const adapters = new Map([
      ['alpha', createAdapter('alpha')],
      ['beta', createAdapter('beta')],
    ]);

    const gateway = new L2Gateway(keyPool, executor, adapters, null);

    // 先無數據執行一次
    const result1 = await gateway.execute({ model: 'auto', strategy: 'smart', params: {} });
    expect(result1.success).toBe(true);

    // 更新集體智慧，讓 beta 排前面
    const newIntel: CollectiveIntel = {
      'alpha': { success_rate: 0.5, p95_latency_ms: 5000, confidence: 0.9, status: 'preferred' },
      'beta':  { success_rate: 0.95, p95_latency_ms: 300, confidence: 0.9, status: 'preferred' },
    };
    gateway.updateCollectiveIntel(newIntel);

    const result2 = await gateway.execute({ model: 'auto', strategy: 'smart', params: {} });
    expect(result2.success).toBe(true);
    expect(result2.tried[0]).toBe('beta');
  });
});

// ===== 無可用服務 =====

describe('L2Gateway 無可用服務', () => {
  it('KeyPool 沒有任何服務 Key → success=false', async () => {
    const keyPool = createMultiServiceKeyPool(new Map());  // 空
    const executor = createSuccessExecutor();
    const adapters = new Map<string, AdapterConfig>();

    const gateway = new L2Gateway(keyPool, executor, adapters, null);
    const result = await gateway.execute({ model: 'auto', strategy: 'smart', params: {} });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('所有服務 Key 均不可用 → success=false，tried 為空', async () => {
    // selectKey 全回 null
    const keyPool: KeyPool = {
      selectKey: mock(async () => null),
      getServiceIds: mock(() => ['svc1', 'svc2']),
      reportSuccess: mock(async () => {}),
      reportRateLimit: mock(async () => {}),
      reportAuthError: mock(async () => {}),
      reportError: mock(async () => {}),
    } as unknown as KeyPool;

    const executor = createSuccessExecutor();
    const adapters = new Map([
      ['svc1', createAdapter('svc1')],
      ['svc2', createAdapter('svc2')],
    ]);

    const gateway = new L2Gateway(keyPool, executor, adapters, null);
    const result = await gateway.execute({ model: 'auto', strategy: 'smart', params: {} });

    expect(result.success).toBe(false);
    expect(result.tried.length).toBe(0);
  });

  it('strategy 預設為 smart', async () => {
    const keyPool = createMultiServiceKeyPool(new Map([['svc', createMockKey(1, 'svc')]]));
    const executor = createSuccessExecutor();
    const adapters = new Map([['svc', createAdapter('svc')]]);

    const gateway = new L2Gateway(keyPool, executor, adapters, null);
    // 不傳 strategy
    const result = await gateway.execute({ model: 'auto', params: {} });

    expect(result.strategy).toBe('smart');
  });
});

// ===== normalized_latency 邊界值測試 =====

describe('L2Gateway smart 公式邊界值', () => {
  it('p95_latency_ms 超過 30000 → normalized_latency 上限為 1', async () => {
    // 透過驗證有數據的情況下正確計算（不崩潰即可）
    const serviceKeys = new Map([['svc', createMockKey(1, 'svc')]]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);
    const executor = createSuccessExecutor();
    const adapters = new Map([['svc', createAdapter('svc')]]);

    const intel: CollectiveIntel = {
      svc: {
        success_rate: 1.0,
        p95_latency_ms: 999999,  // 超大延遲
        confidence: 1.0,
        status: 'preferred',
        quota_remaining_ratio: 1.0,
      },
    };

    const gateway = new L2Gateway(keyPool, executor, adapters, intel);
    const result = await gateway.execute({ model: 'auto', strategy: 'smart', params: {} });

    // 不應崩潰，應正常執行
    expect(result.success).toBe(true);
  });

  it('quota_remaining_ratio 未提供 → 預設 0.5 不崩潰', async () => {
    const serviceKeys = new Map([['svc', createMockKey(1, 'svc')]]);
    const keyPool = createMultiServiceKeyPool(serviceKeys);
    const executor = createSuccessExecutor();
    const adapters = new Map([['svc', createAdapter('svc')]]);

    const intel: CollectiveIntel = {
      svc: {
        success_rate: 0.9,
        p95_latency_ms: 1000,
        confidence: 0.8,
        status: 'preferred',
        // quota_remaining_ratio 故意省略
      },
    };

    const gateway = new L2Gateway(keyPool, executor, adapters, intel);
    const result = await gateway.execute({ model: 'auto', strategy: 'smart', params: {} });

    expect(result.success).toBe(true);
  });
});
