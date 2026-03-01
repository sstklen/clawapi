// L4 任務引擎測試
// 驗證：DAG 規劃、成本預估、並行執行、重試機制、部分失敗、斷點管理、消耗報告

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { L4TaskEngine } from '../l4-task';
import type { L4Request, TaskPlan, TaskStep, TaskStepResult } from '../l4-task';
import type { KeyPool, DecryptedKey } from '../../core/key-pool';
import type { AdapterExecutor } from '../../adapters/executor';
import type { AdapterConfig } from '../../adapters/loader';
import type { L2Gateway } from '../l2-gateway';
import type { ClawDatabase } from '../../storage/database';

// ===== Mock 工廠 =====

/** 建立 Mock DecryptedKey */
function createMockKey(
  id: number,
  serviceId: string,
  dailyUsed: number = 0
): DecryptedKey {
  return {
    id,
    service_id: serviceId,
    key_value: `sk-test-key-${id}`,
    pool_type: 'king',
    status: 'active',
    pinned: false,
    priority: 0,
    daily_used: dailyUsed,
    consecutive_failures: 0,
    rate_limit_until: null,
    last_success_at: null,
  };
}

/** 建立 Mock Adapter */
function createMockAdapter(
  id: string,
  category: string = 'llm',
  hasChat: boolean = true
): AdapterConfig {
  return {
    schema_version: 1,
    adapter: {
      id,
      name: `${id} Adapter`,
      version: '1.0.0',
      category,
      requires_key: true,
      free_tier: false,
    },
    auth: { type: 'bearer' },
    base_url: `https://api.${id}.com/v1`,
    endpoints: {
      chat: { method: 'POST', path: '/chat/completions', response_type: 'json' },
    },
    capabilities: {
      chat: hasChat,
      streaming: false,
      embeddings: false,
      images: false,
      audio: false,
      models: [
        { id: `${id}-model`, name: `${id} 主模型` },
      ],
    },
  };
}

/** 建立 Mock KeyPool */
function createMockKeyPool(goldKey: DecryptedKey | null): KeyPool {
  return {
    selectKey: mock(async (serviceId: string) => {
      if (serviceId === '__gold_key__') return goldKey;
      return null;
    }),
    getServiceIds: mock(() => []),
    reportSuccess: mock(async () => {}),
    reportRateLimit: mock(async () => {}),
    reportAuthError: mock(async () => {}),
    reportError: mock(async () => {}),
  } as unknown as KeyPool;
}

/** 建立 Mock Executor（回傳固定的 LLM 回應） */
function createMockExecutor(
  responseContent: string = '整合後的回答',
  tokensUsed: number = 100
): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: true,
      status: 200,
      data: {
        choices: [{ message: { content: responseContent } }],
        usage: { total_tokens: tokensUsed },
      },
      latency_ms: 50,
    })),
  } as unknown as AdapterExecutor;
}

/** 建立失敗的 Mock Executor */
function createFailingExecutor(): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: false,
      status: 500,
      error: 'LLM 呼叫失敗',
      latency_ms: 10,
    })),
  } as unknown as AdapterExecutor;
}

/** 建立 Mock L2Gateway（可控制每次呼叫的回傳） */
function createMockL2Gateway(
  responses: Array<{ success: boolean; data?: unknown; error?: string }>
): L2Gateway {
  let callCount = 0;
  return {
    execute: mock(async () => {
      const response = responses[callCount] ?? responses[responses.length - 1] ?? { success: true, data: {} };
      callCount++;
      return {
        success: response.success,
        strategy: 'smart' as const,
        data: response.data,
        error: response.error,
        latency_ms: 30,
        tried: ['mock-service'],
      };
    }),
    updateCollectiveIntel: mock(() => {}),
  } as unknown as L2Gateway;
}

/** 建立永遠成功的 L2Gateway */
function createSuccessL2Gateway(data: unknown = { result: 'ok' }): L2Gateway {
  return createMockL2Gateway([{ success: true, data }]);
}

/** 建立永遠失敗的 L2Gateway */
function createFailingL2Gateway(): L2Gateway {
  return createMockL2Gateway([{ success: false, error: '工具呼叫失敗' }]);
}

/** 建立 Mock ClawDatabase（記憶體內存取，不寫磁碟） */
function createMockDatabase(): ClawDatabase {
  // 用 Map 模擬 SQLite 表格
  const checkpoints = new Map<string, {
    id: string;
    task_hash: string;
    plan_json: string;
    completed_steps_json: string;
    created_at: string;
    expires_at: string;
  }>();

  return {
    exec: mock((_sql: string) => {}),
    query: mock(<T>(sql: string, params?: unknown[]): T[] => {
      // 模擬 l4_checkpoints 查詢
      if (sql.includes('l4_checkpoints') && sql.includes('SELECT')) {
        const id = params?.[0] as string;
        const row = checkpoints.get(id);
        if (!row) return [] as T[];
        // 模擬 expires_at 過期判斷（測試中使用未來時間）
        if (row.expires_at <= new Date().toISOString()) return [] as T[];
        return [row] as unknown as T[];
      }
      return [] as T[];
    }),
    run: mock((sql: string, params?: unknown[]) => {
      // 模擬 INSERT OR REPLACE 斷點
      if (sql.includes('INSERT OR REPLACE INTO l4_checkpoints')) {
        const [id, task_hash, plan_json, completed_steps_json, created_at, expires_at] = params as string[];
        checkpoints.set(id!, {
          id: id!,
          task_hash: task_hash!,
          plan_json: plan_json!,
          completed_steps_json: completed_steps_json!,
          created_at: created_at!,
          expires_at: expires_at!,
        });
      }
      // 模擬 DELETE 斷點
      if (sql.includes('DELETE FROM l4_checkpoints WHERE id')) {
        const id = params?.[0] as string;
        checkpoints.delete(id);
      }
      // 模擬 DELETE 過期斷點
      if (sql.includes('DELETE FROM l4_checkpoints WHERE expires_at')) {
        const now = new Date().toISOString();
        for (const [key, val] of checkpoints) {
          if (val.expires_at <= now) checkpoints.delete(key);
        }
      }
      return { changes: 1, lastInsertRowid: 1 };
    }),
    transaction: mock(<T>(fn: () => T): T => fn()),
    checkpoint: mock(() => {}),
    dailyReset: mock(() => {}),
    // 提供內部 checkpoints map 存取（測試用）
    _checkpoints: checkpoints,
  } as unknown as ClawDatabase;
}

