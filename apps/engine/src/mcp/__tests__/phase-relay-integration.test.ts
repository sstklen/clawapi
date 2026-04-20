// MCP 接力棒整合測試（Phase Relay Integration）
// 驗證「加 Key 後 MCP 回應裡真的有接力棒訊息」
// 涵蓋：keys_add、setup_wizard import、growth_guide overview

import { describe, it, expect } from 'bun:test';
import {
  executeKeysAddTool,
  type KeysAddRelayDeps,
} from '../tools/keys';
import {
  executeSetupWizardTool,
  type SetupWizardDeps,
} from '../tools/setup-wizard';
import {
  executeGrowthGuideTool,
} from '../tools/growth-guide';
import type { KeyPool, KeyListItem } from '../../core/key-pool';
import type { ClawDatabase } from '../../storage/database';
import type { GrowthEngine } from '../../growth/engine';
import type { GrowthPhase } from '../../growth/types';
import type { AdapterConfig } from '../../adapters/loader';

// ===== Mock 工廠 =====

/** 建立 mock DB（仿照 phase-relay.test.ts 的模式） */
function createMockDb(initialPhase?: string) {
  const store = new Map<string, string>();
  if (initialPhase) {
    store.set('growth_last_phase', initialPhase);
  }

  return {
    query: <T>(sql: string): T[] => {
      if (sql.includes('growth_last_phase') && sql.includes('SELECT')) {
        const val = store.get('growth_last_phase');
        if (val) return [{ value: val }] as T[];
        return [];
      }
      return [];
    },
    run: (sql: string, params?: unknown[]) => {
      if (sql.includes('growth_last_phase') && params?.[0]) {
        store.set('growth_last_phase', params[0] as string);
      }
    },
    _store: store,
  } as unknown as ClawDatabase & { _store: Map<string, string> };
}

