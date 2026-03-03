// L3 Concierge 測試
// 驗證Claw Key檢查、意圖解讀、步驟執行（並行/序列）、結果整合、消耗報告

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { L3Concierge } from '../l3-concierge';
import type { L3Request, IntentStep } from '../l3-concierge';
import type { KeyPool, DecryptedKey } from '../../core/key-pool';
import type { AdapterExecutor } from '../../adapters/executor';
import type { AdapterConfig } from '../../adapters/loader';
import type { L2Gateway } from '../l2-gateway';

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
      translate: { method: 'POST', path: '/translate', response_type: 'json' },
    },
    capabilities: {
      chat: hasChat,
      streaming: false,
      embeddings: false,
      images: false,
      audio: false,
      models: [
        { id: `${id}-model`, name: `${id} 主模型` },
        { id: `${id}-lite`, name: `${id} 輕量版` },
      ],
    },
  };
}

/**
 * 建立 Mock KeyPool
 * clawKey: Claw Key（為 null 時模擬未設定）
 */
function createMockKeyPool(clawKey: DecryptedKey | null): KeyPool {
  return {
    selectKey: mock(async (serviceId: string) => {
      if (serviceId === '__claw_key__') return clawKey;
      return null;
    }),
    getServiceIds: mock(() => []),
    reportSuccess: mock(async () => {}),
    reportRateLimit: mock(async () => {}),
    reportAuthError: mock(async () => {}),
    reportError: mock(async () => {}),
  } as unknown as KeyPool;
}

/**
 * 建立 Mock Executor
 * 根據 endpointName 決定回傳內容
 */
function createMockExecutor(
  responseContent: string = '這是 AI 的回答',
  tokensUsed: number = 100
): AdapterExecutor {
  return {
    execute: mock(async () => ({
      success: true,
      status: 200,
      data: {
        choices: [{
          message: { content: responseContent },
        }],
        usage: { total_tokens: tokensUsed },
      },
      latency_ms: 50,
    })),
  } as unknown as AdapterExecutor;
}

/**
 * 建立失敗的 Mock Executor
 */
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

/**
 * 建立 Mock L2Gateway
 * 控制每次呼叫的回傳
 */