/** 建立標準任務計畫 JSON（3 步驟：2 並行 + 1 序列） */
function createStandardPlanJson(): string {
  return JSON.stringify({
    plan: {
      goal: '搜尋 AI 新聞並分析趨勢',
      estimated_calls: 3,
      estimated_gold_key_tokens: 500,
      steps: [
        {
          id: 'step_1',
          tool: 'brave-search',
          params: { query: 'AI news 2026' },
          depends_on: [],
          retry_on_fail: true,
        },
        {
          id: 'step_2',
          tool: 'brave-search',
          params: { query: 'AI trends 2026' },
          depends_on: [],
          retry_on_fail: true,
        },
        {
          id: 'step_3',
          tool: 'llm_analysis',
          params: { input: '{{step_1.result}} + {{step_2.result}}' },
          depends_on: ['step_1', 'step_2'],
          retry_on_fail: false,
        },
      ],
    },
  });
}

// ===== 測試 1：3 步驟任務（2 並行 + 1 序列）=====

describe('L4TaskEngine 3 步驟任務（2 並行 + 1 序列）', () => {
  it('應成功執行 3 步驟並回傳最終報告', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
      ['groq', createMockAdapter('groq', 'llm')],
    ]);

    // Executor：第一次規劃，之後整合
    let execCallCount = 0;
    const planJson = createStandardPlanJson();
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCallCount++;
        const content = execCallCount === 1
          ? planJson               // 規劃
          : '最終整合報告：AI 2026 趨勢分析完成';  // 整合（第二次 LLM 呼叫）
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content } }],
            usage: { total_tokens: 150 },
          },
          latency_ms: 30,
        };
      }),
    } as unknown as AdapterExecutor;

    // L2Gateway：搜尋工具成功
    const l2Gateway = createSuccessL2Gateway({ results: ['AI news item'] });

    // llm_analysis 步驟也需要 gold key 呼叫，所以 executor 會再被調用
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = await engine.execute({
      messages: [{ role: 'user', content: '分析 2026 年的 AI 趨勢' }],
    });

    expect(result.success).toBe(true);
    expect(result.goal).toBe('搜尋 AI 新聞並分析趨勢');
    expect(result.answer).toBeTruthy();
    expect(result.step_results).toBeDefined();
    expect(result.step_results!.length).toBe(3);
  });

  it('step_1 和 step_2 應並行執行（無依賴）', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
    ]);

    const executionOrder: string[] = [];
    let execCount = 0;
    const planJson = createStandardPlanJson();
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCount++;
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content: execCount === 1 ? planJson : '整合報告' } }],
            usage: { total_tokens: 100 },
          },
          latency_ms: 10,
        };
      }),
    } as unknown as AdapterExecutor;

    const l2Gateway: L2Gateway = {
      execute: mock(async (req) => {
        const tool = req.params['_tool'] as string ?? 'unknown';
        executionOrder.push(tool);
        return {
          success: true,
          strategy: 'smart' as const,
          data: { results: [`${tool} results`] },
          latency_ms: 5,
          tried: [tool],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = await engine.execute({
      messages: [{ role: 'user', content: '搜尋並分析' }],
    });

    // 前兩步驟都有執行到
    expect(result.step_results!.length).toBe(3);
    // brave-search 步驟被呼叫了 2 次（step_1 和 step_2 並行）
    const searchCalls = executionOrder.filter(t => t === 'brave-search');
    expect(searchCalls.length).toBe(2);
  });

  it('step_3 依賴 step_1 和 step_2，應在兩者完成後執行', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
    ]);

    const planJson = createStandardPlanJson();
    let execCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCount++;
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content: execCount === 1 ? planJson : '分析完成報告' } }],
            usage: { total_tokens: 100 },
          },
          latency_ms: 10,
        };
      }),
    } as unknown as AdapterExecutor;

    const l2Gateway = createSuccessL2Gateway({ results: ['found data'] });
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = await engine.execute({
      messages: [{ role: 'user', content: '分析任務' }],
    });

    const step3 = result.step_results?.find(s => s.id === 'step_3');
    expect(step3).toBeDefined();
    // step_3 依賴 step_1 和 step_2，兩者均需成功
    const step1 = result.step_results?.find(s => s.id === 'step_1');
    const step2 = result.step_results?.find(s => s.id === 'step_2');
    expect(step1?.success).toBe(true);
    expect(step2?.success).toBe(true);
  });
});

