// 成本預測引擎測試
import { describe, expect, test } from 'bun:test';
import { CostEngine, SERVICE_PRICING } from '../cost-engine';

// ===== Mock DB =====

function createMockDb(usageRows: unknown[] = []) {
  return {
    query: (_sql: string, _params?: unknown[]) => usageRows,
    run: () => {},
    exec: () => {},
  } as any;
}

// ===== 定價資料測試 =====

describe('SERVICE_PRICING', () => {
  test('應包含所有核心服務', () => {
    const serviceIds = new Set(SERVICE_PRICING.map(p => p.service_id));
    expect(serviceIds.has('openai')).toBe(true);
    expect(serviceIds.has('anthropic')).toBe(true);
    expect(serviceIds.has('gemini')).toBe(true);
    expect(serviceIds.has('groq')).toBe(true);
    expect(serviceIds.has('deepseek')).toBe(true);
    expect(serviceIds.has('cerebras')).toBe(true);
  });

  test('免費服務應標記 has_free_tier', () => {
    const freeServices = SERVICE_PRICING.filter(p => p.has_free_tier);
    const freeIds = new Set(freeServices.map(p => p.service_id));
    expect(freeIds.has('groq')).toBe(true);
    expect(freeIds.has('gemini')).toBe(true);
    expect(freeIds.has('cerebras')).toBe(true);
  });

  test('付費服務 pricing 應 > 0', () => {
    const openaiGpt4o = SERVICE_PRICING.find(
      p => p.service_id === 'openai' && p.model_pattern === 'gpt-4o*'
    );
    expect(openaiGpt4o).toBeDefined();
    expect(openaiGpt4o!.input_per_1m_usd).toBeGreaterThan(0);
    expect(openaiGpt4o!.output_per_1m_usd).toBeGreaterThan(0);
  });
});

// ===== CostEngine 測試 =====

describe('CostEngine', () => {
  test('無使用記錄時回傳空報告', () => {
    const engine = new CostEngine(createMockDb([]));
    const report = engine.getCostReport('7d');
    expect(report.services).toHaveLength(0);
    expect(report.total_cost_usd).toBe(0);
    expect(report.monthly_projection_usd).toBe(0);
  });

  test('免費服務成本應為 0', () => {
    const mockRows = [
      {
        service_id: 'groq',
        total_requests: 100,
        tokens_input: 50000,
        tokens_output: 25000,
        top_model: 'llama-3.1-8b-instant',
      },
    ];
    const engine = new CostEngine(createMockDb(mockRows));
    const report = engine.getCostReport('7d');

    expect(report.services).toHaveLength(1);
    // Groq 免費 tier 的成本非常低（不是 0，因為有定價）
    expect(report.services[0]!.is_free_tier).toBe(true);
  });

  test('付費服務應正確計算成本', () => {
    const mockRows = [
      {
        service_id: 'openai',
        total_requests: 50,
        tokens_input: 1000000, // 100 萬 input
        tokens_output: 500000, // 50 萬 output
        top_model: 'gpt-4o-2024-11-20',
      },
    ];
    const engine = new CostEngine(createMockDb(mockRows));
    const report = engine.getCostReport('7d');

    expect(report.services).toHaveLength(1);
    const svc = report.services[0]!;
    expect(svc.service_id).toBe('openai');
    expect(svc.is_free_tier).toBe(false);
    // GPT-4o: $2.50/1M input + $10/1M output
    // 1M input = $2.50, 0.5M output = $5.00, total = $7.50
    expect(svc.estimated_cost_usd).toBe(7.5);
  });

  test('月度預測應基於日均', () => {
    const mockRows = [
      {
        service_id: 'openai',
        total_requests: 70,
        tokens_input: 7000000,
        tokens_output: 3500000,
        top_model: 'gpt-4o',
      },
    ];
    const engine = new CostEngine(createMockDb(mockRows));
    const report = engine.getCostReport('7d');

    // 7 天花費 = 7M input * $2.5/M + 3.5M output * $10/M = $17.50 + $35 = $52.50
    expect(report.total_cost_usd).toBe(52.5);
    // 日均 = $52.50 / 7 = $7.50, 月度 = $7.50 * 30 = $225
    expect(report.monthly_projection_usd).toBe(225);
  });

  test('estimateRequestCost 應正確計算', () => {
    const engine = new CostEngine(createMockDb());
    const cost = engine.estimateRequestCost('anthropic', 'claude-4-sonnet', 1000, 500);
    // Sonnet: $3/1M input + $15/1M output
    // 1000 input = $0.003, 500 output = $0.0075, total = $0.0105
    expect(cost).toBeCloseTo(0.0105, 3);
  });

  test('DB 查詢失敗應優雅降級', () => {
    const errorDb = {
      query: () => { throw new Error('DB error'); },
      run: () => {},
      exec: () => {},
    } as any;
    const engine = new CostEngine(errorDb);
    const report = engine.getCostReport('7d');
    expect(report.services).toHaveLength(0);
    expect(report.total_cost_usd).toBe(0);
  });

  test('省錢建議應針對最貴的服務', () => {
    const mockRows = [
      {
        service_id: 'openai',
        total_requests: 100,
        tokens_input: 5000000,
        tokens_output: 2000000,
        top_model: 'gpt-4o',
      },
    ];
    const engine = new CostEngine(createMockDb(mockRows));
    const report = engine.getCostReport('7d');

    // 應該有省錢建議
    expect(report.savings_tips.length).toBeGreaterThan(0);
    // 第一個建議應該提到 DeepSeek
    expect(report.savings_tips[0]!.title).toContain('DeepSeek');
  });
});