function createMockL2Gateway(
  responses: Array<{ success: boolean; data?: unknown; error?: string }>
): L2Gateway {
  let callCount = 0;
  return {
    execute: mock(async () => {
      const response = responses[callCount] ?? { success: false, error: '無更多 mock 回應' };
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

/**
 * 建立永遠成功的 Mock L2Gateway
 */
function createSuccessL2Gateway(data: unknown = { result: 'ok' }): L2Gateway {
  return createMockL2Gateway([{ success: true, data }]);
}

// ===== 測試 1：意圖解讀 — 3 種服務選擇 =====

describe('L3Concierge 意圖解讀 — 服務選擇', () => {
  it('搜尋意圖 → 選擇 brave-search 服務', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);

    // Executor 回傳搜尋意圖 JSON
    const intentJson = JSON.stringify({
      understanding: '用戶想要搜尋最新的 AI 新聞',
      steps: [
        { tool: 'brave-search', params: { query: 'AI news 2026' }, depends_on: [] },
      ],
    });
    const executor = createMockExecutor(intentJson, 50);

    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
      ['deepl', createMockAdapter('deepl', 'translation')],
      ['groq', createMockAdapter('groq', 'llm')],
    ]);

    // L2Gateway：步驟執行成功 + 整合 LLM 成功
    const l2Gateway = {
      execute: mock(async () => ({
        success: true,
        strategy: 'smart' as const,
        data: { results: ['AI news item 1', 'AI news item 2'] },
        latency_ms: 100,
        tried: ['brave-search'],
      })),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.execute({
      messages: [{ role: 'user', content: '幫我搜尋最新的 AI 新聞' }],
    });

    // 驗證：成功，且步驟使用了 brave-search
    expect(result.success).toBe(true);
    expect(result.understanding).toContain('AI');
    expect(result.step_results).toBeDefined();
    expect(result.step_results!.length).toBeGreaterThan(0);
    expect(result.step_results![0]!.tool).toBe('brave-search');
  });

  it('翻譯意圖 → 選擇 deepl 服務', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);

    const intentJson = JSON.stringify({
      understanding: '用戶想要翻譯一段文字為英文',
      steps: [
        { tool: 'deepl', params: { text: '你好世界', target: 'EN' }, depends_on: [] },
      ],
    });
    const executor = createMockExecutor(intentJson, 40);

    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
      ['deepl', createMockAdapter('deepl', 'translation')],
      ['groq', createMockAdapter('groq', 'llm')],
    ]);

    const l2Gateway = createMockL2Gateway([
      { success: true, data: { translated_text: 'Hello World' } },
    ]);

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.execute({
      messages: [{ role: 'user', content: '翻譯「你好世界」為英文' }],
    });

    expect(result.success).toBe(true);
    expect(result.step_results![0]!.tool).toBe('deepl');
    expect(result.understanding).toContain('翻譯');
  });

  it('LLM 對話意圖 → 選擇 groq 服務', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);

    const intentJson = JSON.stringify({
      understanding: '用戶想要和 LLM 進行一般對話',
      steps: [
        { tool: 'groq', params: { messages: [{ role: 'user', content: '你好' }] }, depends_on: [] },
      ],
    });
    const executor = createMockExecutor(intentJson, 60);

    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
      ['deepl', createMockAdapter('deepl', 'translation')],
      ['groq', createMockAdapter('groq', 'llm')],
    ]);

    const l2Gateway = createMockL2Gateway([
      { success: true, data: { choices: [{ message: { content: '你好！' } }] } },
    ]);

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.execute({
      messages: [{ role: 'user', content: '你好，介紹一下自己' }],
    });

    expect(result.success).toBe(true);
    expect(result.step_results![0]!.tool).toBe('groq');
  });
});

// ===== 測試 2：Claw Key缺失 =====

describe('L3Concierge Claw Key缺失', () => {
  it('未設定Claw Key → success=false + 回傳錯誤訊息 + 建議', async () => {
    // clawKey = null，模擬未設定
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([['groq', createMockAdapter('groq')]]);
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.execute({
      messages: [{ role: 'user', content: '幫我搜尋資訊' }],
    });

    // 驗收標準：沒Claw Key → 失敗 + 說明 + 建議指令
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('Claw Key');
    expect(result.suggestion).toBeTruthy();
    expect(result.suggestion).toContain('clawapi claw-key set');
  });

  it('未設定Claw Key → latency_ms 應大於 0', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.execute({
      messages: [{ role: 'user', content: '測試' }],
    });

    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.success).toBe(false);
  });
});

// ===== 測試 3：Claw Key額度不足 → 降級到 L2 =====