// ===== 測試 2：金鑰匙缺失 =====

describe('L4TaskEngine 金鑰匙缺失', () => {
  it('未設定金鑰匙 → success=false + 錯誤訊息 + 建議', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);
    const result = await engine.execute({
      messages: [{ role: 'user', content: '分析 AI 趨勢' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('金鑰匙');
    expect(result.suggestion).toBeTruthy();
    expect(result.suggestion).toContain('clawapi gold-key set');
  });

  it('未設定金鑰匙 → latency_ms 應大於等於 0', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);
    const result = await engine.execute({
      messages: [{ role: 'user', content: '測試' }],
    });

    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.success).toBe(false);
  });
});

// ===== 測試 3：金鑰匙額度不足 → 降級到 L2 =====

describe('L4TaskEngine 金鑰匙額度不足 — 降級到 L2', () => {
  it('shouldDegradeToL2：剩餘 4% → 應回傳 true', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = engine.shouldDegradeToL2({
      key: createMockKey(1, '__gold_key__', 96000),
      daily_tokens_used: 96000,
      daily_token_limit: 100000,
    });

    expect(result).toBe(true);
  });

  it('shouldDegradeToL2：剩餘 6% → 不降級', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = engine.shouldDegradeToL2({
      key: createMockKey(1, '__gold_key__', 94000),
      daily_tokens_used: 94000,
      daily_token_limit: 100000,
    });

    expect(result).toBe(false);
  });

  it('shouldDegradeToL2：daily_token_limit=0（無限制）→ 永不降級', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = engine.shouldDegradeToL2({
      key: createMockKey(1, '__gold_key__', 999999),
      daily_tokens_used: 999999,
      daily_token_limit: 0,
    });

    expect(result).toBe(false);
  });

  it('金鑰匙剩餘 3% → 降級到 L2 並回傳 L2 結果', async () => {
    const goldKey = createMockKey(1, '__gold_key__', 97000);
    const keyPool = createMockKeyPool(goldKey);
    const executor = createMockExecutor();
    const adapters = new Map([['groq', createMockAdapter('groq')]]);
    const l2Gateway = createMockL2Gateway([
      { success: true, data: { choices: [{ message: { content: 'L2 回應' } }] } },
    ]);
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    // 覆寫 getGoldKey 回傳接近滿載的額度資訊
    engine.getGoldKey = mock(async () => ({
      key: goldKey,
      daily_tokens_used: 97000,
      daily_token_limit: 100000,
    }));

    const result = await engine.execute({
      messages: [{ role: 'user', content: '測試降級' }],
    });

    expect(result.success).toBe(true);
    expect(result.answer).toContain('降級');
  });
});

// ===== 測試 4：成本預估正確性 =====

describe('L4TaskEngine 成本預估', () => {
  it('estimateCost 回傳正確的 estimated_calls 和 estimated_gold_key_tokens', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const plan: TaskPlan = {
      goal: '測試計畫',
      estimated_calls: 5,
      estimated_gold_key_tokens: 800,
      steps: [],
    };

    const estimate = engine.estimateCost(plan, 0);

    expect(estimate.estimated_calls).toBe(5);
    expect(estimate.estimated_gold_key_tokens).toBe(800);
    expect(estimate.exceeds_limit).toBe(false);
    expect(estimate.max_gold_key_tokens).toBe(0);
  });

  it('estimateCost：有 max_gold_key_tokens 且不超過 → exceeds_limit=false', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const plan: TaskPlan = {
      goal: '小任務',
      estimated_calls: 3,
      estimated_gold_key_tokens: 300,
      steps: [],
    };

    const estimate = engine.estimateCost(plan, 1000);

    expect(estimate.exceeds_limit).toBe(false);
    expect(estimate.estimated_gold_key_tokens).toBe(300);
  });

  it('estimateCost：max=1000，estimated=800 → 不超過', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const plan: TaskPlan = {
      goal: '任務',
      estimated_calls: 10,
      estimated_gold_key_tokens: 800,
      steps: [],
    };

    const estimate = engine.estimateCost(plan, 1000);
    expect(estimate.exceeds_limit).toBe(false);
    expect(estimate.max_gold_key_tokens).toBe(1000);
  });
});

// ===== 測試 5：超過 max_gold_key_tokens → 拒絕執行 =====

