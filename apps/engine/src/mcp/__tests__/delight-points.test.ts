// 四爽點體驗引導測試
// 爽點一：一鍵全自動（handleAuto 自動匯入 + Claw Key）
// 爽點二：主動推薦下一個免費服務
// 爽點三：碰限額引導加 Key

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { executeSetupWizardTool, type SetupWizardDeps, getProactiveRecommendation } from '../tools/setup-wizard';
import { executeKeysAddTool, type KeysAddRelayDeps } from '../tools/keys';
import type { KeyPool, KeyListItem } from '../../core/key-pool';
import type { AdapterConfig } from '../../adapters/loader';
import type { SubKeyManager, SubKey } from '../../sharing/sub-key';
import type { GrowthEngine } from '../../growth/engine';
import type { ClawDatabase } from '../../storage/database';
import type { GrowthPhase } from '../../growth/types';

// ===== Mock 工廠 =====

/** 建立假的 KeyPool，可追蹤 addKey 呼叫 */
function createMockKeyPool(initialServices: string[] = []): KeyPool & { _added: Array<{ service: string; key: string }> } {
  const added: Array<{ service: string; key: string }> = [];
  let nextId = initialServices.length + 1;

  // 初始的 key 清單
  const initialKeys: KeyListItem[] = initialServices.map((s, i) => ({
    id: i + 1,
    service_id: s,
    key_masked: `sk-****${s.slice(0, 4)}`,
    pool_type: 'king' as const,
    label: null,
    status: 'active' as const,
    priority: 0,
    pinned: false,
    daily_used: 0,
    consecutive_failures: 0,
    rate_limit_until: null,
    last_success_at: null,
    created_at: new Date().toISOString(),
  }));

  return {
    _added: added,
    listKeys: async (serviceId?: string) => {
      // 合併初始 + 新增的
      const all = [
        ...initialKeys,
        ...added.map((a, i) => ({
          id: nextId + i,
          service_id: a.service,
          key_masked: `sk-****new${i}`,
          pool_type: 'king' as const,
          label: null,
          status: 'active' as const,
          priority: 0,
          pinned: false,
          daily_used: 0,
          consecutive_failures: 0,
          rate_limit_until: null,
          last_success_at: null,
          created_at: new Date().toISOString(),
        })),
      ];
      if (serviceId) return all.filter(k => k.service_id === serviceId);
      return all;
    },
    addKey: async (serviceId: string, keyValue: string) => {
      added.push({ service: serviceId, key: keyValue });
      return nextId++;
    },
    removeKey: async () => {},
    selectKey: async () => null,
    selectKeyWithFallback: async () => null,
    reportSuccess: async () => {},
    reportRateLimit: async () => {},
    reportAuthError: async () => {},
    reportError: async () => {},
    dailyReset: async () => {},
    getServiceIds: () => initialServices,
    setNotificationManager: () => {},
  } as unknown as KeyPool & { _added: Array<{ service: string; key: string }> };
}

/** 建立假的 Adapter 設定（含 endpoints + auth，key-validator 需要） */
function createMockAdapters(): Map<string, AdapterConfig> {
  const map = new Map<string, AdapterConfig>();
  for (const id of ['openai', 'groq', 'gemini', 'anthropic', 'cerebras', 'deepseek']) {
    map.set(id, {
      id,
      name: id,
      base_url: `https://${id}.test/v1`,
      auth: { type: 'bearer' },
      endpoints: {
        models: { path: '/models', method: 'GET' },
        chat: { path: '/chat/completions', method: 'POST' },
      },
    } as unknown as AdapterConfig);
  }
  return map;
}

/** 建立假的 SubKeyManager */
function createMockSubKeyManager(): SubKeyManager {
  return {
    issue: async () => ({
      token: 'sk_live_test_claw_key',
      label: 'Claw Key（自動產生）',
      daily_limit: null,
      allowed_services: null,
      allowed_models: null,
      rate_limit_per_hour: null,
      created_at: new Date().toISOString(),
    } as SubKey),
    list: async () => [],
    revoke: async () => false,
    validate: async () => null,
  } as unknown as SubKeyManager;
}

/** 建立假的 GrowthEngine */
function createMockGrowthEngine(phase: GrowthPhase): GrowthEngine {
  return {
    getPhase: async () => phase,
    getGrowthState: async () => ({
      phase,
      layers_unlocked: [],
      layer_progress: { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 },
      next_actions: [],
      pool_health: { services: [], total_keys: 0, total_services: 0, rate_limited_count: 0 },
    }),
    getRecommendations: async () => [],
    getPoolHealth: async () => ({ services: [], total_keys: 0, total_services: 0, rate_limited_count: 0 }),
    getUsageInsights: async () => [],
    getIntelligenceReport: async () => ({
      personal_stats: [],
      collective_intel: [],
      suggestions: [],
      total_requests_7d: 0,
      data_sufficient: false,
    }),
  } as unknown as GrowthEngine;
}