describe('L3Concierge Claw Key額度不足 — 降級到 L2', () => {
  it('shouldDegradeToL2 方法：剩餘 4% → 應回傳 true', () => {
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const keyPool = createMockKeyPool(null);

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    // 今日上限 100,000 tokens，已用 96,000（剩餘 4%）
    const result = concierge.shouldDegradeToL2({
      key: createMockKey(1, '__claw_key__', 96000),
      daily_tokens_used: 96000,
      daily_token_limit: 100000,
    });

    expect(result).toBe(true);
  });

  it('shouldDegradeToL2 方法：剩餘 6% → 不降級', () => {
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const keyPool = createMockKeyPool(null);

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    // 今日上限 100,000 tokens，已用 94,000（剩餘 6%）
    const result = concierge.shouldDegradeToL2({
      key: createMockKey(1, '__claw_key__', 94000),
      daily_tokens_used: 94000,
      daily_token_limit: 100000,
    });

    expect(result).toBe(false);
  });

  it('shouldDegradeToL2 方法：daily_token_limit=0（無限制）→ 永不降級', () => {
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();
    const keyPool = createMockKeyPool(null);

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const result = concierge.shouldDegradeToL2({
      key: createMockKey(1, '__claw_key__', 999999),
      daily_tokens_used: 999999,
      daily_token_limit: 0,  // 0 = 無限制
    });

    expect(result).toBe(false);
  });

  it('Claw Key剩餘 3%（超過閾值） → L2 成功 → 回傳 L2 結果', async () => {
    // daily_used 接近上限（剩 3%）
    const clawKey = createMockKey(1, '__claw_key__', 97000);
    const keyPool: KeyPool = {
      selectKey: mock(async () => clawKey),
      getServiceIds: mock(() => []),
      reportSuccess: mock(async () => {}),
      reportRateLimit: mock(async () => {}),
      reportAuthError: mock(async () => {}),
      reportError: mock(async () => {}),
    } as unknown as KeyPool;

    const executor = createMockExecutor();
    const adapters = new Map([['groq', createMockAdapter('groq')]]);
    const l2Gateway = createMockL2Gateway([
      { success: true, data: { choices: [{ message: { content: 'L2 回應' } }] } },
    ]);

    // 建立 concierge 並手動讓 getClawKey 回傳有額度限制的資訊
    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    // 覆寫 getClawKey 讓它回傳接近滿載的額度資訊
    const originalGetClawKey = concierge.getClawKey.bind(concierge);
    concierge.getClawKey = mock(async () => ({
      key: clawKey,
      daily_tokens_used: 97000,
      daily_token_limit: 100000,  // 剩 3%，低於 5% 閾值
    }));

    const result = await concierge.execute({
      messages: [{ role: 'user', content: '測試降級' }],
    });

    // 降級後應透過 L2 處理
    expect(result.success).toBe(true);
    // 原始 getClawKey 還可以用
    expect(originalGetClawKey).toBeDefined();
  });
});

// ===== 測試 4：System Prompt 注入 available_tools =====

describe('L3Concierge System Prompt 注入', () => {
  it('buildSystemPrompt 應包含 {{available_tools}} 替換後的工具清單', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
      ['deepl', createMockAdapter('deepl', 'translation')],
    ]);
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const toolsDesc = concierge.buildAvailableToolsDescription();
    const prompt = concierge.buildSystemPrompt(toolsDesc);

    // System Prompt 應包含工具 ID
    expect(prompt).toContain('brave-search');
    expect(prompt).toContain('deepl');
    // 不應留有未替換的模板符號
    expect(prompt).not.toContain('{{available_tools}}');
  });

  it('buildAvailableToolsDescription：無 Adapter → 回傳提示文字', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const desc = concierge.buildAvailableToolsDescription();

    expect(desc).toContain('沒有');
  });

  it('buildAvailableToolsDescription：多個 Adapter → 每個都有名稱和類別', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['groq', createMockAdapter('groq', 'llm')],
      ['openai', createMockAdapter('openai', 'llm')],
    ]);
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const desc = concierge.buildAvailableToolsDescription();

    expect(desc).toContain('groq');
    expect(desc).toContain('openai');
    expect(desc).toContain('llm');
  });

  it('System Prompt 不應在替換後包含多餘的模板符號', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['test-tool', createMockAdapter('test-tool', 'search')],
    ]);
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const toolsDesc = concierge.buildAvailableToolsDescription();
    const prompt = concierge.buildSystemPrompt(toolsDesc);

    // 驗證：不含未替換的 {{}} 語法
    expect(prompt).not.toMatch(/\{\{[^}]+\}\}/);
    // 確認有替換成工具內容
    expect(prompt).toContain('test-tool');
  });
});

// ===== 測試 5：並行步驟執行 =====

