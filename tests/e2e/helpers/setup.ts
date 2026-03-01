// E2E 測試共用設定
// 建立 Engine + VPS 的 Hono app 實例，提供方便的請求輔助函式
// 所有依賴使用 in-memory mock，不啟動真實 server

import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';

// ===== VPS 端 =====
import { createServer as createVPSServer } from '../../../apps/vps/src/server';
import type { ServerDependencies as VPSServerDeps } from '../../../apps/vps/src/server';
import { VPSDatabase } from '../../../apps/vps/src/storage/database';
import { VPSKeyManager } from '../../../apps/vps/src/core/ecdh';
import { clearRateLimitStore, clearIpDeviceRegistry } from '../../../apps/vps/src/middleware/rate-limiter';
import type { IntelligenceEngine } from '../../../apps/vps/src/services/intelligence-engine';
import type { AnomalyDetector } from '../../../apps/vps/src/services/anomaly-detector';
import type { AidEngine } from '../../../apps/vps/src/services/aid-engine';
import type { L0Manager as VPSL0Manager } from '../../../apps/vps/src/services/l0-manager';
import type { SubKeyValidator } from '../../../apps/vps/src/services/subkey-validator';
import type { WebSocketManager } from '../../../apps/vps/src/ws/manager';

// ===== Engine 端 =====
import { ClawEngineServer } from '../../../apps/engine/src/server';
import { EngineAuth } from '../../../apps/engine/src/core/auth';
import type { Router } from '../../../apps/engine/src/core/router';
import type { KeyPool } from '../../../apps/engine/src/core/key-pool';
import type { AdapterConfig } from '../../../apps/engine/src/adapters/loader';
import type { ClawDatabase } from '../../../apps/engine/src/storage/database';
import type { WriteBuffer } from '../../../apps/engine/src/storage/write-buffer';
import type { ManagementOptions } from '../../../apps/engine/src/server';
import type { SubKeyManager } from '../../../apps/engine/src/sharing/sub-key';
import type { AidClient } from '../../../apps/engine/src/sharing/mutual-aid';
import type { AdapterLoader } from '../../../apps/engine/src/adapters/loader';
import type { TelemetryCollector } from '../../../apps/engine/src/intelligence/telemetry';
import type { L0Manager as EngineL0Manager } from '../../../apps/engine/src/l0/manager';
import type { ClawConfig } from '../../../apps/engine/src/core/config';
import { mock } from 'bun:test';

// ===== 型別定義 =====

/** VPS App 包裝（含 Hono app 和依賴） */
export interface VPSApp {
  app: Hono;
  db: VPSDatabase;
  keyManager: VPSKeyManager;
  deps: VPSServerDeps;
}

/** Engine App 包裝（含 Hono app 和依賴） */
export interface EngineApp {
  app: Hono;
  auth: EngineAuth;
  token: string;
  mockRouter: Router;
  mockKeyPool: KeyPool;
  mockDb: ClawDatabase;
}

/** 註冊裝置後的結果 */
export interface RegisteredDevice {
  device_id: string;
  device_token: string;
  vps_public_key: string;
  vps_public_key_id: string;
  assigned_region: string;
  expires_at: string;
}

// ===== VPS App 建立 =====

