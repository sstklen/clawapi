// 管理 API 路由測試
// 使用 Mock 依賴，不啟動真實 server 和 DB

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// Mock 加密模組 — 測試環境沒有 Master Key，需要 mock getCrypto()
// 必須在 import management 之前呼叫
mock.module('../../core/encryption', () => ({
  getCrypto: () => ({
    encrypt: (plaintext: string) => new TextEncoder().encode(`encrypted:${plaintext}`),
    decrypt: (ciphertext: Uint8Array) => new TextDecoder().decode(ciphertext).replace('encrypted:', ''),
  }),
  createCrypto: () => ({
    encrypt: (plaintext: string) => new TextEncoder().encode(`encrypted:${plaintext}`),
    decrypt: (ciphertext: Uint8Array) => new TextDecoder().decode(ciphertext).replace('encrypted:', ''),
  }),
}));

import { createManagementRouter } from '../management';
import type { ManagementDeps } from '../management';
import type { KeyPool, KeyListItem } from '../../core/key-pool';
import type { SubKeyManager, SubKey } from '../../sharing/sub-key';
import type { AidClient } from '../../sharing/mutual-aid';
import type { AdapterLoader, AdapterConfig } from '../../adapters/loader';
import type { TelemetryCollector } from '../../intelligence/telemetry';
import type { L0Manager } from '../../l0/manager';
import type { ClawDatabase } from '../../storage/database';
import type { ClawConfig } from '../../core/config';
import { getDefaultConfig } from '../../core/config';
import { CLAWAPI_VERSION } from '@clawapi/protocol';

// ===== Mock 工廠 =====

/** 建立遮罩版 Key 清單 */
function makeMockKeyList(): KeyListItem[] {
  return [
    {
      id: 1,
      service_id: 'groq',
      key_masked: 'gsk_****7890',
      pool_type: 'king',
      label: '主要 Key',
      status: 'active',
      priority: 0,
      pinned: false,
      daily_used: 100,
      consecutive_failures: 0,
      rate_limit_until: null,
      last_success_at: '2026-03-01T12:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 2,
      service_id: 'openai',
      key_masked: 'sk-****abcd',
      pool_type: 'friend',
      label: null,
      status: 'rate_limited',
      priority: 0,
      pinned: true,
      daily_used: 50,
      consecutive_failures: 1,
      rate_limit_until: '2026-03-01T13:00:00Z',
      last_success_at: '2026-03-01T11:00:00Z',
      created_at: '2026-02-01T00:00:00Z',
    },
  ];
}

/** 建立 Mock KeyPool */
function createMockKeyPool(): KeyPool {
  return {
    listKeys: mock(async () => makeMockKeyList()),
    addKey: mock(async () => 3),
    removeKey: mock(async () => undefined),
    selectKey: mock(async () => null),
    selectKeyWithFallback: mock(async () => null),
    reportSuccess: mock(async () => undefined),
    reportError: mock(async () => undefined),
    reportRateLimit: mock(async () => undefined),
    reportAuthError: mock(async () => undefined),
    dailyReset: mock(async () => undefined),
    getServiceIds: mock(() => ['groq', 'openai']),
  } as unknown as KeyPool;
}

/** 建立 Mock SubKeyManager */
function createMockSubKeyManager(): SubKeyManager {
  const mockSubKey: SubKey = {
    id: 1,
    label: '測試 Sub-Key',
    token: 'sk_live_00000000_12345678-1234-1234-1234-123456789012',
    is_active: true,
    daily_limit: 100,
    daily_used: 5,
    allowed_services: null,
    allowed_models: null,
    rate_limit_per_hour: null,
    rate_used_this_hour: 0,
    expires_at: null,
    created_at: '2026-01-01T00:00:00Z',
    last_used_at: '2026-03-01T12:00:00Z',
    total_requests: 50,
    total_tokens: 1200,
  };

  return {
    issue: mock(async () => mockSubKey),
    list: mock(async () => [mockSubKey]),
    listActive: mock(async () => [mockSubKey]),
    revoke: mock(async (id: number) => id === 1),
    validate: mock(async () => ({ valid: true, subKeyId: 1 })),
    recordUsage: mock(async () => undefined),
    handleVPSValidation: mock(async () => ({ valid: true })),
  } as unknown as SubKeyManager;
}