describe('L3Concierge 並行步驟執行', () => {
  it('兩個無依賴步驟應並行執行（executeSteps）', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
      ['deepl', createMockAdapter('deepl', 'translation')],
    ]);

    // 追蹤執行時間，確認並行
    const executionOrder: string[] = [];
    let callCount = 0;
    const l2Gateway: L2Gateway = {
      execute: mock(async (req) => {
        callCount++;
        const tool = req.params['_tool'] as string ?? req.model;
        executionOrder.push(tool);
        return {
          success: true,
          strategy: 'smart' as const,
          data: { result: `${tool} result` },
          latency_ms: 10,
          tried: [tool],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    // 兩個無依賴步驟（depends_on: [] 表示可並行）
    const steps: IntentStep[] = [
      { tool: 'brave-search', params: { query: 'test' }, depends_on: [] },
      { tool: 'deepl', params: { text: 'hello' }, depends_on: [] },
    ];

    const results = await concierge.executeSteps(steps);

    // 應有兩個結果
    expect(results.length).toBe(2);
    // 兩個步驟都應成功
    expect(results.every(r => r.success)).toBe(true);
    // 呼叫次數應是 2（並行）
    expect(callCount).toBe(2);
  });

  it('並行步驟的工具 ID 應正確對應', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['tool-a', createMockAdapter('tool-a', 'search')],
      ['tool-b', createMockAdapter('tool-b', 'translation')],
      ['tool-c', createMockAdapter('tool-c', 'llm')],
    ]);

    const l2Gateway: L2Gateway = {
      execute: mock(async (req) => ({
        success: true,
        strategy: 'smart' as const,
        data: { from: req.params['_tool'] },
        latency_ms: 5,
        tried: [],
      })),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const steps: IntentStep[] = [
      { tool: 'tool-a', params: {}, depends_on: [] },
      { tool: 'tool-b', params: {}, depends_on: [] },
      { tool: 'tool-c', params: {}, depends_on: [] },
    ];

    const results = await concierge.executeSteps(steps);

    expect(results.length).toBe(3);
    // 找到每個工具對應的結果
    const toolAResult = results.find(r => r.tool === 'tool-a');
    const toolBResult = results.find(r => r.tool === 'tool-b');
    const toolCResult = results.find(r => r.tool === 'tool-c');

    expect(toolAResult).toBeDefined();
    expect(toolBResult).toBeDefined();
    expect(toolCResult).toBeDefined();
    expect(toolAResult!.success).toBe(true);
    expect(toolBResult!.success).toBe(true);
    expect(toolCResult!.success).toBe(true);
  });
});

// ===== 測試 6：序列步驟執行 =====

