import { describe, it, expect } from 'bun:test';
import { GrowthEngine } from '../engine';
import type { KeyPool } from '../../core/key-pool';
import type { AdapterConfig } from '../../adapters/loader';
import type { ClawDatabase } from '../../storage/database';

type MockKey = {
  service_id: string;
  status?: 'active' | 'rate_limited' | 'dead';
};

function toKeyListItem(k: MockKey, idx: number) {
  return {
    id: idx + 1,
    service_id: k.service_id,
    key_masked: 'sk-****test',
    pool_type: 'king' as const,
    label: null,
    status: k.status ?? 'active',
    priority: 0,
    pinned: false,
    daily_used: 0,
    consecutive_failures: 0,
    rate_limit_until: null,
    last_success_at: null,
    created_at: new Date().toISOString(),
  };
}

function createEngine(keys: MockKey[]): GrowthEngine {
  const keyPool = {
    listKeys: async () => keys.map((k, idx) => toKeyListItem(k, idx)),
  } as unknown as KeyPool;

  const adapters = new Map<string, AdapterConfig>();
  const db = {} as ClawDatabase;
  return new GrowthEngine(keyPool, adapters, db);
}

describe('GrowthEngine', () => {
  it('getPhase 應正確判斷各階段', async () => {
    expect(await createEngine([]).getPhase()).toBe('onboarding');
    expect(await createEngine([{ service_id: 'openai' }]).getPhase()).toBe('awakening');
    expect(await createEngine([
      { service_id: 'openai' },
      { service_id: 'gemini' },
      { service_id: 'groq' },
    ]).getPhase()).toBe('scaling');
    expect(await createEngine([
      { service_id: 'openai' },
      { service_id: 'openai' },
    ]).getPhase()).toBe('scaling');
    expect(await createEngine([
      { service_id: 'openai' },
      { service_id: 'gemini' },
      { service_id: 'groq' },
      { service_id: 'deepl' },
      { service_id: 'tavily' },
    ]).getPhase()).toBe('mastery');
  });

  it('getLayerProgress 應回傳 L0-L4 進度', async () => {
    const engine = createEngine([
      { service_id: 'openai', status: 'active' },
      { service_id: 'gemini', status: 'active' },
      { service_id: 'groq', status: 'active' },
      { service_id: 'tavily', status: 'active' },
    ]);

    const progress = await engine.getLayerProgress();
    expect(progress.L0).toBe(0);
    expect(progress.L1).toBe(1);
    expect(progress.L2).toBe(1);
    expect(progress.L3).toBe(1);
    expect(progress.L4).toBe(1);
  });

  it('getRecommendations 應依路線回傳結果', async () => {
    const engine = createEngine([{ service_id: 'groq' }]);

    const freeRoute = await engine.getRecommendations('free');
    expect(freeRoute.length).toBeGreaterThan(0);
    expect(freeRoute.every(a => a.effort === 'signup' || a.effort === 'free')).toBe(true);

    const balancedRoute = await engine.getRecommendations('balanced');
    expect(balancedRoute.length).toBeGreaterThan(0);
    expect(balancedRoute.length).toBeLessThanOrEqual(5);

    const fullRoute = await engine.getRecommendations('full');
    expect(fullRoute.length).toBeGreaterThan(0);
    expect(fullRoute.length).toBeLessThanOrEqual(5);
  });

  it('getPoolHealth 應正確分組與給建議', async () => {
    const engine = createEngine([
      { service_id: 'openai', status: 'active' },
      { service_id: 'openai', status: 'rate_limited' },
      { service_id: 'groq', status: 'active' },
    ]);

    const health = await engine.getPoolHealth();
    expect(health.total_keys).toBe(3);
    expect(health.total_services).toBe(2);
    expect(health.rate_limited_count).toBe(1);

    const groq = health.services.find(s => s.service_id === 'groq');
    const openai = health.services.find(s => s.service_id === 'openai');
    expect(groq?.suggestion).toContain('第 2 把 Key');
    expect(openai?.suggestion).toContain('限速');
  });

  it('getGrowthState 應整合各子結果', async () => {
    const engine = createEngine([
      { service_id: 'openai', status: 'active' },
      { service_id: 'groq', status: 'active' },
    ]);

    const state = await engine.getGrowthState();
    expect(state.phase).toBe('awakening');
    expect(state.layers_unlocked).toContain('L1');
    expect(state.next_actions.length).toBeGreaterThan(0);
    expect(state.pool_health.total_keys).toBe(2);
  });
});