/** 建立 Mock AidClient */
function createMockAidClient(): AidClient {
  return {
    updateConfig: mock(async () => undefined),
    getStats: mock(async () => ({
      total_given: 10,
      total_received: 5,
      daily_given: 2,
      daily_received: 1,
    })),
    requestAid: mock(async () => ({ success: false, aid_id: '' })),
    handleIncomingAidRequest: mock(async () => undefined),
    getCooldownRemaining: mock(() => 0),
    getConsecutiveFailures: mock(() => 0),
    resetCooldown: mock(() => undefined),
  } as unknown as AidClient;
}

/** 建立 Mock AdapterLoader */
function createMockAdapterLoader(): AdapterLoader {
  return {
    loadFromFile: mock(async (path: string) => {
      if (path === 'fail') throw new Error('找不到檔案');
      return {
        schema_version: 1,
        adapter: { id: 'test-adapter', name: 'Test', version: '1.0.0', category: 'llm', requires_key: true },
        auth: { type: 'bearer' },
        base_url: 'https://api.test.com',
        endpoints: {},
        capabilities: { chat: true, streaming: true, embeddings: false, images: false, audio: false, models: [] },
      } as AdapterConfig;
    }),
    loadFromDirectory: mock(async () => new Map()),
    validate: mock((config: unknown) => config as AdapterConfig),
  } as unknown as AdapterLoader;
}

/** 建立 Mock TelemetryCollector */
function createMockTelemetry(): TelemetryCollector {
  return {
    buildBatch: mock(async () => null),
    uploadBatch: mock(async () => true),
    recordEvent: mock(async () => undefined),
    scheduleUpload: mock(() => undefined),
    stopSchedule: mock(() => undefined),
    uploadBacklog: mock(async () => undefined),
    submitFeedback: mock(async () => undefined),
    anonymizeServiceId: mock(async (id: string) => id),
  } as unknown as TelemetryCollector;
}

/** 建立 Mock L0Manager */
function createMockL0Manager(): L0Manager {
  return {
    getCachedKeyCount: mock(() => 3),
    getLastFetchedAt: mock(() => Date.now() - 1000 * 60 * 30),
    isCacheExpired: mock(() => false),
    selectKey: mock(() => ({ key: null, source: 'none' as const })),
    recordUsage: mock(() => undefined),
    getDailyLimit: mock(() => null),
    refresh: mock(async () => undefined),
    start: mock(async () => undefined),
    stop: mock(() => undefined),
    _setCache: mock(() => undefined),
    _setDailyLimits: mock(() => undefined),
  } as unknown as L0Manager;
}

/** 建立 Mock ClawDatabase */
function createMockDb(): ClawDatabase {
  return {
    query: mock(<T>(_sql: string, _params?: unknown[]) => [] as T[]),
    run: mock(() => ({ changes: 1, lastInsertRowid: 1 })),
    transaction: mock((fn: () => unknown) => fn()),
    checkpoint: mock(() => undefined),
    dailyReset: mock(() => undefined),
    init: mock(async () => undefined),
    close: mock(async () => undefined),
  } as unknown as ClawDatabase;
}

/** 建立 Mock Adapters Map */
function createMockAdapters(): Map<string, AdapterConfig> {
  const adapters = new Map<string, AdapterConfig>();

  adapters.set('groq', {
    schema_version: 1,
    adapter: { id: 'groq', name: 'Groq', version: '1.0.0', category: 'llm', requires_key: true },
    auth: { type: 'bearer' },
    base_url: 'https://api.groq.com',
    endpoints: { chat: { method: 'POST', path: '/v1/chat/completions' } },
    capabilities: {
      chat: true,
      streaming: true,
      embeddings: false,
      images: false,
      audio: false,
      models: [{ id: 'llama3', name: 'LLaMA 3' }],
    },
  } as AdapterConfig);

  return adapters;
}

/** 建立完整的 ManagementDeps */
function createMockDeps(overrides?: Partial<ManagementDeps>): ManagementDeps {
  let currentConfig: ClawConfig = getDefaultConfig();

  return {
    keyPool: createMockKeyPool(),
    subKeyManager: createMockSubKeyManager(),
    aidClient: createMockAidClient(),
    adapterLoader: createMockAdapterLoader(),
    telemetry: createMockTelemetry(),
    l0Manager: createMockL0Manager(),
    db: createMockDb(),
    adapters: createMockAdapters(),
    getConfig: () => currentConfig,
    updateConfig: mock(async (partial: Partial<ClawConfig>) => {
      currentConfig = { ...currentConfig, ...partial };
    }),
    startedAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * 建立測試用 Hono App
 */
function createTestApp(overrides?: Partial<ManagementDeps>): { app: Hono; deps: ManagementDeps } {
  const deps = createMockDeps(overrides);
  const app = new Hono();
  const mgmtRouter = createManagementRouter(deps);
  app.route('/api', mgmtRouter);
  return { app, deps };
}

/**
 * 輔助：發送 JSON 請求
 */
async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const requestInit: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }
  return app.fetch(new Request(`http://localhost${path}`, requestInit));
}