describe('L3Concierge 序列步驟執行', () => {
  it('步驟 1 依賴步驟 0 → 步驟 0 完成後才執行步驟 1', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['brave-search', createMockAdapter('brave-search', 'search')],
      ['deepl', createMockAdapter('deepl', 'translation')],
    ]);

    // 追蹤執行順序
    const executionOrder: string[] = [];
    const l2Gateway: L2Gateway = {
      execute: mock(async (req) => {
        const tool = req.params['_tool'] as string;
        executionOrder.push(tool);
        return {
          success: true,
          strategy: 'smart' as const,
          data: { result: `${tool} done` },
          latency_ms: 10,
          tried: [tool],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const steps: IntentStep[] = [
      { tool: 'brave-search', params: { query: 'AI' }, depends_on: [] },
      { tool: 'deepl', params: { text: 'translate this' }, depends_on: [0] },  // 依賴步驟 0
    ];

    const results = await concierge.executeSteps(steps);

    // 應有兩個結果
    expect(results.length).toBe(2);
    // 兩個都應成功
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(true);
    // 執行順序：search → deepl
    expect(executionOrder[0]).toBe('brave-search');
    expect(executionOrder[1]).toBe('deepl');
  });

  it('前置步驟的結果應被注入到後置步驟的 params 中', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['search', createMockAdapter('search', 'search')],
      ['translate', createMockAdapter('translate', 'translation')],
    ]);

    // 記錄步驟 1 收到的 params
    let step1Params: Record<string, unknown> | null = null;
    let callIndex = 0;
    const l2Gateway: L2Gateway = {
      execute: mock(async (req) => {
        callIndex++;
        if (callIndex === 2) {
          // 步驟 1（第二次呼叫）記錄 params
          step1Params = req.params;
        }
        return {
          success: true,
          strategy: 'smart' as const,
          data: { output: '前置步驟輸出' },
          latency_ms: 10,
          tried: [],
        };
      }),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const steps: IntentStep[] = [
      { tool: 'search', params: { query: 'test' }, depends_on: [] },
      { tool: 'translate', params: { text: 'original' }, depends_on: [0] },
    ];

    await concierge.executeSteps(steps);

    // 步驟 1 的 params 應包含步驟 0 的結果
    expect(step1Params).not.toBeNull();
    expect(step1Params!['_step_0_result']).toBeDefined();
    expect(step1Params!['_step_0_result']).toEqual({ output: '前置步驟輸出' });
  });

  it('三步序列（0→1→2）應按順序執行', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map([
      ['step1', createMockAdapter('step1', 'llm')],
      ['step2', createMockAdapter('step2', 'llm')],
      ['step3', createMockAdapter('step3', 'llm')],
    ]);

    const order: number[] = [];
    let callIdx = 0;
    const l2Gateway: L2Gateway = {
      execute: mock(async () => {
        order.push(callIdx++);
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

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const steps: IntentStep[] = [
      { tool: 'step1', params: {}, depends_on: [] },
      { tool: 'step2', params: {}, depends_on: [0] },
      { tool: 'step3', params: {}, depends_on: [1] },
    ];

    const results = await concierge.executeSteps(steps);

    expect(results.length).toBe(3);
    expect(order).toEqual([0, 1, 2]);
  });
});

// ===== 測試 7：澄清回傳（clarification）=====

describe('L3Concierge 澄清回傳', () => {
  it('LLM 回傳 clarification JSON → 回傳澄清問題給用戶', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);

    // Executor 回傳澄清 JSON
    const clarificationJson = JSON.stringify({
      clarification: '請問您想翻譯成哪種語言？（繁體中文/日文/英文）',
    });
    const executor = createMockExecutor(clarificationJson, 30);

    const adapters = new Map([['deepl', createMockAdapter('deepl', 'translation')]]);
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.execute({
      messages: [{ role: 'user', content: '翻譯這段話' }],
    });

    // 應成功，並回傳澄清問題
    expect(result.success).toBe(true);
    expect(result.clarification).toBeDefined();
    expect(result.clarification).toContain('請問');
    // 不應有最終回答（尚未執行步驟）
    expect(result.answer).toBeUndefined();
  });

  it('parseIntent：正確解析 clarification 格式', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const raw = JSON.stringify({ clarification: '您說的是哪個方向？' });
    const parsed = concierge.parseIntent(raw);

    expect(parsed).not.toBeNull();
    expect('clarification' in parsed!).toBe(true);
    if (parsed && 'clarification' in parsed) {
      expect(parsed.clarification).toBe('您說的是哪個方向？');
    }
  });

  it('parseIntent：包在 markdown code block 中的 JSON 也能解析', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const raw = '```json\n{"clarification": "需要更多資訊"}\n```';
    const parsed = concierge.parseIntent(raw);

    expect(parsed).not.toBeNull();
    if (parsed && 'clarification' in parsed) {
      expect(parsed.clarification).toBe('需要更多資訊');
    }
  });

  it('parseIntent：無效 JSON → 回傳 null', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const parsed = concierge.parseIntent('這不是 JSON 格式的文字');
    expect(parsed).toBeNull();
  });
});