// ===== getUsageInsights 測試 =====

/** 建立帶 DB mock 的 engine（可控制 queryPersonalStats 回傳） */
function createEngineWithDb(
  keys: MockKey[],
  usageRows: Array<{
    service_id: string;
    total_requests: number;
    success_count: number;
    error_count: number;
    rate_limited_count: number;
    avg_latency_ms: number;
    total_tokens: number;
  }>
): GrowthEngine {
  const keyPool = {
    listKeys: async () => keys.map((k, idx) => toKeyListItem(k, idx)),
  } as unknown as KeyPool;

  const adapters = new Map<string, AdapterConfig>();

  // mock DB：query 回傳指定的 usage rows
  const db = {
    query: (sql: string) => {
      if (sql.includes('usage_log')) {
        return usageRows;
      }
      if (sql.includes('routing_intel')) {
        return [];
      }
      return [];
    },
    run: () => {},
  } as unknown as ClawDatabase;

  return new GrowthEngine(keyPool, adapters, db);
}

describe('GrowthEngine — getUsageInsights', () => {
  it('無使用數據時回傳空陣列', async () => {
    const engine = createEngineWithDb([], []);
    const insights = await engine.getUsageInsights();
    expect(insights).toHaveLength(0);
  });

  it('主力服務只有 1 把 Key 時應建議加第 2 把', async () => {
    const engine = createEngineWithDb(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 25,
        success_count: 24,
        error_count: 1,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 50000,
      }]
    );

    const insights = await engine.getUsageInsights();
    const capacity = insights.find(i => i.type === 'capacity');
    expect(capacity).toBeDefined();
    expect(capacity!.title).toContain('openai');
    expect(capacity!.detail).toContain('第 2 把');
  });

  it('2+ 服務時應建議 Claw Key', async () => {
    const engine = createEngineWithDb(
      [{ service_id: 'openai' }, { service_id: 'groq' }],
      [{
        service_id: 'openai',
        total_requests: 5,
        success_count: 5,
        error_count: 0,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 10000,
      }]
    );

    const insights = await engine.getUsageInsights();
    const clawKey = insights.find(i => i.type === 'claw_key');
    expect(clawKey).toBeDefined();
    expect(clawKey!.title).toContain('Claw Key');
  });

  it('高限速率時應標記', async () => {
    const engine = createEngineWithDb(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 30,
        success_count: 20,
        error_count: 5,
        rate_limited_count: 5,
        avg_latency_ms: 800,
        total_tokens: 30000,
      }]
    );

    const insights = await engine.getUsageInsights();
    const rateLimit = insights.find(i => i.type === 'rate_limit');
    expect(rateLimit).toBeDefined();
    expect(rateLimit!.title).toContain('限速');
  });

  it('只用付費服務時應推薦免費服務', async () => {
    const engine = createEngineWithDb(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 5,
        success_count: 5,
        error_count: 0,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 10000,
      }]
    );

    const insights = await engine.getUsageInsights();
    const costSaving = insights.find(i => i.type === 'cost_saving');
    expect(costSaving).toBeDefined();
    expect(costSaving!.detail).toContain('Groq');
  });

  it('已有免費服務時不應推薦免費服務', async () => {
    const engine = createEngineWithDb(
      [{ service_id: 'groq' }],
      [{
        service_id: 'groq',
        total_requests: 5,
        success_count: 5,
        error_count: 0,
        rate_limited_count: 0,
        avg_latency_ms: 200,
        total_tokens: 5000,
      }]
    );

    const insights = await engine.getUsageInsights();
    const costSaving = insights.find(i => i.type === 'cost_saving');
    expect(costSaving).toBeUndefined();
  });

  it('最多回傳 5 個洞察（含新增的 resilience、rate_limit_alternative、claw_key_mismatch）', async () => {
    const engine = createEngineWithDb(
      [{ service_id: 'openai' }, { service_id: 'anthropic' }],
      [{
        service_id: 'openai',
        total_requests: 30,
        success_count: 20,
        error_count: 5,
        rate_limited_count: 5,
        avg_latency_ms: 500,
        total_tokens: 50000,
      }, {
        service_id: 'anthropic',
        total_requests: 10,
        success_count: 10,
        error_count: 0,
        rate_limited_count: 0,
        avg_latency_ms: 600,
        total_tokens: 20000,
      }]
    );

    const insights = await engine.getUsageInsights();
    expect(insights.length).toBeLessThanOrEqual(5);
  });
});