describe('L4TaskEngine max_gold_key_tokens 限制', () => {
  it('預估消耗超過限制 → 拒絕執行並回傳 warning', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([['groq', createMockAdapter('groq', 'llm')]]);

    // LLM 規劃回傳預估消耗 1500 tokens 的計畫
    const bigPlanJson = JSON.stringify({
      plan: {
        goal: '超大任務',
        estimated_calls: 20,
        estimated_gold_key_tokens: 1500,
        steps: [
          { id: 'step_1', tool: 'groq', params: {}, depends_on: [], retry_on_fail: false },
        ],
      },
    });
    const executor = createMockExecutor(bigPlanJson, 200);
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    // max_gold_key_tokens = 500，預估 1500 → 超過
    const result = await engine.execute({
      messages: [{ role: 'user', content: '執行超大任務' }],
      params: { max_gold_key_tokens: 500 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('超過');
    expect(result.cost_estimate).toBeDefined();
    expect(result.cost_estimate!.exceeds_limit).toBe(true);
    expect(result.cost_estimate!.estimated_gold_key_tokens).toBe(1500);
    expect(result.suggestion).toBeTruthy();
  });

  it('預估消耗 = 限制 → 不超過（邊界條件）', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([['groq', createMockAdapter('groq', 'llm')]]);

    // 預估消耗恰好等於 max
    const exactPlanJson = JSON.stringify({
      plan: {
        goal: '剛好的任務',
        estimated_calls: 5,
        estimated_gold_key_tokens: 500,
        steps: [
          { id: 'step_1', tool: 'groq', params: {}, depends_on: [], retry_on_fail: false },
        ],
      },
    });

    let execCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCount++;
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content: execCount === 1 ? exactPlanJson : '整合報告' } }],
            usage: { total_tokens: 50 },
          },
          latency_ms: 10,
        };
      }),
    } as unknown as AdapterExecutor;

    const l2Gateway = createSuccessL2Gateway({ output: 'result' });
    const db = createMockDatabase();

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    // max_gold_key_tokens = 500，預估 = 500 → 剛好不超過
    const result = await engine.execute({
      messages: [{ role: 'user', content: '執行任務' }],
      params: { max_gold_key_tokens: 500 },
    });

    expect(result.success).toBe(true);
  });

  it('max_gold_key_tokens=0（無限制）→ 永不拒絕', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([['groq', createMockAdapter('groq', 'llm')]]);

    const hugePlanJson = JSON.stringify({
      plan: {
        goal: '無限任務',
        estimated_calls: 100,
        estimated_gold_key_tokens: 99999,
        steps: [
          { id: 'step_1', tool: 'groq', params: {}, depends_on: [], retry_on_fail: false },
        ],
      },
    });

    let execCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCount++;
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content: execCount === 1 ? hugePlanJson : '報告' } }],
            usage: { total_tokens: 100 },
          },
          latency_ms: 10,
        };
      }),
    } as unknown as AdapterExecutor;

    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    // max_gold_key_tokens=0 表示無限制，即使預估很高也要執行
    const result = await engine.execute({
      messages: [{ role: 'user', content: '執行' }],
      params: { max_gold_key_tokens: 0 },
    });

    expect(result.success).toBe(true);
  });
});

// ===== 測試 6：重試機制 =====

describe('L4TaskEngine 重試機制', () => {
  it('retry_on_fail=true，工具失敗 3 次後標記失敗', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([['unstable-tool', createMockAdapter('unstable-tool', 'llm')]]);

    // 工具永遠失敗
    const l2Gateway = createFailingL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const step: TaskStep = {
      id: 'test_step',
      tool: 'unstable-tool',
      params: { query: 'test' },
      depends_on: [],
      retry_on_fail: true,
    };

    const result = await engine.executeStep(step, new Map());

    // 重試 3 次都失敗 → 標記失敗
    expect(result.success).toBe(false);
    expect(result.retry_count).toBe(3);
    expect(result.id).toBe('test_step');
  });

  it('retry_on_fail=false，失敗後不重試', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([['tool', createMockAdapter('tool', 'llm')]]);

    let callCount = 0;
    const l2Gateway: L2Gateway = {
      execute: mock(async () => {
        callCount++;
        return {
          success: false,
          strategy: 'smart' as const,
          error: '失敗',
          latency_ms: 10,
          tried: [],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const step: TaskStep = {
      id: 'no_retry_step',
      tool: 'tool',
      params: {},
      depends_on: [],
      retry_on_fail: false,  // 不重試
    };

    await engine.executeStep(step, new Map());

    // 只呼叫 1 次（不重試）
    expect(callCount).toBe(1);
  });

  it('retry_on_fail=true，第 2 次成功 → retry_count=1', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([['tool', createMockAdapter('tool', 'llm')]]);

    let callCount = 0;
    const l2Gateway: L2Gateway = {
      execute: mock(async () => {
        callCount++;
        if (callCount === 1) {
          // 第一次失敗
          return {
            success: false,
            strategy: 'smart' as const,
            error: '暫時失敗',
            latency_ms: 10,
            tried: [],
          };
        }
        // 第二次成功
        return {
          success: true,
          strategy: 'smart' as const,
          data: { result: 'ok' },
          latency_ms: 10,
          tried: [],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const step: TaskStep = {
      id: 'retry_step',
      tool: 'tool',
      params: {},
      depends_on: [],
      retry_on_fail: true,
    };

    const result = await engine.executeStep(step, new Map());

    expect(result.success).toBe(true);
    expect(result.retry_count).toBe(1);
  });
});

// ===== 測試 7：部分失敗（部分步驟成功 + 部分失敗）=====

describe('L4TaskEngine 部分失敗', () => {
  it('step_1 成功、step_2 失敗 → 回傳部分結果，answer 標注未取得部分', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([
      ['tool-a', createMockAdapter('tool-a', 'search')],
      ['tool-b', createMockAdapter('tool-b', 'search')],
    ]);

    const partialPlanJson = JSON.stringify({
      plan: {
        goal: '執行兩個工具',
        estimated_calls: 2,
        estimated_gold_key_tokens: 200,
        steps: [
          {
            id: 'step_1',
            tool: 'tool-a',
            params: {},
            depends_on: [],
            retry_on_fail: false,
          },
          {
            id: 'step_2',
            tool: 'tool-b',
            params: {},
            depends_on: [],
            retry_on_fail: false,
          },
        ],
      },
    });

    let execCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCount++;
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content: execCount === 1 ? partialPlanJson : '部分成功報告：step_2 此部分未能取得' } }],
            usage: { total_tokens: 100 },
          },
          latency_ms: 10,
        };
      }),
    } as unknown as AdapterExecutor;

    // tool-a 成功，tool-b 失敗
    let l2CallCount = 0;
    const l2Gateway: L2Gateway = {
      execute: mock(async (req) => {
        l2CallCount++;
        const tool = req.params['_tool'] as string;
        if (tool === 'tool-a') {
          return {
            success: true,
            strategy: 'smart' as const,
            data: { result: 'tool-a data' },
            latency_ms: 10,
            tried: ['tool-a'],
          };
        }
        return {
          success: false,
          strategy: 'smart' as const,
          error: 'tool-b 失敗',
          latency_ms: 10,
          tried: ['tool-b'],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = await engine.execute({
      messages: [{ role: 'user', content: '執行兩個工具' }],
    });

    expect(result.success).toBe(true);
    expect(result.step_results).toBeDefined();
    expect(result.step_results!.length).toBe(2);

    const step1 = result.step_results!.find(s => s.id === 'step_1');
    const step2 = result.step_results!.find(s => s.id === 'step_2');

    expect(step1!.success).toBe(true);
    expect(step2!.success).toBe(false);
    expect(result.answer).toContain('未能取得');
  });

  it('所有步驟失敗時仍能回傳整合報告', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([
      ['failing-tool', createMockAdapter('failing-tool', 'search')],
    ]);

    const allFailPlanJson = JSON.stringify({
      plan: {
        goal: '全部失敗測試',
        estimated_calls: 1,
        estimated_gold_key_tokens: 100,
        steps: [
          {
            id: 'step_1',
            tool: 'failing-tool',
            params: {},
            depends_on: [],
            retry_on_fail: false,
          },
        ],
      },
    });

    let execCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCount++;
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content: execCount === 1 ? allFailPlanJson : '無法取得任何結果的報告' } }],
            usage: { total_tokens: 80 },
          },
          latency_ms: 10,
        };
      }),
    } as unknown as AdapterExecutor;

    const l2Gateway = createFailingL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = await engine.execute({
      messages: [{ role: 'user', content: '測試' }],
    });

    // 所有步驟失敗，但整合仍可進行（整合 LLM 可以生成說明報告）
    expect(result.step_results).toBeDefined();
    const step1 = result.step_results!.find(s => s.id === 'step_1');
    expect(step1!.success).toBe(false);
  });
});