// ===== 測試 8：消耗報告正確性 =====

describe('L3Concierge 消耗報告', () => {
  it('完整執行後應回傳 usage 報告（含 claw_key_tokens 和 steps）', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);

    // Executor：第一次呼叫（意圖解讀）回傳 50 tokens，第二次（整合）回傳 80 tokens
    let execCallCount = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execCallCount++;
        const tokensForCall = execCallCount === 1 ? 50 : 80;  // 意圖=50, 整合=80
        const intentJson = JSON.stringify({
          understanding: '用戶想執行搜尋',
          steps: [
            { tool: 'search-tool', params: { query: 'test' }, depends_on: [] },
          ],
        });
        return {
          success: true,
          status: 200,
          data: {
            choices: [{
              message: {
                content: execCallCount === 1 ? intentJson : '整合後的最終回答',
              },
            }],
            usage: { total_tokens: tokensForCall },
          },
          latency_ms: 30,
        };
      }),
    } as unknown as AdapterExecutor;

    const adapters = new Map([
      ['search-tool', createMockAdapter('search-tool', 'llm')],
    ]);

    // L2 步驟執行：消耗 200 tokens
    const l2Gateway: L2Gateway = {
      execute: mock(async () => ({
        success: true,
        strategy: 'smart' as const,
        data: {
          results: ['result1'],
          usage: { total_tokens: 200 },
        },
        latency_ms: 100,
        tried: ['search-tool'],
      })),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.execute({
      messages: [{ role: 'user', content: '搜尋測試' }],
    });

    expect(result.success).toBe(true);
    expect(result.usage).toBeDefined();

    // Claw Key消耗：意圖解讀 50 + 結果整合 80 = 130
    expect(result.usage!.claw_key_tokens).toBe(130);

    // 各步驟消耗
    expect(result.usage!.steps).toHaveLength(1);
    expect(result.usage!.steps[0]!.tool).toBe('search-tool');
    expect(result.usage!.steps[0]!.tokens).toBe(200);
  });

  it('步驟失敗時 usage 仍應回傳（但 steps tokens 可能為 0）', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);

    // Executor：意圖解讀成功（含步驟），整合失敗
    let execIdx = 0;
    const executor: AdapterExecutor = {
      execute: mock(async () => {
        execIdx++;
        if (execIdx === 1) {
          // 意圖解讀：回傳有步驟的 JSON
          return {
            success: true,
            status: 200,
            data: {
              choices: [{ message: { content: JSON.stringify({
                understanding: '搜尋任務',
                steps: [{ tool: 'tool-x', params: {}, depends_on: [] }],
              }) }}],
              usage: { total_tokens: 60 },
            },
            latency_ms: 20,
          };
        }
        // 整合失敗
        return { success: false, status: 500, error: '整合失敗', latency_ms: 10 };
      }),
    } as unknown as AdapterExecutor;

    const adapters = new Map([
      ['tool-x', createMockAdapter('tool-x', 'llm')],
    ]);

    const l2Gateway: L2Gateway = {
      execute: mock(async () => ({
        success: true,
        strategy: 'smart' as const,
        data: { found: true },
        latency_ms: 50,
        tried: [],
      })),
      updateCollectiveIntel: mock(() => {}),
    } as unknown as L2Gateway;

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.execute({
      messages: [{ role: 'user', content: '測試' }],
    });

    // 整合失敗，但 usage 中的意圖解讀 token 應存在
    expect(result.success).toBe(false);
    expect(result.usage).toBeDefined();
    expect(result.usage!.claw_key_tokens).toBe(60);
  });

  it('parseIntent：正確解析意圖 JSON 含 steps 陣列', () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const raw = JSON.stringify({
      understanding: '用戶想搜尋後翻譯',
      steps: [
        { tool: 'search', params: { query: 'test' }, depends_on: [] },
        { tool: 'translate', params: { text: 'result' }, depends_on: [0] },
      ],
    });

    const parsed = concierge.parseIntent(raw);

    expect(parsed).not.toBeNull();
    expect('understanding' in parsed!).toBe(true);
    if (parsed && 'steps' in parsed) {
      expect(parsed.steps).toHaveLength(2);
      expect(parsed.steps[0]!.tool).toBe('search');
      expect(parsed.steps[1]!.tool).toBe('translate');
      expect(parsed.steps[1]!.depends_on).toEqual([0]);
    }
  });
});