// ===== 測試套件 =====

// =========================================================
// GET /api/status
// =========================================================
describe('GET /api/status — 引擎狀態', () => {
  it('回傳狀態資訊', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'GET', '/api/status');

    expect(res.status).toBe(200);
    const json = await res.json() as {
      status: string;
      version: string;
      uptime_seconds: number;
      started_at: string;
    };

    expect(json.status).toBe('ok');
    expect(json.version).toBe(CLAWAPI_VERSION);
    expect(typeof json.uptime_seconds).toBe('number');
    expect(json.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof json.started_at).toBe('string');
  });
});

// =========================================================
// Keys CRUD 完整生命週期
// =========================================================
describe('Keys CRUD — 完整生命週期', () => {
  it('GET /api/keys — 列出所有 Key（遮罩版）', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'GET', '/api/keys');

    expect(res.status).toBe(200);
    const json = await res.json() as { keys: Array<{ id: number; key_masked: string; service_id: string }> };

    expect(Array.isArray(json.keys)).toBe(true);
    expect(json.keys.length).toBe(2);
    expect(typeof json.keys[0].id).toBe('number');
    expect(typeof json.keys[0].key_masked).toBe('string');
    expect(typeof json.keys[0].service_id).toBe('string');
  });

  it('POST /api/keys — 新增 Key', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/keys', {
      service_id: 'anthropic',
      key_value: 'sk-ant-abc123def456',
      pool_type: 'king',
      label: '測試 Key',
    });

    expect(res.status).toBe(201);
    const json = await res.json() as { success: boolean; id: number };
    expect(json.success).toBe(true);
    expect(typeof json.id).toBe('number');
  });

  it('POST /api/keys — 缺少 service_id → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/keys', { key_value: 'abc' });
    expect(res.status).toBe(400);
  });

  it('POST /api/keys — 缺少 key_value → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/keys', { service_id: 'groq' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/keys/1/pin — 釘選 Key', async () => {
    const mockDb = createMockDb();
    const { app } = createTestApp({ db: mockDb });

    const res = await req(app, 'PUT', '/api/keys/1/pin', { pinned: true });

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; pinned: boolean };
    expect(json.success).toBe(true);
    expect(json.pinned).toBe(true);
  });

  it('PUT /api/keys/1/pin — 取消釘選', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'PUT', '/api/keys/1/pin', { pinned: false });
    expect(res.status).toBe(200);
    const json = await res.json() as { pinned: boolean };
    expect(json.pinned).toBe(false);
  });

  it('DELETE /api/keys/1 — 刪除 Key', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'DELETE', '/api/keys/1');

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; id: number };
    expect(json.success).toBe(true);
    expect(json.id).toBe(1);
  });
});

// =========================================================
// Key 遮罩驗證
// =========================================================
describe('Key 遮罩驗證', () => {
  it('listKeys 回傳的 key_masked 格式正確（前綴 + **** + 後4碼）', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'GET', '/api/keys');
    const json = await res.json() as { keys: Array<{ key_masked: string }> };

    for (const key of json.keys) {
      // 遮罩格式：應包含 * 字符
      expect(key.key_masked).toContain('*');
    }

    // 第一個 Key 的遮罩應符合 gsk_****7890 格式
    expect(json.keys[0].key_masked).toBe('gsk_****7890');
  });

  it('rotate Key 後回傳新 id', async () => {
    // 模擬 DB 查詢到舊 Key
    const mockDb = createMockDb();
    mockDb.query = mock(<T>(_sql: string) => {
      return [{ service_id: 'groq', pool_type: 'king', label: '舊 Key' }] as T[];
    }) as typeof mockDb.query;

    const { app } = createTestApp({ db: mockDb });
    const res = await req(app, 'PUT', '/api/keys/1/rotate', {
      new_key_value: 'gsk_newkey12345678901234567890',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; old_id: number; new_id: number };
    expect(json.success).toBe(true);
    expect(json.old_id).toBe(1);
    expect(typeof json.new_id).toBe('number');
  });
});