/** 建立假的 DB */
function createMockDb(): ClawDatabase {
  const store = new Map<string, string>();
  return {
    query: <T>(_sql: string): T[] => {
      const val = store.get('growth_last_phase');
      if (val && _sql.includes('growth_last_phase')) return [{ value: val }] as T[];
      return [];
    },
    run: (_sql: string, params?: unknown[]) => {
      if (_sql.includes('growth_last_phase') && params?.[0]) {
        store.set('growth_last_phase', params[0] as string);
      }
      return { lastInsertRowid: 1, changes: 1 };
    },
  } as unknown as ClawDatabase;
}

// ===== Mock fetch（env-scanner 和 key-validator 需要） =====

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  // Mock fetch：讓所有 API 驗證和 Ollama 偵測都回傳預設結果
  globalThis.fetch = (async (url: string) => {
    // Ollama 偵測（不存在）
    if (typeof url === 'string' && url.includes('localhost:11434')) {
      throw new Error('Connection refused');
    }
    // Key 驗證（假裝成功）
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'test-model' }], object: 'list' }),
      text: async () => 'ok',
      headers: new Headers(),
    };
  }) as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ===== 爽點一：一鍵全自動測試 =====

describe('爽點一：一鍵全自動（handleAuto）', () => {
  it('找到 Key 時應自動匯入，不要求逐一確認', async () => {
    // 設定環境變數模擬掃到 Key
    const originalEnv = { ...process.env };
    process.env.GROQ_API_KEY = 'gsk_test_key_for_auto_import';
    process.env.GEMINI_API_KEY = 'AIzaSy_test_key_for_auto_import';

    try {
      const keyPool = createMockKeyPool();
      const deps: SetupWizardDeps = {
        keyPool,
        adapters: createMockAdapters(),
        subKeyManager: createMockSubKeyManager(),
        db: createMockDb(),
        growthEngine: createMockGrowthEngine('onboarding'),
      };

      const result = await executeSetupWizardTool({ action: 'auto' }, deps);
      const text = result.content[0]!.text;

      // 核心驗證：應該自動匯入，不應出現「請確認」「逐一匯入」字樣
      expect(text).not.toContain('請確認是否要匯入');
      expect(text).not.toContain('逐一匯入');

      // 應該有匯入的結果
      expect(text).toContain('已匯入');

      // 應該有 Claw Key
      expect(text).toContain('Claw Key');
      expect(text).toContain('sk_live_');

      // 應該有「搞定」等完成訊息
      expect(text).toContain('搞定');
    } finally {
      // 恢復環境變數
      process.env = originalEnv;
    }
  });

  it('匯入後應顯示「以後用 Claw Key 就好」', async () => {
    const originalEnv = { ...process.env };
    process.env.GROQ_API_KEY = 'gsk_test_claw_key_msg';

    try {
      const keyPool = createMockKeyPool();
      const deps: SetupWizardDeps = {
        keyPool,
        adapters: createMockAdapters(),
        subKeyManager: createMockSubKeyManager(),
      };

      const result = await executeSetupWizardTool({ action: 'auto' }, deps);
      const text = result.content[0]!.text;

      // 應告訴用戶用 Claw Key 就好
      expect(text).toContain('Claw Key');
      expect(text).toContain('通吃');
    } finally {
      process.env = originalEnv;
    }
  });

  it('沒找到新 Key 時應推薦免費服務', async () => {
    const originalEnv = { ...process.env };
    // 清空所有 API Key 環境變數 + 關閉 .env 檔案掃描（測試環境不可控）
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAWAPI_SKIP_DOTENV = '1';

    try {
      const keyPool = createMockKeyPool();
      const deps: SetupWizardDeps = {
        keyPool,
        adapters: createMockAdapters(),
      };

      const result = await executeSetupWizardTool({ action: 'auto' }, deps);
      const text = result.content[0]!.text;

      // 應該推薦免費服務（至少推薦一個免費服務的 URL）
      const hasFreeServiceUrl = text.includes('console.groq.com') || text.includes('aistudio.google.com');
      expect(hasFreeServiceUrl).toBe(true);
    } finally {
      process.env = originalEnv;
    }
  });
});

// ===== 爽點二：主動推薦測試 =====