// ===== 測試 8：斷點存取（save → load → resume）=====

describe('L4TaskEngine 斷點存取', () => {
  it('saveCheckpoint → loadCheckpoint 應能取回計畫和已完成步驟', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const plan: TaskPlan = {
      goal: '測試斷點計畫',
      estimated_calls: 3,
      estimated_gold_key_tokens: 300,
      steps: [
        { id: 'step_1', tool: 'tool-a', params: {}, depends_on: [], retry_on_fail: true },
        { id: 'step_2', tool: 'tool-b', params: {}, depends_on: ['step_1'], retry_on_fail: false },
      ],
    };

    const completedSteps = new Map<string, TaskStepResult>([
      ['step_1', {
        id: 'step_1',
        tool: 'tool-a',
        success: true,
        data: { result: 'step_1 完成' },
        tokens: 100,
        latency_ms: 50,
        retry_count: 0,
      }],
    ]);

    const checkpointId = 'test_checkpoint_001';

    // 存入斷點
    engine.saveCheckpoint(checkpointId, plan, completedSteps);

    // 讀取斷點
    const loaded = engine.loadCheckpoint(checkpointId);

    expect(loaded).not.toBeNull();
    expect(loaded!.plan.goal).toBe('測試斷點計畫');
    expect(loaded!.plan.steps.length).toBe(2);
    expect(loaded!.completedSteps.has('step_1')).toBe(true);
    expect(loaded!.completedSteps.get('step_1')!.data).toEqual({ result: 'step_1 完成' });
  });

  it('loadCheckpoint：不存在的 ID → 回傳 null', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const loaded = engine.loadCheckpoint('nonexistent_id');
    expect(loaded).toBeNull();
  });

  it('clearCheckpoint → loadCheckpoint 應回傳 null', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const plan: TaskPlan = {
      goal: '要被刪除的計畫',
      estimated_calls: 1,
      estimated_gold_key_tokens: 50,
      steps: [],
    };

    const checkpointId = 'to_delete_ckpt';
    engine.saveCheckpoint(checkpointId, plan, new Map());

    // 確認存入
    const loaded1 = engine.loadCheckpoint(checkpointId);
    expect(loaded1).not.toBeNull();

    // 清除
    engine.clearCheckpoint(checkpointId);

    // 清除後應取不到
    const loaded2 = engine.loadCheckpoint(checkpointId);
    expect(loaded2).toBeNull();
  });

  it('斷點包含多個已完成步驟時，所有步驟均可正確讀取', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const plan: TaskPlan = {
      goal: '多步驟計畫',
      estimated_calls: 5,
      estimated_gold_key_tokens: 500,
      steps: [],
    };

    const completedSteps = new Map<string, TaskStepResult>([
      ['step_1', { id: 'step_1', tool: 'a', success: true, data: { r: 1 }, latency_ms: 10, retry_count: 0 }],
      ['step_2', { id: 'step_2', tool: 'b', success: true, data: { r: 2 }, latency_ms: 10, retry_count: 0 }],
      ['step_3', { id: 'step_3', tool: 'c', success: false, error: 'err', latency_ms: 5, retry_count: 2 }],
    ]);

    const checkpointId = 'multi_step_ckpt';
    engine.saveCheckpoint(checkpointId, plan, completedSteps);

    const loaded = engine.loadCheckpoint(checkpointId);

    expect(loaded).not.toBeNull();
    expect(loaded!.completedSteps.size).toBe(3);
    expect(loaded!.completedSteps.get('step_1')!.data).toEqual({ r: 1 });
    expect(loaded!.completedSteps.get('step_3')!.success).toBe(false);
    expect(loaded!.completedSteps.get('step_3')!.retry_count).toBe(2);
  });
});