// ===== getIntelligenceReport 測試 =====

/** 建立帶 DB mock 的 engine（可控制 usage_log + routing_intel） */
function createEngineWithIntel(
  keys: MockKey[],
  usageRows: Array<{
    service_id: string;
    total_requests: number;
    success_count: number;
    error_count: number;
    rate_limited_count: number;
    avg_latency_ms: number;
    total_tokens: number;
  }>,
  intelRows: Array<{
    service_id: string;
    region: string;
    status: string;
    confidence: number;
    success_rate: number | null;
    avg_latency_ms: number | null;
    p95_latency_ms: number | null;
    sample_size: number | null;
    note: string | null;
    updated_at: string;
    valid_until: string;
  }>
): GrowthEngine {
  const keyPool = {
    listKeys: async () => keys.map((k, idx) => toKeyListItem(k, idx)),
  } as unknown as KeyPool;

  const adapters = new Map<string, AdapterConfig>();

  const db = {
    query: (sql: string) => {
      if (sql.includes('usage_log')) return usageRows;
      if (sql.includes('routing_intel')) return intelRows;
      return [];
    },
    run: () => {},
  } as unknown as ClawDatabase;

  return new GrowthEngine(keyPool, adapters, db);
}

describe('GrowthEngine — getIntelligenceReport', () => {
  it('無數據時 data_sufficient 應為 false', async () => {
    const engine = createEngineWithIntel([], [], []);
    const report = await engine.getIntelligenceReport();

    expect(report.data_sufficient).toBe(false);
    expect(report.total_requests_7d).toBe(0);
    expect(report.suggestions).toHaveLength(0);
  });

  it('不足 50 次時 data_sufficient 應為 false', async () => {
    const engine = createEngineWithIntel(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 30,
        success_count: 28,
        error_count: 2,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 10000,
      }],
      []
    );

    const report = await engine.getIntelligenceReport();
    expect(report.data_sufficient).toBe(false);
    expect(report.total_requests_7d).toBe(30);
    expect(report.suggestions).toHaveLength(0);
  });

  it('>=50 次時 data_sufficient 應為 true 且產出建議', async () => {
    const engine = createEngineWithIntel(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 60,
        success_count: 40,
        error_count: 15,
        rate_limited_count: 5,
        avg_latency_ms: 800,
        total_tokens: 200000,
      }],
      [{
        service_id: 'groq',
        region: 'us-west',
        status: 'healthy',
        confidence: 0.95,
        success_rate: 0.99,
        avg_latency_ms: 200,
        p95_latency_ms: 400,
        sample_size: 2000,
        note: null,
        updated_at: new Date().toISOString(),
        valid_until: new Date(Date.now() + 86400000).toISOString(),
      }]
    );

    const report = await engine.getIntelligenceReport();
    expect(report.data_sufficient).toBe(true);
    expect(report.total_requests_7d).toBe(60);
    expect(report.suggestions.length).toBeGreaterThan(0);
    // openai 成功率 40/60=66% < 80%，應建議替代
    const modelRec = report.suggestions.find(s => s.type === 'model_recommendation');
    expect(modelRec).toBeDefined();
    expect(modelRec!.title).toContain('openai');
  });

  it('高延遲服務應推薦更快替代', async () => {
    const engine = createEngineWithIntel(
      [{ service_id: 'anthropic' }],
      [{
        service_id: 'anthropic',
        total_requests: 55,
        success_count: 50,
        error_count: 5,
        rate_limited_count: 0,
        avg_latency_ms: 5000,
        total_tokens: 100000,
      }],
      [{
        service_id: 'groq',
        region: 'us-west',
        status: 'healthy',
        confidence: 0.9,
        success_rate: 0.98,
        avg_latency_ms: 200,
        p95_latency_ms: 400,
        sample_size: 500,
        note: null,
        updated_at: new Date().toISOString(),
        valid_until: new Date(Date.now() + 86400000).toISOString(),
      }]
    );

    const report = await engine.getIntelligenceReport();
    expect(report.data_sufficient).toBe(true);
    // anthropic 平均 5000ms，groq 200ms（< 2500ms），應建議
    const latencyRec = report.suggestions.find(s => s.detail.includes('延遲'));
    expect(latencyRec).toBeDefined();
  });

  it('集體數據有高品質未用服務時應推薦', async () => {
    const engine = createEngineWithIntel(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 60,
        success_count: 58,
        error_count: 2,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 50000,
      }],
      [{
        service_id: 'gemini',
        region: 'us-central',
        status: 'healthy',
        confidence: 0.95,
        success_rate: 0.99,
        avg_latency_ms: 300,
        p95_latency_ms: 600,
        sample_size: 1500,
        note: null,
        updated_at: new Date().toISOString(),
        valid_until: new Date(Date.now() + 86400000).toISOString(),
      }]
    );

    const report = await engine.getIntelligenceReport();
    const qualityRec = report.suggestions.find(s => s.type === 'quality_upgrade');
    expect(qualityRec).toBeDefined();
    expect(qualityRec!.title).toContain('gemini');
  });

  it('DB 查詢失敗時不爆炸', async () => {
    const keyPool = {
      listKeys: async () => [],
    } as unknown as KeyPool;

    const db = {
      query: () => { throw new Error('DB 壞了'); },
    } as unknown as ClawDatabase;

    const engine = new GrowthEngine(keyPool, new Map(), db);
    const report = await engine.getIntelligenceReport();

    expect(report.data_sufficient).toBe(false);
    expect(report.personal_stats).toHaveLength(0);
    expect(report.collective_intel).toHaveLength(0);
  });
});