/** 建立 VPS Hono app（in-memory SQLite + mock 依賴） */
export async function createVPSApp(): Promise<VPSApp> {
  // 清空全域 rate limit 狀態，避免跨測試污染
  clearRateLimitStore();
  clearIpDeviceRegistry();

  const db = new VPSDatabase(':memory:');
  await db.init();

  const keyManager = new VPSKeyManager(db);
  await keyManager.init();

  // Mock IntelligenceEngine
  const intelligenceEngine = {
    coldStart: async () => ({ recommendations_loaded: 0, source: 'empty' as const }),
    runHourlyAnalysis: async () => ({ recommendations_generated: 0, alerts_fired: 0, services_analyzed: 0 }),
    getRouteSuggestions: () => [],
    handleFeedback: async () => ({ success: true }),
    receiveBatch: async () => ({
      success: true,
      batch_id: `batch_${Date.now()}`,
      entries_stored: 5,
      reputation_weight: 1.0,
    }),
    startHourlyAnalysis: () => {},
    stopHourlyAnalysis: () => {},
  } as unknown as IntelligenceEngine;

  // Mock AnomalyDetector
  const anomalyDetector = {
    detect: () => ({ deviceId: 'test', hasAnomaly: false, reasons: [], action: 'none' as const }),
  } as unknown as AnomalyDetector;

  // Mock AidEngine
  const aidEngine = {
    handleRequest: async (_deviceId: string, _body: unknown) => ({
      ok: true,
      aid_id: `aid_${randomBytes(8).toString('hex')}`,
    }),
    updateConfig: async (_deviceId: string, _body: unknown) => ({
      ok: true,
      config: { enabled: true, allowed_services: null, daily_limit: 30 },
    }),
    getConfig: (_deviceId: string) => ({
      enabled: false,
      allowed_services: null,
      daily_limit: 30,
      blackout_hours: [],
    }),
    relayAidData: async () => ({ ok: true }),
    getStats: (_deviceId: string) => ({
      total_given: 0,
      total_received: 0,
      daily_given: 0,
      daily_limit: 30,
      reputation_score: 1.0,
    }),
  } as unknown as AidEngine;

  // Mock VPS L0Manager
  const l0Manager = {
    getKeys: () => [
      {
        l0_key_id: 'l0_test_1',
        service_id: 'groq',
        status: 'active',
        key_encrypted: 'encrypted_key_data',
        iv: 'test_iv',
        tag: 'test_tag',
        model_whitelist: ['llama3'],
        created_at: new Date().toISOString(),
      },
    ],
    getDeviceLimits: () => ({ groq: 10 }),
    prepareForDownload: (r: unknown) => r,
    handleDonate: async () => ({
      accepted: true,
      l0_key_id: 'l0_donated_1',
      message: '捐贈成功',
      validation: { key_valid: true, service_confirmed: 'groq', estimated_daily_quota: 100 },
    }),
    reportUsage: async () => ({ updated: 1 }),
    checkHealth: async () => ({ checked: 0, updated: 0, warnings: 0 }),
    init: async () => {},
  } as unknown as VPSL0Manager;

  // Mock SubKeyValidator
  const subKeyValidator = {
    validate: async (subKey: string, _serviceId: string) => {
      // 模擬：以 sk_live_ 開頭且長度足夠的算有效
      if (subKey.startsWith('sk_live_') && subKey.length > 20) {
        return {
          valid: true,
          permissions: { models: null, rate_limit: null, rate_remaining: null, expires_at: null },
        };
      }
      return { valid: false };
    },
  } as unknown as SubKeyValidator;

  // Mock WebSocketManager
  const wsManager = {
    getOnlineCount: () => 0,
    validateUpgrade: async () => ({ ok: false, status: 401, errorCode: 'WS_AUTH_FAILED' }),
    broadcastToChannel: () => {},
    broadcastNotification: () => {},
    broadcastToRegion: () => {},
  } as unknown as WebSocketManager;

  // 設定測試用 ADMIN_TOKEN
  process.env['ADMIN_TOKEN'] = 'test-admin-token-e2e';

  const deps: VPSServerDeps = {
    db,
    keyManager,
    intelligenceEngine,
    anomalyDetector,
    aidEngine,
    l0Manager,
    subKeyValidator,
    wsManager,
  };

  const app = createVPSServer(deps);

  return { app, db, keyManager, deps };
}

// ===== Engine App 建立 =====