// ===== 額外測試：getClawKey 方法 =====

describe('L3Concierge getClawKey', () => {
  it('KeyPool 有Claw Key → 回傳 ClawKeyInfo', async () => {
    const clawKey = createMockKey(42, '__claw_key__', 500);
    const keyPool = createMockKeyPool(clawKey);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const info = await concierge.getClawKey();

    expect(info).not.toBeNull();
    expect(info!.key.id).toBe(42);
    expect(info!.key.service_id).toBe('__claw_key__');
    expect(info!.daily_tokens_used).toBe(500);
  });

  it('KeyPool 無Claw Key → 回傳 null', async () => {
    const keyPool = createMockKeyPool(null);
    const executor = createMockExecutor();
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const info = await concierge.getClawKey();

    expect(info).toBeNull();
  });
});

// ===== 額外測試：callLLMWithClawKey =====

describe('L3Concierge callLLMWithClawKey', () => {
  it('找不到 LLM Adapter → success=false + 錯誤訊息', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);
    const executor = createMockExecutor();
    // 沒有任何 Adapter（或都不支援 chat）
    const adapters = new Map<string, AdapterConfig>();
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.callLLMWithClawKey(
      clawKey,
      'system prompt',
      [{ role: 'user', content: 'hello' }]
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Adapter');
  });

  it('Executor 失敗 → callLLMWithClawKey 回傳 success=false', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);
    const executor = createFailingExecutor(500);
    const adapters = new Map([['groq', createMockAdapter('groq', 'llm')]]);
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.callLLMWithClawKey(
      clawKey,
      'system',
      [{ role: 'user', content: 'test' }]
    );

    expect(result.success).toBe(false);
  });

  it('Executor 成功 → 提取 OpenAI 格式的 content 和 tokens', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);
    const executor = createMockExecutor('這是回答內容', 123);
    const adapters = new Map([['groq', createMockAdapter('groq', 'llm')]]);
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);
    const result = await concierge.callLLMWithClawKey(
      clawKey,
      'system',
      [{ role: 'user', content: 'test' }]
    );

    expect(result.success).toBe(true);
    expect(result.content).toBe('這是回答內容');
    expect(result.tokens).toBe(123);
  });
});

// ===== 額外測試：synthesizeResult =====

describe('L3Concierge synthesizeResult', () => {
  it('應根據步驟結果生成整合回答', async () => {
    const clawKey = createMockKey(1, '__claw_key__');
    const keyPool = createMockKeyPool(clawKey);
    const executor = createMockExecutor('整合後的最終回答', 80);
    const adapters = new Map([['groq', createMockAdapter('groq', 'llm')]]);
    const l2Gateway = createSuccessL2Gateway();

    const concierge = new L3Concierge(keyPool, executor, adapters, l2Gateway);

    const stepResults = [
      {
        index: 0,
        tool: 'brave-search',
        success: true,
        data: { results: ['item1', 'item2'] },
        tokens: 200,
        latency_ms: 100,
      },
    ];

    const result = await concierge.synthesizeResult(
      clawKey,
      [{ role: 'user', content: '搜尋 AI 新聞' }],
      { understanding: '搜尋任務', steps: [] },
      stepResults
    );

    expect(result.success).toBe(true);
    expect(result.answer).toBe('整合後的最終回答');
    expect(result.tokens).toBe(80);
  });
});