// ===== getClawKeyRecommendations 測試 =====

/** 用量列型別（方便重複使用） */
type UsageRow = {
  service_id: string;
  total_requests: number;
  success_count: number;
  error_count: number;
  rate_limited_count: number;
  avg_latency_ms: number;
  total_tokens: number;
};

/** 建立帶完整 DB mock 的 engine（可控制 usage_log + gold_keys） */
function createEngineWithFullDb(
  keys: MockKey[],
  usageRows: UsageRow[],
  goldKeys: Array<{ service_id: string; is_active: number }>,
): GrowthEngine {
  const keyPool = {
    listKeys: async () => keys.map((k, idx) => toKeyListItem(k, idx)),
  } as unknown as KeyPool;

  const adapters = new Map<string, AdapterConfig>();

  // mock DB：根據 SQL 內容回傳對應資料
  const db = {
    query: (sql: string) => {
      if (sql.includes('gold_keys')) {
        // 只回傳 is_active = 1 的列（模擬 WHERE is_active = 1）
        return goldKeys
          .filter(g => g.is_active === 1)
          .map(g => ({ service_id: g.service_id }));
      }
      if (sql.includes('usage_log')) {
        return usageRows;
      }
      if (sql.includes('routing_intel')) {
        return [];
      }
      return [];
    },
    run: () => {},
  } as unknown as ClawDatabase;

  return new GrowthEngine(keyPool, adapters, db);
}