// =========================================================
// Gold Keys CRUD
// =========================================================
describe('Gold Keys CRUD', () => {
  it('GET /api/gold-keys — 列出金鑰匙', async () => {
    const mockDb = createMockDb();
    mockDb.query = mock(<T>(_sql: string) => {
      return [{
        id: 1,
        service_id: 'openai',
        model_id: 'gpt-4o',
        is_active: 1,
        daily_used: 5,
        daily_limit: 100,
        created_at: '2026-01-01T00:00:00Z',
      }] as T[];
    }) as typeof mockDb.query;

    const { app } = createTestApp({ db: mockDb });
    const res = await req(app, 'GET', '/api/gold-keys');

    expect(res.status).toBe(200);
    const json = await res.json() as { gold_keys: Array<{ id: number; service_id: string; model_id: string }> };
    expect(Array.isArray(json.gold_keys)).toBe(true);
    expect(json.gold_keys[0].service_id).toBe('openai');
    expect(json.gold_keys[0].model_id).toBe('gpt-4o');
  });

  it('POST /api/gold-keys — 設定金鑰匙', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/gold-keys', {
      service_id: 'openai',
      key_value: 'sk-proj-abc123',
      model_id: 'gpt-4o',
      daily_limit: 100,
    });

    expect(res.status).toBe(201);
    const json = await res.json() as { success: boolean; id: number };
    expect(json.success).toBe(true);
  });

  it('POST /api/gold-keys — 缺少 model_id → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/gold-keys', {
      service_id: 'openai',
      key_value: 'sk-proj-abc123',
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/gold-keys/1 — 移除金鑰匙', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'DELETE', '/api/gold-keys/1');
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  it('DELETE /api/gold-keys/999 — 不存在時回傳 404', async () => {
    const mockDb = createMockDb();
    mockDb.run = mock(() => ({ changes: 0, lastInsertRowid: 0 })) as typeof mockDb.run;

    const { app } = createTestApp({ db: mockDb });
    const res = await req(app, 'DELETE', '/api/gold-keys/999');
    expect(res.status).toBe(404);
  });
});

// =========================================================
// Sub-Keys CRUD
// =========================================================
describe('Sub-Keys CRUD', () => {
  it('GET /api/sub-keys — 列出 Sub-Key（token 遮罩）', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'GET', '/api/sub-keys');

    expect(res.status).toBe(200);
    const json = await res.json() as { sub_keys: Array<{ id: number; label: string; token: string }> };

    expect(Array.isArray(json.sub_keys)).toBe(true);
    // Token 應該被遮罩
    const token = json.sub_keys[0].token;
    expect(token).toContain('*');
  });

  it('POST /api/sub-keys — 發行 Sub-Key', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/sub-keys', {
      label: '給老婆的 Key',
      daily_limit: 50,
    });

    expect(res.status).toBe(201);
    const json = await res.json() as { success: boolean; sub_key: { id: number; label: string } };
    expect(json.success).toBe(true);
    expect(json.sub_key.label).toBe('測試 Sub-Key'); // Mock 回傳固定值
  });

  it('POST /api/sub-keys — 缺少 label → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/sub-keys', { daily_limit: 50 });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/sub-keys/1 — 撤銷 Sub-Key', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'DELETE', '/api/sub-keys/1');

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  it('DELETE /api/sub-keys/999 — 不存在時回傳 404', async () => {
    const mockSubKeyManager = createMockSubKeyManager();
    mockSubKeyManager.revoke = mock(async () => false) as typeof mockSubKeyManager.revoke;

    const { app } = createTestApp({ subKeyManager: mockSubKeyManager });
    const res = await req(app, 'DELETE', '/api/sub-keys/999');
    expect(res.status).toBe(404);
  });

  it('GET /api/sub-keys/1/usage — 查詢用量', async () => {
    const mockDb = createMockDb();
    mockDb.query = mock(<T>(_sql: string, params?: unknown[]) => {
      const id = Array.isArray(params) ? params[0] : undefined;
      if (id === 1) {
        return [{
          id: 1,
          label: '測試 Key',
          daily_used: 5,
          daily_limit: 100,
          total_requests: 50,
          total_tokens: 1200,
          last_used_at: '2026-03-01T12:00:00Z',
          is_active: 1,
        }] as T[];
      }
      return [] as T[];
    }) as typeof mockDb.query;

    const { app } = createTestApp({ db: mockDb });
    const res = await req(app, 'GET', '/api/sub-keys/1/usage');

    expect(res.status).toBe(200);
    const json = await res.json() as {
      id: number;
      daily_used: number;
      total_requests: number;
      total_tokens: number;
    };
    expect(json.id).toBe(1);
    expect(json.daily_used).toBe(5);
    expect(json.total_requests).toBe(50);
    expect(json.total_tokens).toBe(1200);
  });

  it('GET /api/sub-keys/999/usage — 不存在時回傳 404', async () => {
    const { app } = createTestApp(); // mockDb.query 預設回傳 []
    const res = await req(app, 'GET', '/api/sub-keys/999/usage');
    expect(res.status).toBe(404);
  });
});