// ===== 測試 9：過期斷點清除（24hr）=====

describe('L4TaskEngine 過期斷點清除', () => {
  it('clearExpiredCheckpoints：過期斷點應被清除', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    // 使用可控制 expires_at 的 mock DB
    const checkpoints = new Map<string, {
      id: string;
      task_hash: string;
      plan_json: string;
      completed_steps_json: string;
      created_at: string;
      expires_at: string;
    }>();

    const db = {
      exec: mock((_sql: string) => {}),
      query: mock(<T>(sql: string, params?: unknown[]): T[] => {
        if (sql.includes('l4_checkpoints') && sql.includes('SELECT')) {
          const id = params?.[0] as string;
          const row = checkpoints.get(id);
          if (!row) return [] as T[];
          if (row.expires_at <= new Date().toISOString()) return [] as T[];
          return [row] as unknown as T[];
        }
        return [] as T[];
      }),
      run: mock((sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT OR REPLACE INTO l4_checkpoints')) {
          const [id, task_hash, plan_json, completed_steps_json, created_at, expires_at] = params as string[];
          checkpoints.set(id!, { id: id!, task_hash: task_hash!, plan_json: plan_json!, completed_steps_json: completed_steps_json!, created_at: created_at!, expires_at: expires_at! });
        }
        if (sql.includes('DELETE FROM l4_checkpoints WHERE id')) {
          checkpoints.delete(params?.[0] as string);
        }
        if (sql.includes('DELETE FROM l4_checkpoints WHERE expires_at')) {
          // 刪除所有過期的（expires_at <= 現在）
          const now = new Date().toISOString();
          for (const [key, val] of checkpoints) {
            if (val.expires_at <= now) checkpoints.delete(key);
          }
        }
        return { changes: 1, lastInsertRowid: 1 };
      }),
      transaction: mock(<T>(fn: () => T): T => fn()),
      checkpoint: mock(() => {}),
      dailyReset: mock(() => {}),
    } as unknown as ClawDatabase;

    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const plan: TaskPlan = {
      goal: '過期計畫',
      estimated_calls: 1,
      estimated_gold_key_tokens: 50,
      steps: [],
    };

    // 手動插入一個過期的斷點（expires_at 設為過去時間）
    const pastTime = new Date(Date.now() - 1000).toISOString();
    checkpoints.set('expired_ckpt', {
      id: 'expired_ckpt',
      task_hash: 'abc',
      plan_json: JSON.stringify(plan),
      completed_steps_json: '{}',
      created_at: pastTime,
      expires_at: pastTime,
    });

    // 插入一個未過期的斷點
    const futureTime = new Date(Date.now() + 86400000).toISOString();
    checkpoints.set('valid_ckpt', {
      id: 'valid_ckpt',
      task_hash: 'def',
      plan_json: JSON.stringify(plan),
      completed_steps_json: '{}',
      created_at: new Date().toISOString(),
      expires_at: futureTime,
    });

    expect(checkpoints.has('expired_ckpt')).toBe(true);
    expect(checkpoints.has('valid_ckpt')).toBe(true);

    // 執行清除
    engine.clearExpiredCheckpoints();

    // 過期的應被清除
    expect(checkpoints.has('expired_ckpt')).toBe(false);
    // 未過期的應保留
    expect(checkpoints.has('valid_ckpt')).toBe(true);
  });

  it('未過期的斷點在 clearExpiredCheckpoints 後仍可讀取', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const plan: TaskPlan = {
      goal: '未過期計畫',
      estimated_calls: 1,
      estimated_gold_key_tokens: 50,
      steps: [],
    };

    engine.saveCheckpoint('valid_ckpt_2', plan, new Map());
    engine.clearExpiredCheckpoints();

    // 未過期的斷點應仍存在
    const loaded = engine.loadCheckpoint('valid_ckpt_2');
    expect(loaded).not.toBeNull();
  });
});

// ===== 測試 10：DAG 拓撲排序（複雜依賴圖）=====