describe('GrowthEngine — getClawKeyRecommendations', () => {
  it('覆蓋缺口：Claw Key 在 groq 但用量最高是 openai', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }, { service_id: 'groq' }],
      [{
        service_id: 'openai',
        total_requests: 50,
        success_count: 48,
        error_count: 2,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 80000,
      }, {
        service_id: 'groq',
        total_requests: 10,
        success_count: 10,
        error_count: 0,
        rate_limited_count: 0,
        avg_latency_ms: 200,
        total_tokens: 5000,
      }],
      [{ service_id: 'groq', is_active: 1 }],
    );

    const recommendations = await engine.getClawKeyRecommendations();
    const gap = recommendations.find(r => r.type === 'coverage_gap');
    expect(gap).toBeDefined();
    expect(gap!.title).toContain('openai');
    expect(gap!.detail).toContain('openai');
  });

  it('效能不佳：Claw Key 涵蓋的 openai 成功率 < 80%', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 40,
        success_count: 28,   // 28/40 = 70% < 80%
        error_count: 12,
        rate_limited_count: 0,
        avg_latency_ms: 600,
        total_tokens: 30000,
      }],
      [{ service_id: 'openai', is_active: 1 }],
    );

    const recommendations = await engine.getClawKeyRecommendations();
    const poor = recommendations.find(r => r.type === 'poor_performance');
    expect(poor).toBeDefined();
    expect(poor!.title).toContain('openai');
    expect(poor!.title).toContain('70%');
  });

  it('優化建議：全部免費服務但用量大', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'groq' }, { service_id: 'gemini' }],
      [{
        service_id: 'groq',
        total_requests: 80,
        success_count: 78,
        error_count: 2,
        rate_limited_count: 0,
        avg_latency_ms: 200,
        total_tokens: 50000,
      }, {
        service_id: 'gemini',
        total_requests: 40,
        success_count: 39,
        error_count: 1,
        rate_limited_count: 0,
        avg_latency_ms: 300,
        total_tokens: 20000,
      }],
      // Claw Key 全是免費服務
      [
        { service_id: 'groq', is_active: 1 },
        { service_id: 'gemini', is_active: 1 },
      ],
    );

    // 總用量 120 > 100，且全是免費服務 → 應產出 optimization 建議
    const recommendations = await engine.getClawKeyRecommendations();
    const opt = recommendations.find(r => r.type === 'optimization');
    expect(opt).toBeDefined();
    expect(opt!.title).toContain('免費');
    expect(opt!.detail).toContain('120');
  });

  it('無 Claw Key（gold_keys 為空）→ 回傳空陣列', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 30,
        success_count: 28,
        error_count: 2,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 20000,
      }],
      [], // 沒有任何 Claw Key
    );

    const recommendations = await engine.getClawKeyRecommendations();
    expect(recommendations).toHaveLength(0);
  });

  it('gold_keys 表查詢拋錯時回傳空陣列（不爆炸）', async () => {
    const keyPool = {
      listKeys: async () => [],
    } as unknown as KeyPool;

    // 模擬 gold_keys 表不存在的情況
    const db = {
      query: (sql: string) => {
        if (sql.includes('gold_keys')) {
          throw new Error('no such table: gold_keys');
        }
        return [];
      },
      run: () => {},
    } as unknown as ClawDatabase;

    const engine = new GrowthEngine(keyPool, new Map(), db);
    const recommendations = await engine.getClawKeyRecommendations();
    expect(recommendations).toHaveLength(0);
  });

  it('最多回傳 3 個建議', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }, { service_id: 'groq' }, { service_id: 'gemini' }],
      [{
        service_id: 'openai',
        total_requests: 60,
        success_count: 40,   // 成功率 66% < 80%
        error_count: 20,
        rate_limited_count: 0,
        avg_latency_ms: 600,
        total_tokens: 50000,
      }, {
        service_id: 'groq',
        total_requests: 50,
        success_count: 50,
        error_count: 0,
        rate_limited_count: 0,
        avg_latency_ms: 200,
        total_tokens: 30000,
      }],
      // Claw Key 全是免費服務（觸發 optimization），且不涵蓋 openai（觸發 coverage_gap）
      // openai 成功率低（觸發 poor_performance）— 但 openai 不在 clawKeyServiceSet 所以不觸發
      [
        { service_id: 'groq', is_active: 1 },
        { service_id: 'gemini', is_active: 1 },
      ],
    );

    const recommendations = await engine.getClawKeyRecommendations();
    expect(recommendations.length).toBeLessThanOrEqual(3);
  });
});