// =========================================================
// Logs 篩選功能
// =========================================================
describe('GET /api/logs — 日誌篩選', () => {
  it('回傳日誌清單結構', async () => {
    const mockDb = createMockDb();
    mockDb.query = mock(<T>(sql: string, params?: unknown[]) => {
      if (sql.includes('COUNT(*)')) {
        return [{ cnt: 0 }] as T[];
      }
      return [] as T[];
    }) as typeof mockDb.query;

    const { app } = createTestApp({ db: mockDb });
    const res = await req(app, 'GET', '/api/logs');

    expect(res.status).toBe(200);
    const json = await res.json() as {
      logs: unknown[];
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    };

    expect(Array.isArray(json.logs)).toBe(true);
    expect(typeof json.total).toBe('number');
    expect(typeof json.limit).toBe('number');
    expect(typeof json.offset).toBe('number');
    expect(typeof json.has_more).toBe('boolean');
  });

  it('service_id 篩選參數傳遞給 DB', async () => {
    const mockDb = createMockDb();
    const querySpy = mock((_sql: string, _params?: unknown[]) => {
      return [{ cnt: 0 }];
    }) as typeof mockDb.query;
    mockDb.query = querySpy;

    const { app } = createTestApp({ db: mockDb });
    await req(app, 'GET', '/api/logs?service_id=groq');

    // 確認 query 被呼叫
    expect((querySpy as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
  });

  it('GET /api/logs/export — 匯出 CSV', async () => {
    const mockDb = createMockDb();
    mockDb.query = mock(<T>() => [] as T[]) as typeof mockDb.query;

    const { app } = createTestApp({ db: mockDb });
    const res = await req(app, 'GET', '/api/logs/export');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
  });
});

// =========================================================
// Settings get/put
// =========================================================
describe('Settings GET/PUT', () => {
  it('GET /api/settings — 取得設定', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'GET', '/api/settings');

    expect(res.status).toBe(200);
    const json = await res.json() as { settings: ClawConfig };
    expect(json.settings).toBeDefined();
    expect(typeof json.settings.server.port).toBe('number');
  });

  it('PUT /api/settings — 更新設定', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'PUT', '/api/settings', {
      logging: { level: 'debug', retention_days: 7 },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  it('PUT /api/settings — 無效 JSON → 400', async () => {
    const { app } = createTestApp();
    const res = await app.fetch(new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    }));
    expect(res.status).toBe(400);
  });
});

// =========================================================
// Backup stubs 回 501
// =========================================================
describe('Backup stubs — 回傳 501', () => {
  it('POST /api/backup/export → 501', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/backup/export');

    expect(res.status).toBe(501);
    const json = await res.json() as { error: string; message: string };
    expect(json.error).toBe('not_implemented');
    expect(json.message).toContain('v1.1');
  });

  it('POST /api/backup/import → 501', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'POST', '/api/backup/import');

    expect(res.status).toBe(501);
    const json = await res.json() as { error: string; message: string };
    expect(json.error).toBe('not_implemented');
    expect(json.message).toContain('v1.1');
  });
});

// =========================================================
// Telemetry 設定
// =========================================================
describe('Telemetry 設定', () => {
  it('GET /api/telemetry/pending — 無待上報資料', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'GET', '/api/telemetry/pending');

    expect(res.status).toBe(200);
    const json = await res.json() as { pending: boolean };
    expect(json.pending).toBe(false);
  });

  it('PUT /api/telemetry/enabled — 開關遙測', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'PUT', '/api/telemetry/enabled', { enabled: false });

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; enabled: boolean };
    expect(json.success).toBe(true);
    expect(json.enabled).toBe(false);
  });

  it('PUT /api/telemetry/enabled — 缺少 enabled → 400', async () => {
    const { app } = createTestApp();
    const res = await req(app, 'PUT', '/api/telemetry/enabled', {});
    expect(res.status).toBe(400);
  });
});