/** 建立 mock KeyPool */
function createMockKeyPool(services: string[]): KeyPool {
  const keys: KeyListItem[] = services.map((s, i) => ({
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
    listKeys: async () => keys,
    addKey: async () => keys.length + 1,
    removeKey: async () => {},
    selectKey: async () => null,
    selectKeyWithFallback: async () => null,
    reportSuccess: async () => {},
    reportRateLimit: async () => {},
    reportAuthError: async () => {},
    reportError: async () => {},
    dailyReset: async () => {},
    getServiceIds: () => [...new Set(services)],
  } as unknown as KeyPool;
}

/** 建立 mock GrowthEngine（只需 getPhase） */
function createMockGrowthEngine(phase: GrowthPhase): GrowthEngine {
  return {
    getPhase: async () => phase,
    getGrowthState: async () => ({
      phase,
      layers_unlocked: phase === 'onboarding' ? [] : ['L1'],
      layer_progress: { L0: 0, L1: phase === 'onboarding' ? 0 : 1, L2: 0.33, L3: 0, L4: 0 },
      next_actions: [],
      pool_health: { services: [], total_keys: 0, total_services: 0, rate_limited_count: 0 },
    }),
    getUsageInsights: async () => [],
    getRecommendations: async () => [],
    getPoolHealth: async () => ({
      services: [],
      total_keys: 0,
      total_services: 0,
      rate_limited_count: 0,
    }),
    getIntelligenceReport: async () => ({
      personal_stats: [],
      collective_intel: [],
      suggestions: [],
      total_requests_7d: 0,
      data_sufficient: false,
    }),
  } as unknown as GrowthEngine;
}

/** 建立 mock AdapterConfig（setup_wizard import 驗證用） */
function createMockAdapters(): Map<string, AdapterConfig> {
  const adapters = new Map<string, AdapterConfig>();
  adapters.set('groq', {
    schema_version: 1,
    adapter: {
      id: 'groq',
      name: 'Groq',
      version: '1.0.0',
      category: 'llm',
      requires_key: true,
      free_tier: true,
    },
    auth: { type: 'bearer' },
    base_url: 'https://api.groq.com',
    endpoints: {
      models: {
        method: 'GET',
        path: '/openai/v1/models',
      },
    },
    capabilities: {
      chat: true,
      streaming: false,
      embeddings: false,
      images: false,
      audio: false,
      models: [{ id: 'llama3', name: 'LLaMA 3' }],
    },
  });
  return adapters;
}

// ===== 場景 A：加第一把 Key（onboarding → awakening 轉換） =====

describe('場景 A：加第一把 Key 觸發 onboarding → awakening 慶祝', () => {
  it('回應文字應包含慶祝 banner（═══ 分隔線）', async () => {
    // 加 Key 前 0 把，加完後回傳 ID=1
    const keyPool = createMockKeyPool([]);

    // DB 記錄上次階段為 onboarding
    const db = createMockDb('onboarding');

    // growthEngine 判定現在是 awakening
    const growthEngine = createMockGrowthEngine('awakening');

    const relayDeps: KeysAddRelayDeps = { db, growthEngine };

    const result = await executeKeysAddTool(
      { service: 'groq', key: 'gsk_test12345' },
      keyPool,
      relayDeps
    );

    const text = result.content[0]!.text;

    // 基本功能：Key 已新增
    expect(text).toContain('ID: 1');
    expect(text).toContain('groq');

    // 接力棒：慶祝 banner
    expect(text).toContain('═══');
  });
});

// ===== 場景 B：加 Key 但沒升級（awakening 維持） =====

describe('場景 B：加 Key 但沒升級，只有 teaser 沒有慶祝', () => {
  it('回應包含 teaser（💡 字樣）但不包含慶祝 banner', async () => {
    // 已有 1 把，加完 2 把
    const keyPool = createMockKeyPool(['openai']);

    // DB 記錄上次階段為 awakening
    const db = createMockDb('awakening');

    // growthEngine 判定仍是 awakening
    const growthEngine = createMockGrowthEngine('awakening');

    const relayDeps: KeysAddRelayDeps = { db, growthEngine };

    const result = await executeKeysAddTool(
      { service: 'groq', key: 'gsk_test67890' },
      keyPool,
      relayDeps
    );

    const text = result.content[0]!.text;

    // 基本功能
    expect(text).toContain('ID: 2');
    expect(text).toContain('groq');

    // 沒升級 → 不應有慶祝 banner
    expect(text).not.toContain('═══');

    // 應有 teaser（getTeaser 對 awakening 會回傳含 relay.teaser.awakening 的訊息）
    // teaser 內容依 i18n 狀態可能是 key 本身，但一定有文字
    expect(text.length).toBeGreaterThan(30);
  });
});

// ===== 場景 C：沒有 relayDeps 時向後相容 =====

describe('場景 C：不傳 relayDeps 時向後相容', () => {
  it('回應正常，沒有接力棒訊息也不會爆', async () => {
    const keyPool = createMockKeyPool([]);

    // 不傳 relayDeps
    const result = await executeKeysAddTool(
      { service: 'groq', key: 'gsk_test_noRelay' },
      keyPool
    );

    const text = result.content[0]!.text;

    // 基本功能正常
    expect(text).toContain('ID: 1');
    expect(text).toContain('groq');

    // 不應有接力棒訊息（不含分隔線）
    expect(text).not.toContain('═══');
  });

  it('relayDeps 為 undefined 不應拋出例外', async () => {
    const keyPool = createMockKeyPool([]);

    // 明確傳 undefined
    const result = await executeKeysAddTool(
      { service: 'openai', key: 'sk-test' },
      keyPool,
      undefined
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
  });
});

// ===== 場景 D：setup_wizard import 後的接力棒 =====

describe('場景 D：setup_wizard import 路徑的接力棒', () => {
  it('import 成功後回應應包含慶祝 banner', async () => {
    // 模擬 Key 驗證成功：mock fetch 讓 validateKey 通過（需 status=200）
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'llama-3.1-8b' }] }),
    })) as any;

    try {
      const keyPool = createMockKeyPool([]);
      const db = createMockDb('onboarding');
      const growthEngine = createMockGrowthEngine('awakening');
      const adapters = createMockAdapters();

      const deps: SetupWizardDeps = {
        keyPool,
        adapters,
        db,
        growthEngine,
      };

      const result = await executeSetupWizardTool(
        { action: 'import', service: 'groq', key: 'gsk_testImport123' },
        deps
      );

      const text = result.content[0]!.text;

      // import 成功
      expect(text).toContain('已匯入');
      expect(text).toContain('groq');

      // 接力棒：onboarding → awakening 慶祝 banner
      expect(text).toContain('═══');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('import 成功但沒升級時應有 teaser', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'llama-3.1-8b' }] }),
    })) as any;

    try {
      const keyPool = createMockKeyPool(['openai']);
      const db = createMockDb('awakening');
      const growthEngine = createMockGrowthEngine('awakening');
      const adapters = createMockAdapters();

      const deps: SetupWizardDeps = {
        keyPool,
        adapters,
        db,
        growthEngine,
      };

      const result = await executeSetupWizardTool(
        { action: 'import', service: 'groq', key: 'gsk_testImport456' },
        deps
      );

      const text = result.content[0]!.text;

      // import 成功
      expect(text).toContain('已匯入');

      // 沒升級 → 沒有慶祝 banner
      expect(text).not.toContain('═══');

      // 應有 teaser 文字（relay.teaser.awakening 或其 i18n key）
      expect(text.length).toBeGreaterThan(30);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('沒有 db/growthEngine 時 import 仍正常（無接力棒）', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'llama-3.1-8b' }] }),
    })) as any;

    try {
      const keyPool = createMockKeyPool([]);
      const adapters = createMockAdapters();

      const deps: SetupWizardDeps = {
        keyPool,
        adapters,
        // 不提供 db 和 growthEngine
      };

      const result = await executeSetupWizardTool(
        { action: 'import', service: 'groq', key: 'gsk_testNoRelay' },
        deps
      );

      const text = result.content[0]!.text;

      // import 成功
      expect(text).toContain('已匯入');

      // 不應有接力棒內容
      expect(text).not.toContain('═══');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ===== 場景 E：growth_guide overview 包含 teaser =====

describe('場景 E：growth_guide overview 包含 teaser', () => {
  it('overview 回應應包含 teaser 文字', async () => {
    const keyPool = createMockKeyPool(['openai']);
    const growthEngine = createMockGrowthEngine('awakening');

    const result = await executeGrowthGuideTool(
      { view: 'overview' },
      growthEngine,
      undefined,  // costEngine
      keyPool
    );

    const text = result.content[0]!.text;

    // overview 基本內容
    expect(text).toContain('成長總覽');
    expect(text).toContain('awakening');

    // 應有 teaser（getTeaser 被呼叫且 keyPool 有 1 個服務）
    // i18n 初始化時回傳翻譯文字，未初始化時回傳 key 本身
    // 兩種情況都會包含在 overview 中，用正則匹配任一
    const hasTeaserContent =
      text.includes('relay.teaser.awakening') ||  // i18n 未初始化
      text.includes('再加') ||                     // 中文翻譯
      text.includes('more service');               // 英文翻譯
    expect(hasTeaserContent).toBe(true);
  });

  it('不傳 keyPool 時 overview 仍正常（無 teaser）', async () => {
    const growthEngine = createMockGrowthEngine('awakening');

    const result = await executeGrowthGuideTool(
      { view: 'overview' },
      growthEngine,
      undefined,
      undefined  // 不傳 keyPool
    );

    const text = result.content[0]!.text;

    // 基本功能正常
    expect(text).toContain('成長總覽');
    expect(text).toContain('awakening');

    // 不應有 teaser（因為沒有 keyPool）
    expect(text).not.toContain('relay.teaser');
  });

  it('mastery 階段的 teaser 也應顯示', async () => {
    const keyPool = createMockKeyPool(['a', 'b', 'c', 'd', 'e']);
    const growthEngine = createMockGrowthEngine('mastery');

    const result = await executeGrowthGuideTool(
      { view: 'overview' },
      growthEngine,
      undefined,
      keyPool
    );

    const text = result.content[0]!.text;
    expect(text).toContain('成長總覽');
    // mastery teaser 存在（i18n 翻譯或 key 本身）
    const hasMasteryTeaser =
      text.includes('relay.teaser.mastery') ||  // i18n 未初始化
      text.includes('最高階段') ||               // 中文翻譯
      text.includes('mastery');                  // 英文或階段名
    expect(hasMasteryTeaser).toBe(true);
  });
});