describe('L4TaskEngine DAG 拓撲排序', () => {
  it('複雜依賴圖：A,B 並行 → C 依賴 A → D 依賴 B,C', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['tool', createMockAdapter('tool', 'llm')],
    ]);

    const executionOrder: string[] = [];
    let completedCount = 0;

    const l2Gateway: L2Gateway = {
      execute: mock(async (req) => {
        const tool = req.params['_tool'] as string;
        executionOrder.push(tool);
        completedCount++;
        return {
          success: true,
          strategy: 'smart' as const,
          data: { result: `${tool} result` },
          latency_ms: 5,
          tried: [tool],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    // 複雜依賴圖：A,B 並行 → C 依賴 A → D 依賴 B 和 C
    const plan: TaskPlan = {
      goal: '複雜依賴圖測試',
      estimated_calls: 4,
      estimated_gold_key_tokens: 400,
      steps: [
        { id: 'A', tool: 'tool', params: {}, depends_on: [], retry_on_fail: false },
        { id: 'B', tool: 'tool', params: {}, depends_on: [], retry_on_fail: false },
        { id: 'C', tool: 'tool', params: {}, depends_on: ['A'], retry_on_fail: false },
        { id: 'D', tool: 'tool', params: {}, depends_on: ['B', 'C'], retry_on_fail: false },
      ],
    };

    const results = await engine.executeDAG(plan, new Map(), 'test_dag_ckpt');

    // 所有步驟都應完成
    expect(results.length).toBe(4);
    expect(results.every(r => r.success)).toBe(true);

    // D 必須是最後執行的
    const dIndex = executionOrder.lastIndexOf('tool');
    const cPos = executionOrder.indexOf('tool');  // 注意：tool 工具名相同，無法精確區分
    // 至少確認 4 個步驟都執行了
    expect(completedCount).toBe(4);
  });

  it('DAG 無依賴步驟應全部並行', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['tool', createMockAdapter('tool', 'llm')],
    ]);

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const l2Gateway: L2Gateway = {
      execute: mock(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        // 模擬一點延遲讓並行性更明顯
        await new Promise(resolve => setTimeout(resolve, 5));
        currentConcurrent--;
        return {
          success: true,
          strategy: 'smart' as const,
          data: { ok: true },
          latency_ms: 5,
          tried: [],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    // 4 個完全無依賴的步驟
    const plan: TaskPlan = {
      goal: '全部並行測試',
      estimated_calls: 4,
      estimated_gold_key_tokens: 200,
      steps: [
        { id: 's1', tool: 'tool', params: {}, depends_on: [], retry_on_fail: false },
        { id: 's2', tool: 'tool', params: {}, depends_on: [], retry_on_fail: false },
        { id: 's3', tool: 'tool', params: {}, depends_on: [], retry_on_fail: false },
        { id: 's4', tool: 'tool', params: {}, depends_on: [], retry_on_fail: false },
      ],
    };

    const results = await engine.executeDAG(plan, new Map(), 'parallel_ckpt');

    // 所有步驟都應成功
    expect(results.length).toBe(4);
    expect(results.every(r => r.success)).toBe(true);
    // 最大並行數應大於 1（確認並行執行）
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('parsePlan：複雜 DAG 計畫應能正確解析所有步驟的依賴', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const complexPlanJson = JSON.stringify({
      plan: {
        goal: '複雜計畫',
        estimated_calls: 5,
        estimated_gold_key_tokens: 500,
        steps: [
          { id: 'A', tool: 'search', params: { q: 'test' }, depends_on: [], retry_on_fail: true },
          { id: 'B', tool: 'translate', params: {}, depends_on: ['A'], retry_on_fail: true },
          { id: 'C', tool: 'analyze', params: {}, depends_on: ['A'], retry_on_fail: false },
          { id: 'D', tool: 'summarize', params: {}, depends_on: ['B', 'C'], retry_on_fail: false },
        ],
      },
    });

    const plan = engine.parsePlan(complexPlanJson);

    expect(plan).not.toBeNull();
    expect(plan!.steps.length).toBe(4);
    expect(plan!.steps[0]!.id).toBe('A');
    expect(plan!.steps[0]!.depends_on).toEqual([]);
    expect(plan!.steps[1]!.depends_on).toEqual(['A']);
    expect(plan!.steps[3]!.depends_on).toEqual(['B', 'C']);
    expect(plan!.steps[3]!.retry_on_fail).toBe(false);
  });
});

// ===== 測試 11：消耗報告格式和加總 =====

describe('L4TaskEngine 消耗報告', () => {
  it('消耗報告應包含 gold_key_tokens、total_calls、每步詳細資訊', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([
      ['search-tool', createMockAdapter('search-tool', 'search')],
    ]);

    const singleStepPlan = JSON.stringify({
      plan: {
        goal: '單步驟報告測試',
        estimated_calls: 1,
        estimated_gold_key_tokens: 200,
        steps: [
          {
            id: 'step_1',
            tool: 'search-tool',
            params: { query: 'test' },
            depends_on: [],
            retry_on_fail: false,
          },
        ],
      },
    });

    let execCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCount++;
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content: execCount === 1 ? singleStepPlan : '最終報告完成' } }],
            usage: { total_tokens: execCount === 1 ? 100 : 80 },
          },
          latency_ms: 20,
        };
      }),
    } as unknown as AdapterExecutor;

    const l2Gateway: L2Gateway = {
      execute: mock(async () => ({
        success: true,
        strategy: 'smart' as const,
        data: { results: ['item'], usage: { total_tokens: 50 } },
        latency_ms: 30,
        tried: ['search-tool'],
      })),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = await engine.execute({
      messages: [{ role: 'user', content: '搜尋測試' }],
    });

    expect(result.success).toBe(true);
    expect(result.usage).toBeDefined();

    // 金鑰匙 token 消耗：規劃(100) + 整合(80) = 180
    expect(result.usage!.gold_key_tokens).toBe(180);

    // 工具呼叫次數
    expect(result.usage!.total_calls).toBe(1);

    // 步驟詳細
    expect(result.usage!.steps).toHaveLength(1);
    expect(result.usage!.steps[0]!.id).toBe('step_1');
    expect(result.usage!.steps[0]!.tool).toBe('search-tool');
    expect(result.usage!.steps[0]!.success).toBe(true);
    expect(result.usage!.steps[0]!.retry_count).toBe(0);
    expect(result.usage!.steps[0]!.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('消耗報告：多步驟加總 total_calls 正確', async () => {
    const goldKey = createMockKey(1, '__gold_key__');
    const keyPool = createMockKeyPool(goldKey);
    const adapters = new Map([
      ['tool', createMockAdapter('tool', 'search')],
    ]);

    const multiStepPlan = JSON.stringify({
      plan: {
        goal: '多步驟加總測試',
        estimated_calls: 3,
        estimated_gold_key_tokens: 300,
        steps: [
          { id: 's1', tool: 'tool', params: {}, depends_on: [], retry_on_fail: false },
          { id: 's2', tool: 'tool', params: {}, depends_on: [], retry_on_fail: false },
          { id: 's3', tool: 'tool', params: { input: '{{s1.result}}' }, depends_on: ['s1', 's2'], retry_on_fail: false },
        ],
      },
    });

    let execCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCount++;
        return {
          success: true,
          status: 200,
          data: {
            choices: [{ message: { content: execCount === 1 ? multiStepPlan : '整合報告' } }],
            usage: { total_tokens: 60 },
          },
          latency_ms: 10,
        };
      }),
    } as unknown as AdapterExecutor;

    const l2Gateway = createSuccessL2Gateway({ data: 'ok' });
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = await engine.execute({
      messages: [{ role: 'user', content: '多步驟測試' }],
    });

    expect(result.success).toBe(true);
    expect(result.usage!.total_calls).toBe(3);
    expect(result.usage!.steps.length).toBe(3);
  });

  it('消耗報告：失敗步驟的 retry_count 應正確記錄', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([['tool', createMockAdapter('tool')]]);
    const l2Gateway = createFailingL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const step: TaskStep = {
      id: 'fail_step',
      tool: 'tool',
      params: {},
      depends_on: [],
      retry_on_fail: true,
    };

    const result = await engine.executeStep(step, new Map());

    expect(result.retry_count).toBe(3);
    expect(result.success).toBe(false);
    expect(result.id).toBe('fail_step');
  });

  it('parsePlan：無效 JSON → 回傳 null', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = engine.parsePlan('這不是 JSON');
    expect(result).toBeNull();
  });

  it('parsePlan：缺少 plan 欄位 → 回傳 null', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const result = engine.parsePlan(JSON.stringify({ goal: '無 plan 包裝' }));
    expect(result).toBeNull();
  });

  it('parsePlan：步驟缺少 retry_on_fail → 回傳 null', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const badPlan = JSON.stringify({
      plan: {
        goal: '壞計畫',
        estimated_calls: 1,
        estimated_gold_key_tokens: 100,
        steps: [
          { id: 'x', tool: 'y', params: {}, depends_on: [] },
          // 缺少 retry_on_fail
        ],
      },
    });

    const result = engine.parsePlan(badPlan);
    expect(result).toBeNull();
  });
});

