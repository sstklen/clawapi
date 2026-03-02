// growth_guide MCP Tool 整合測試
// 測試各 view handler 的輸出格式 + fallback 路徑

import { describe, it, expect } from 'bun:test';
import { executeGrowthGuideTool } from '../growth-guide';
import type { GrowthEngine } from '../../../growth/engine';
import type { CostEngine } from '../../../growth/cost-engine';

// ===== Mock 工廠 =====

function createMockGrowthEngine(overrides?: Partial<GrowthEngine>): GrowthEngine {
  return {
    getGrowthState: async () => ({
      phase: 'awakening' as const,
      layers_unlocked: ['L1', 'L3'],
      layer_progress: { L0: 0, L1: 1, L2: 0.33, L3: 1, L4: 0 },
      next_actions: [
        {
          priority: 'medium' as const,
          action_id: 'add_gemini_key',
          title: '加 Google Gemini（免費！）',
          reason: '解鎖 100 萬 token 上下文',
          effort: 'free' as const,
          signup_url: 'https://aistudio.google.com/apikey',
          unlocks: 'L2 進度 +33%',
        },
      ],
      pool_health: {
        services: [{ service_id: 'openai', key_count: 1, active_count: 1, rate_limited_count: 0 }],
        total_keys: 1,
        total_services: 1,
        rate_limited_count: 0,
      },
    }),
    getRecommendations: async () => [
      {
        priority: 'medium' as const,
        action_id: 'add_groq_key',
        title: '加 Groq（免費超快！）',
        reason: 'Llama 3.1 免費用',
        effort: 'free' as const,
        signup_url: 'https://console.groq.com/keys',
      },
    ],
    getPoolHealth: async () => ({
      services: [
        { service_id: 'openai', key_count: 2, active_count: 1, rate_limited_count: 1, suggestion: '目前有限速，考慮加更多 Key' },
      ],
      total_keys: 2,
      total_services: 1,
      rate_limited_count: 1,
    }),
    getIntelligenceReport: async () => ({
      personal_stats: [
        {
          service_id: 'openai',
          total_requests: 100,
          success_count: 95,
          error_count: 5,
          rate_limited_count: 0,
          success_rate: 0.95,
          avg_latency_ms: 500,
          total_tokens: 200000,
        },
      ],
      collective_intel: [],
      suggestions: [
        {
          type: 'cost_saving' as const,
          title: 'openai 常被限速',
          detail: '加第 2 把 Key 可分散請求',
          confidence: 0.9,
        },
      ],
      total_requests_7d: 100,
      data_sufficient: true,
    }),
    getUsageInsights: async () => [],
    ...overrides,
  } as unknown as GrowthEngine;
}

function createMockCostEngine(): CostEngine {
  return {
    getCostReport: () => ({
      services: [
        {
          service_id: 'openai',
          total_requests: 50,
          tokens_input: 100000,
          tokens_output: 50000,
          estimated_cost_usd: 0.45,
          is_free_tier: false,
        },
      ],
      total_cost_usd: 0.45,
      free_tier_savings_usd: 1.2,
      monthly_projection_usd: 1.95,
      savings_tips: [
        {
          title: '加 Groq 可省 50% 成本',
          detail: '把部分請求分流到免費的 Groq',
          estimated_savings_usd: 0.5,
        },
      ],
    }),
  } as unknown as CostEngine;
}

// ===== 測試 =====