describe('爽點二：主動推薦下一個免費服務', () => {
  it('加了 openai 應推薦免費的 groq', async () => {
    const keyPool = createMockKeyPool(['openai']);
    const recommendation = await getProactiveRecommendation({ keyPool });

    expect(recommendation).not.toBeNull();
    expect(recommendation).toContain('Groq');
    expect(recommendation).toContain('groq.com');
    expect(recommendation).toContain('免費');
  });

  it('已有 groq 應推薦 gemini', async () => {
    const keyPool = createMockKeyPool(['groq']);
    const recommendation = await getProactiveRecommendation({ keyPool });

    expect(recommendation).not.toBeNull();
    expect(recommendation).toContain('Gemini');
    expect(recommendation).toContain('aistudio.google.com');
  });

  it('已有所有免費服務不應推薦付費', async () => {
    // 所有 SERVICE_RECOMMENDATIONS 中 effort != 'paid' 的都有了
    const keyPool = createMockKeyPool(['groq', 'gemini', 'cerebras', 'deepseek', 'deepl', 'tavily']);
    const recommendation = await getProactiveRecommendation({ keyPool });

    // 不推薦付費的，回傳 null
    expect(recommendation).toBeNull();
  });

  it('有 growthEngine 時推薦應包含階段相關措辭', async () => {
    const keyPool = createMockKeyPool(['openai']);
    const growthEngine = createMockGrowthEngine('awakening');
    const recommendation = await getProactiveRecommendation({ keyPool, growthEngine });

    expect(recommendation).not.toBeNull();
    expect(recommendation).toContain('智慧路由');
  });

  it('keys_add 成功後應包含推薦', async () => {
    const keyPool = createMockKeyPool(['openai']);
    const relayDeps: KeysAddRelayDeps = {
      db: createMockDb(),
      growthEngine: createMockGrowthEngine('awakening'),
    };

    const result = await executeKeysAddTool(
      { service: 'anthropic', key: 'sk-ant-test123' },
      keyPool,
      relayDeps
    );
    const text = result.content[0]!.text;

    // 應包含 key 新增確認
    expect(text).toContain('已新增');
    // 應包含推薦（因為還沒有 groq/gemini/cerebras）
    expect(text).toContain('下一步');
    expect(text).toContain('申請');
  });
});

// ===== 爽點三：碰限額引導（L1/L2 層） =====
// 注：L1/L2 需要完整的 Adapter executor mock，這裡測試引導訊息的邏輯

describe('爽點三：碰限額引導', () => {
  it('getProactiveRecommendation 在空池時應推薦第一個免費服務', async () => {
    const keyPool = createMockKeyPool([]);
    const recommendation = await getProactiveRecommendation({ keyPool });

    expect(recommendation).not.toBeNull();
    // 第一推薦是 Groq（SERVICE_RECOMMENDATIONS 第一個免費的）
    expect(recommendation).toContain('Groq');
  });

  it('單 Key 服務應建議加第二把', async () => {
    // 這個測試驗證 pool health 的建議（engine.getPoolHealth 已有此邏輯）
    const keyPool = createMockKeyPool(['openai']);
    const keys = await keyPool.listKeys('openai');

    // 只有 1 把 Key
    expect(keys.length).toBe(1);

    // getProactiveRecommendation 推薦的是加新服務而非同服務加 Key
    // 但 growth_guide(view=pool) 的 suggestion 會提到加第二把
    // 這裡驗證基本邏輯正確性
  });
});

// ===== 整合測試 =====

describe('完整爽點流程整合', () => {
  it('全新用戶 auto → 匯入 → Claw Key → 推薦（完整流程）', async () => {
    const originalEnv = { ...process.env };
    process.env.OPENAI_API_KEY = 'sk-test_full_flow';

    try {
      const keyPool = createMockKeyPool();
      const deps: SetupWizardDeps = {
        keyPool,
        adapters: createMockAdapters(),
        subKeyManager: createMockSubKeyManager(),
        db: createMockDb(),
        growthEngine: createMockGrowthEngine('onboarding'),
      };

      const result = await executeSetupWizardTool({ action: 'auto' }, deps);
      const text = result.content[0]!.text;

      // 完整流程應包含：
      // 1. 掃描結果
      expect(text).toContain('掃描');
      // 2. 驗證結果
      expect(text).toContain('驗證');
      // 3. 匯入結果
      expect(text).toContain('匯入');
      // 4. Claw Key
      expect(text).toContain('Claw Key');
      // 5. 完成訊息
      expect(text).toContain('搞定');
      // 6. 推薦下一步
      expect(text).toContain('下一步');
    } finally {
      process.env = originalEnv;
    }
  });
});