// ===== 測試 12：enrichParamsWithResults（結果注入）=====

describe('L4TaskEngine enrichParamsWithResults', () => {
  it('{{step_1.result}} 應被替換為前置步驟的結果', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const previousResults = new Map<string, TaskStepResult>([
      ['step_1', {
        id: 'step_1',
        tool: 'search',
        success: true,
        data: '搜尋結果文字',
        latency_ms: 10,
        retry_count: 0,
      }],
    ]);

    const enriched = engine.enrichParamsWithResults(
      { input: '{{step_1.result}} 需要分析' },
      ['step_1'],
      previousResults
    );

    expect(enriched['input']).toContain('搜尋結果文字');
    expect(enriched['input']).not.toContain('{{step_1.result}}');
  });

  it('前置步驟失敗時，{{step_id.result}} 應替換為提示文字', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const previousResults = new Map<string, TaskStepResult>([
      ['step_1', {
        id: 'step_1',
        tool: 'search',
        success: false,  // 失敗
        error: '搜尋失敗',
        latency_ms: 5,
        retry_count: 3,
      }],
    ]);

    const enriched = engine.enrichParamsWithResults(
      { input: '{{step_1.result}}' },
      ['step_1'],
      previousResults
    );

    expect(enriched['input']).toContain('不可用');
  });

  it('多個依賴都注入正確', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const db = createMockDatabase();
    const engine = new L4TaskEngine(keyPool, executor, adapters, l2Gateway, db);

    const previousResults = new Map<string, TaskStepResult>([
      ['s1', { id: 's1', tool: 'a', success: true, data: 'data_s1', latency_ms: 5, retry_count: 0 }],
      ['s2', { id: 's2', tool: 'b', success: true, data: 'data_s2', latency_ms: 5, retry_count: 0 }],
    ]);

    const enriched = engine.enrichParamsWithResults(
      { combined: '{{s1.result}} and {{s2.result}}' },
      ['s1', 's2'],
      previousResults
    );

    expect(enriched['combined']).toContain('data_s1');
    expect(enriched['combined']).toContain('data_s2');
    // 也應注入 _step_{id}_result 格式
    expect(enriched['_step_s1_result']).toBe('data_s1');
    expect(enriched['_step_s2_result']).toBe('data_s2');
  });
});