describe('executeGrowthGuideTool', () => {
  // === Fallback 測試 ===

  it('growthEngine 未提供時應回傳警告', async () => {
    const result = await executeGrowthGuideTool({ view: 'overview' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toContain('未初始化');
  });

  it('costEngine 未提供時 cost view 應回傳警告', async () => {
    const engine = createMockGrowthEngine();
    const result = await executeGrowthGuideTool({ view: 'cost' }, engine, undefined);
    expect(result.content[0]!.text).toContain('成本引擎未初始化');
  });

  it('不支援的 view 應回傳提示', async () => {
    const engine = createMockGrowthEngine();
    const result = await executeGrowthGuideTool(
      { view: 'nonexistent' as any },
      engine
    );
    expect(result.content[0]!.text).toContain('不支援的 view');
  });

  it('預設 view 應為 overview', async () => {
    const engine = createMockGrowthEngine();
    const result = await executeGrowthGuideTool({}, engine);
    expect(result.content[0]!.text).toContain('成長總覽');
  });

  // === overview 測試 ===

  it('overview 應包含成長階段和進度條', async () => {
    const engine = createMockGrowthEngine();
    const result = await executeGrowthGuideTool({ view: 'overview' }, engine);
    const text = result.content[0]!.text;

    expect(text).toContain('成長總覽');
    expect(text).toContain('awakening');
    expect(text).toContain('L0');
    expect(text).toContain('L1');
    expect(text).toContain('L4');
    expect(text).toContain('100%'); // L1 解鎖
    expect(text).toContain('推薦下一步');
  });

  // === recommend 測試 ===

  it('recommend 應列出推薦清單', async () => {
    const engine = createMockGrowthEngine();
    const result = await executeGrowthGuideTool(
      { view: 'recommend', route: 'free' },
      engine
    );
    const text = result.content[0]!.text;

    expect(text).toContain('推薦清單');
    expect(text).toContain('免費優先');
    expect(text).toContain('Groq');
  });

  it('recommend 已加齊時應顯示恭喜', async () => {
    const engine = createMockGrowthEngine({
      getRecommendations: async () => [],
    });
    const result = await executeGrowthGuideTool(
      { view: 'recommend', route: 'free' },
      engine
    );
    expect(result.content[0]!.text).toContain('太棒了');
  });

  // === pool 測試 ===

  it('pool 應顯示額度池健康', async () => {
    const engine = createMockGrowthEngine();
    const result = await executeGrowthGuideTool({ view: 'pool' }, engine);
    const text = result.content[0]!.text;

    expect(text).toContain('額度池健康報告');
    expect(text).toContain('openai');
    expect(text).toContain('限速中');
  });

  it('pool 空池應提示掃描', async () => {
    const engine = createMockGrowthEngine({
      getPoolHealth: async () => ({
        services: [],
        total_keys: 0,
        total_services: 0,
        rate_limited_count: 0,
      }),
    });
    const result = await executeGrowthGuideTool({ view: 'pool' }, engine);
    expect(result.content[0]!.text).toContain('setup_wizard');
  });

  // === intel 測試 ===

  it('intel 應顯示群體智慧報告', async () => {
    const engine = createMockGrowthEngine();
    const result = await executeGrowthGuideTool({ view: 'intel' }, engine);
    const text = result.content[0]!.text;

    expect(text).toContain('群體智慧報告');
    expect(text).toContain('100 次請求');
    expect(text).toContain('個人使用統計');
    expect(text).toContain('個人化建議');
  });

  it('intel 數據不足時應提示', async () => {
    const engine = createMockGrowthEngine({
      getIntelligenceReport: async () => ({
        personal_stats: [],
        collective_intel: [],
        suggestions: [],
        total_requests_7d: 10,
        data_sufficient: false,
      }),
    });
    const result = await executeGrowthGuideTool({ view: 'intel' }, engine);
    const text = result.content[0]!.text;

    expect(text).toContain('至少需要 50 次');
    expect(text).toContain('10/50');
  });

  // === cost 測試 ===

  it('cost 應顯示成本分析報告', async () => {
    const engine = createMockGrowthEngine();
    const costEngine = createMockCostEngine();
    const result = await executeGrowthGuideTool({ view: 'cost' }, engine, costEngine);
    const text = result.content[0]!.text;

    expect(text).toContain('成本分析報告');
    expect(text).toContain('$0.45');
    expect(text).toContain('月度預估');
    expect(text).toContain('省錢建議');
  });

  // === 錯誤處理 ===

  it('growthEngine 拋錯時應回傳錯誤訊息', async () => {
    const engine = createMockGrowthEngine({
      getGrowthState: async () => { throw new Error('引擎壞了'); },
    });
    const result = await executeGrowthGuideTool({ view: 'overview' }, engine);
    expect(result.content[0]!.text).toContain('查詢失敗');
    expect(result.content[0]!.text).toContain('引擎壞了');
  });
});