// ===== 新 insights 測試（resilience, rate_limit_alternative） =====

describe('GrowthEngine — getUsageInsights 新洞察', () => {
  it('resilience：高用量服務只有 1 把 key 時應產出韌性建議', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 30,
        success_count: 28,
        error_count: 2,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 40000,
      }],
      [], // 沒有 Claw Key
    );

    const insights = await engine.getUsageInsights();
    const resilience = insights.find(i => i.type === 'resilience');
    expect(resilience).toBeDefined();
    expect(resilience!.title).toContain('openai');
    expect(resilience!.detail).toContain('備援');
  });

  it('rate_limit_alternative：被 429 超過 3 次時應推薦免費替代', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 30,
        success_count: 20,
        error_count: 5,
        rate_limited_count: 5,   // > 3 次
        avg_latency_ms: 800,
        total_tokens: 30000,
      }],
      [], // 沒有 Claw Key
    );

    const insights = await engine.getUsageInsights();
    const altInsight = insights.find(i => i.type === 'rate_limit_alternative');
    expect(altInsight).toBeDefined();
    expect(altInsight!.title).toContain('groq');       // openai 的免費替代是 groq
    expect(altInsight!.detail).toContain('429');
  });

  it('rate_limit_alternative：已有免費替代時不應重複推薦', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }, { service_id: 'groq' }],
      [{
        service_id: 'openai',
        total_requests: 30,
        success_count: 20,
        error_count: 5,
        rate_limited_count: 5,
        avg_latency_ms: 800,
        total_tokens: 30000,
      }],
      [], // 沒有 Claw Key
    );

    const insights = await engine.getUsageInsights();
    // 已有 groq，不應該再推薦 groq 作為 openai 的替代
    const altInsight = insights.find(i => i.type === 'rate_limit_alternative');
    expect(altInsight).toBeUndefined();
  });

  it('claw_key_mismatch：Claw Key 不涵蓋主力服務時應在洞察中出現', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }, { service_id: 'groq' }],
      [{
        service_id: 'openai',
        total_requests: 50,
        success_count: 48,
        error_count: 2,
        rate_limited_count: 0,
        avg_latency_ms: 500,
        total_tokens: 80000,
      }],
      [{ service_id: 'groq', is_active: 1 }],  // Claw Key 只有 groq，沒涵蓋 openai
    );

    const insights = await engine.getUsageInsights();
    const mismatch = insights.find(i => i.type === 'claw_key_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.title).toContain('openai');
  });

  it('洞察最多回傳 5 個', async () => {
    const engine = createEngineWithFullDb(
      [{ service_id: 'openai' }],
      [{
        service_id: 'openai',
        total_requests: 50,
        success_count: 30,
        error_count: 10,
        rate_limited_count: 10,
        avg_latency_ms: 800,
        total_tokens: 100000,
      }],
      [{ service_id: 'groq', is_active: 1 }],
    );

    const insights = await engine.getUsageInsights();
    expect(insights.length).toBeLessThanOrEqual(5);
  });
});