/** 建立 Engine Hono app（mock 所有依賴） */
export async function createEngineApp(overrides?: {
  mockRouter?: Partial<Router>;
  mockKeyPool?: Partial<KeyPool>;
  withManagement?: boolean;
}): Promise<EngineApp> {
  // Mock Database
  const mockDb = {
    init: mock(async () => undefined),
    close: mock(async () => undefined),
    query: mock(() => []),
    run: mock(() => ({ changes: 0, lastInsertRowid: 0 })),
    transaction: mock((fn: () => unknown) => fn()),
    checkpoint: mock(() => undefined),
    dailyReset: mock(() => undefined),
    exec: mock(() => undefined),
  } as unknown as ClawDatabase;

  // Mock Auth
  const tmpDir = `/tmp/clawapi-e2e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const auth = new EngineAuth(mockDb, tmpDir);
  await auth.initToken(tmpDir);
  const token = auth.getToken();

  // Mock Router
  const routerMock = {
    routeRequest: mock(async (req: { model: string; params: Record<string, unknown> }) => {
      // 模擬根據 model 欄位返回結果
      const model = req.model;
      const isL1 = model.includes('/');
      return {
        success: true,
        layer: isL1 ? ('L1' as const) : ('L2' as const),
        serviceId: isL1 ? model.split('/')[0] : 'groq',
        modelName: isL1 ? model.split('/')[1] : model,
        data: {
          id: `chatcmpl-${Date.now()}`,
          choices: [
            {
              message: { role: 'assistant', content: `回應 ${model}` },
              finish_reason: 'stop',
              index: 0,
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
        latency_ms: 50,
      };
    }),
    updateCollectiveIntel: mock(() => undefined),
    ...(overrides?.mockRouter ?? {}),
  } as unknown as Router;

  // Mock KeyPool
  const keyPoolMock = {
    getServiceIds: mock(() => ['groq', 'openai']),
    selectKey: mock(async () => null),
    listKeys: mock(async () => []),
    addKey: mock(async () => 1),
    removeKey: mock(async () => undefined),
    selectKeyWithFallback: mock(async () => null),
    reportSuccess: mock(async () => undefined),
    reportRateLimit: mock(async () => undefined),
    reportAuthError: mock(async () => undefined),
    reportError: mock(async () => undefined),
    dailyReset: mock(async () => undefined),
    ...(overrides?.mockKeyPool ?? {}),
  } as unknown as KeyPool;

  // Mock Adapters
  const adapters = new Map<string, AdapterConfig>([
    [
      'groq',
      {
        schema_version: 1,
        adapter: { id: 'groq', name: 'Groq', version: '1.0.0', category: 'llm', requires_key: true },
        auth: { type: 'bearer' },
        base_url: 'https://api.groq.com',
        endpoints: { chat: { method: 'POST', path: '/v1/chat/completions', response_type: 'json' } },
        capabilities: {
          chat: true, streaming: true, embeddings: false, images: false, audio: false,
          models: [{ id: 'llama3', name: 'LLaMA 3' }],
        },
      } as AdapterConfig,
    ],
  ]);

  // Mock WriteBuffer
  const writeBuffer = {
    start: mock(() => undefined),
    stop: mock(async () => undefined),
    flush: mock(async () => undefined),
    enqueue: mock(() => undefined),
    queue: [],
    maxSize: 100,
    flushInterval: 5000,
  } as unknown as WriteBuffer;

  // 管理選項（若有需要）
  let mgmtOptions: ManagementOptions | undefined;
  if (overrides?.withManagement) {
    mgmtOptions = {
      subKeyManager: {
        issue: mock(async (params: { label: string }) => ({
          id: 1,
          label: params.label,
          token: `sk_live_00000000_${globalThis.crypto.randomUUID()}`,
          is_active: true,
          daily_limit: null,
          daily_used: 0,
          allowed_services: null,
          allowed_models: null,
          rate_limit_per_hour: null,
          rate_used_this_hour: 0,
          expires_at: null,
          created_at: new Date().toISOString(),
          last_used_at: null,
          total_requests: 0,
          total_tokens: 0,
        })),
        validate: mock(async () => ({ valid: true, subKeyId: 1 })),
        revoke: mock(async () => true),
        list: mock(async () => []),
        listActive: mock(async () => []),
        recordUsage: mock(async () => undefined),
        handleVPSValidation: mock(async () => ({ valid: true })),
      } as unknown as SubKeyManager,
      aidClient: {
        requestAid: mock(async () => ({ success: false, error: 'stub', aid_id: '' })),
        updateConfig: mock(async () => undefined),
        getStats: mock(async () => ({
          total_given: 0, total_received: 0, daily_given: 0, daily_limit: 30,
        })),
        handleIncomingAidRequest: mock(async () => undefined),
        getCooldownRemaining: mock(() => 0),
        getConsecutiveFailures: mock(() => 0),
        resetCooldown: mock(() => undefined),
      } as unknown as AidClient,
      adapterLoader: {
        loadAll: mock(async () => new Map()),
        loadById: mock(async () => null),
        installFromUrl: mock(async () => ({ success: false })),
        listInstalled: mock(() => []),
      } as unknown as AdapterLoader,
      telemetry: {
        recordEvent: mock(() => undefined),
        getSummary: mock(() => ({
          totalEvents: 0,
          pendingBatches: 0,
          lastUploadAt: null,
        })),
        flush: mock(async () => undefined),
        start: mock(() => undefined),
        stop: mock(() => undefined),
      } as unknown as TelemetryCollector,
      l0Manager: {
        selectKey: mock(() => ({ key: null, source: 'none', reason: '測試模式' })),
        getCachedKeyCount: mock(() => 0),
        getDailyLimit: mock(() => null),
        getLastFetchedAt: mock(() => 0),
        refresh: mock(async () => undefined),
        start: mock(async () => undefined),
        stop: mock(() => undefined),
        isCacheExpired: mock(() => false),
        recordUsage: mock(() => undefined),
        _setCache: mock(() => undefined),
        _setDailyLimits: mock(() => undefined),
      } as unknown as EngineL0Manager,
      getConfig: () => ({
        server: { port: 4141, host: '127.0.0.1', auto_port: true },
        routing: {
          default_strategy: 'smart' as const,
          failover_enabled: true,
          max_retries_per_key: 1,
          timeout: { l1: 30000, l2: 30000, l3: 60000, l4_step: 60000, l4_total: 300000 },
        },
        gold_key: { reserve_percent: 5, default_model: null, prompt: { l3: null, l4: null } },
        telemetry: { enabled: true, upload_interval_ms: 3600000, max_pending_days: 30 },
        l0: { enabled: true, ollama_auto_detect: true, ollama_url: 'http://localhost:11434' },
        aid: { enabled: false, allowed_services: null, daily_limit: 50, blackout_hours: [] },
        vps: { enabled: true, base_url: 'https://api.clawapi.com', websocket_url: 'wss://api.clawapi.com/v1/ws' },
        ui: { theme: 'system' as const, locale: 'zh-TW' as const },
        logging: { level: 'info' as const, retention_days: 30 },
        backup: { auto_interval_hours: null },
        notifications: { key_dead: true, quota_low: true, key_expiring: true, service_degraded: true },
        advanced: { db_path: null, adapter_dirs: [null], max_keys_per_service: 5, user_agent: 'ClawAPI/0.1.0' },
      }) as ClawConfig,
      updateConfig: async () => {},
    };
  }

  const server = new ClawEngineServer(
    routerMock,
    keyPoolMock,
    auth,
    adapters,
    mockDb,
    writeBuffer,
    { port: 19999 },
    mgmtOptions,
  );

  const app = server.getApp();

  return { app, auth, token, mockRouter: routerMock, mockKeyPool: keyPoolMock, mockDb };
}

// ===== 輔助函式 =====

/** 產生有效的 device_id（clw_ + 32 hex） */
export function generateDeviceId(): string {
  return `clw_${randomBytes(16).toString('hex')}`;
}

/** 快速在 VPS 上註冊一個裝置，回傳完整資訊 */
export async function registerDevice(
  vpsApp: Hono,
  deviceId?: string,
  fingerprint?: string,
): Promise<RegisteredDevice> {
  const id = deviceId ?? generateDeviceId();
  const fp = fingerprint ?? `fp_test_${randomBytes(4).toString('hex')}`;

  const res = await vpsApp.request('/v1/devices/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: id,
      device_fingerprint: fp,
      client_version: '0.1.0',
      os: 'darwin',
      arch: 'arm64',
      locale: 'zh-TW',
      timezone: 'Asia/Taipei',
    }),
  });

  if (res.status !== 200) {
    const body = await res.json();
    throw new Error(`裝置註冊失敗（${res.status}）：${JSON.stringify(body)}`);
  }

  return (await res.json()) as RegisteredDevice;
}

/** 帶 device auth headers 發 VPS 請求 */
export async function makeVPSRequest(
  vpsApp: Hono,
  method: string,
  path: string,
  device: RegisteredDevice,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Id': device.device_id,
    'X-Device-Token': device.device_token,
    ...(extraHeaders ?? {}),
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return vpsApp.request(path, init);
}

/** 帶 auth.token 發 Engine 請求 */
export async function makeEngineRequest(
  engineApp: Hono,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(extraHeaders ?? {}),
  };

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return engineApp.fetch(new Request(`http://localhost${path}`, init));
}
