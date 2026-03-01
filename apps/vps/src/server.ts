// VPS API Gateway — Hono 主應用程式
// 整合所有 handler、middleware、路由掛載
// SPEC-C 全端點覆蓋

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { deviceAuth } from './middleware/auth';
import { rateLimiter } from './middleware/rate-limiter';

import { createDevicesRouter } from './handlers/devices';
import { createAuthGoogleRouter } from './handlers/auth-google';
import { createTelemetryRouter } from './handlers/telemetry';
import { createL0Router } from './handlers/l0';
import { createAidRouter } from './handlers/aid';
import { createSubKeysRouter } from './handlers/subkeys';
import { createAdminRouter } from './handlers/admin';
import { createVersionRouter } from './handlers/version';
import { createAdaptersRouter } from './handlers/adapters';
import { createBackupRouter } from './handlers/backup';

import type { VPSDatabase } from './storage/database';
import type { VPSKeyManager } from './core/ecdh';
import type { IntelligenceEngine } from './services/intelligence-engine';
import type { AnomalyDetector } from './services/anomaly-detector';
import type { AidEngine } from './services/aid-engine';
import type { L0Manager } from './services/l0-manager';
import type { SubKeyValidator } from './services/subkey-validator';
import type { WebSocketManager } from './ws/manager';
import type { AuthVariables } from './middleware/auth';

// ===== 服務依賴注入型別 =====
export interface ServerDependencies {
  db: VPSDatabase;
  keyManager: VPSKeyManager;
  intelligenceEngine: IntelligenceEngine;
  anomalyDetector: AnomalyDetector;
  aidEngine: AidEngine;
  l0Manager: L0Manager;
  subKeyValidator: SubKeyValidator;
  wsManager: WebSocketManager;
}

// ===== Rate Limit 表（SPEC-C §9，21 個端點）=====
// 供測試和文件參考，實際限制由 @clawapi/protocol 的 RATE_LIMITS 定義
export const RATE_LIMITS = {
  'POST /v1/devices/register': { limit: 5, windowMs: 3600000 },
  'POST /v1/devices/refresh': { limit: 10, windowMs: 3600000 },
  'POST /v1/devices/reset': { limit: 3, windowMs: 86400000 },
  'POST /v1/auth/google': { limit: 10, windowMs: 3600000 },
  'POST /v1/telemetry/batch': { limit: 2, windowMs: 3600000 },
  'POST /v1/telemetry/feedback': { limit: 20, windowMs: 3600000 },
  'GET /v1/telemetry/quota': { limit: 30, windowMs: 3600000 },
  'GET /v1/l0/keys': { limit: 10, windowMs: 3600000 },
  'POST /v1/l0/usage': { limit: 60, windowMs: 3600000 },
  'POST /v1/l0/donate': { limit: 5, windowMs: 86400000 },
  'POST /v1/aid/request': { limit: 30, windowMs: 3600000 },
  'PUT /v1/aid/config': { limit: 10, windowMs: 3600000 },
  'GET /v1/aid/config': { limit: 30, windowMs: 3600000 },
  'GET /v1/aid/stats': { limit: 30, windowMs: 3600000 },
  'GET /v1/version/check': { limit: 5, windowMs: 3600000 },
  'GET /v1/adapters/updates': { limit: 5, windowMs: 3600000 },
  'GET /v1/adapters/official': { limit: 10, windowMs: 3600000 },
  'PUT /v1/backup': { limit: 5, windowMs: 86400000 },
  'GET /v1/backup': { limit: 10, windowMs: 86400000 },
  'DELETE /v1/backup': { limit: 3, windowMs: 86400000 },
  'POST /v1/subkeys/validate': { limit: 60, windowMs: 3600000 },
} as const;

// ===== 建立 Hono 應用程式 =====
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createServer(deps: ServerDependencies): Hono<any> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // ─────────────────────────────────────────────────────────────────
  // 全域 middleware（套用順序很重要）
  // ─────────────────────────────────────────────────────────────────

  // 1. CORS — 允許龍蝦客戶端跨源請求
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-Device-Id',
        'X-Device-Token',
        'X-Device-Fingerprint',
        'X-Admin-Token',
        'X-Real-IP',
        'X-Forwarded-For',
      ],
      exposeHeaders: [
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
      ],
      maxAge: 86400,
    }),
  );

  // 2. HTTP 請求日誌
  app.use('*', logger());

  // 3. Rate Limiter — 依端點限流
  app.use('*', rateLimiter());

  // 4. Device Auth — 裝置身份驗證，只套在 /v1/* 路徑上
  // （/health, /admin/* 使用自己的認證機制）
  // SKIP_AUTH_PATHS 定義在 auth.ts：/v1/devices/register, /v1/subkeys/validate, /v1/ws, /health
  app.use('/v1/*', deviceAuth(deps.db));

  // ─────────────────────────────────────────────────────────────────
  // 公開端點：/health（不需要 deviceAuth，在 SKIP_AUTH_PATHS 中豁免）
  // ─────────────────────────────────────────────────────────────────
  // /health 由 adminRouter 處理，掛載在根路徑
  const adminRouter = createAdminRouter(
    deps.db,
    deps.keyManager,
    deps.l0Manager,
    deps.wsManager,
  );
  app.route('/', adminRouter);

  // ─────────────────────────────────────────────────────────────────
  // 裝置管理路由：/v1/devices
  // POST /v1/devices/register（公開，不需 deviceAuth）
  // POST /v1/devices/refresh（需 deviceAuth）
  // POST /v1/devices/reset（需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const devicesRouter = createDevicesRouter(deps.db, deps.keyManager);
  app.route('/v1/devices', devicesRouter);

  // ─────────────────────────────────────────────────────────────────
  // 認證路由：/v1/auth
  // POST /v1/auth/google（需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const authGoogleRouter = createAuthGoogleRouter(deps.db);
  app.route('/v1/auth/google', authGoogleRouter);

  // ─────────────────────────────────────────────────────────────────
  // 遙測路由：/v1/telemetry
  // POST /v1/telemetry/batch（需 deviceAuth）
  // GET  /v1/telemetry/route-suggestions（需 deviceAuth）
  // POST /v1/telemetry/feedback（需 deviceAuth）
  // GET  /v1/telemetry/quota（需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const telemetryRouter = createTelemetryRouter(
    deps.db,
    deps.intelligenceEngine,
    deps.anomalyDetector,
  );
  app.route('/v1/telemetry', telemetryRouter);

  // ─────────────────────────────────────────────────────────────────
  // L0 Key 路由：/v1/l0
  // GET  /v1/l0/keys（需 deviceAuth）
  // POST /v1/l0/donate（需 deviceAuth）
  // POST /v1/l0/usage（需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const l0Router = createL0Router(deps.db, deps.l0Manager);
  app.route('/v1/l0', l0Router);

  // ─────────────────────────────────────────────────────────────────
  // 互助路由：/v1/aid
  // POST /v1/aid/request（需 deviceAuth）
  // PUT  /v1/aid/config（需 deviceAuth）
  // GET  /v1/aid/config（需 deviceAuth）
  // POST /v1/aid/relay（需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const aidRouter = createAidRouter(deps.aidEngine);
  app.route('/v1/aid', aidRouter);

  // ─────────────────────────────────────────────────────────────────
  // Sub-Key 路由：/v1/subkeys
  // POST /v1/subkeys/validate（公開，不需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const subKeysRouter = createSubKeysRouter(deps.subKeyValidator);
  app.route('/v1/subkeys', subKeysRouter);

  // ─────────────────────────────────────────────────────────────────
  // 版本檢查路由：/v1/version
  // GET /v1/version/check（需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const versionRouter = createVersionRouter();
  app.route('/v1/version', versionRouter);

  // ─────────────────────────────────────────────────────────────────
  // Adapter 路由：/v1/adapters
  // GET /v1/adapters/official（需 deviceAuth）
  // GET /v1/adapters/updates（需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const adaptersRouter = createAdaptersRouter();
  app.route('/v1/adapters', adaptersRouter);

  // ─────────────────────────────────────────────────────────────────
  // Backup 路由：/v1/backup（所有端點為 stub，回 501）
  // PUT    /v1/backup（需 deviceAuth）
  // GET    /v1/backup（需 deviceAuth）
  // DELETE /v1/backup（需 deviceAuth）
  // ─────────────────────────────────────────────────────────────────
  const backupRouter = createBackupRouter();
  app.route('/v1/backup', backupRouter);

  // ─────────────────────────────────────────────────────────────────
  // WebSocket 端點：/v1/ws
  // 認證透過 ?device_id=&token=&version= 查詢參數
  // 升級邏輯由 WebSocketManager 處理
  // ─────────────────────────────────────────────────────────────────
  app.get('/v1/ws', async (c) => {
    // 取得 WebSocket 升級所需的參數
    const deviceId = c.req.query('device_id') ?? null;
    const token = c.req.query('token') ?? null;
    const version = c.req.query('version') ?? null;
    const clientIp =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown';

    // 驗證升級請求
    const validation = await deps.wsManager.validateUpgrade(deviceId, token, version, clientIp);
    if (!validation.ok) {
      const wsStatus = validation.status as 401 | 429;
      return c.json(
        { error: String(validation.errorCode), message: 'WebSocket 升級驗證失敗' },
        wsStatus,
      );
    }

    // 注意：實際的 WebSocket 升級由 Bun HTTP server 層處理
    // 這個 handler 僅用於驗證，實際升級流程在 index.ts 的 Bun.serve websocket handler 中
    return c.json({ message: '請直接連接 WebSocket 端點' }, 426);
  });

  // ─────────────────────────────────────────────────────────────────
  // 404 fallback
  // ─────────────────────────────────────────────────────────────────
  app.notFound((c) => {
    return c.json(
      {
        error: 'NOT_FOUND',
        message: `找不到路由：${c.req.method} ${c.req.path}`,
      },
      404,
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // 全域錯誤處理
  // ─────────────────────────────────────────────────────────────────
  app.onError((err, c) => {
    console.error('[Server] 未捕獲的錯誤：', err);
    return c.json(
      {
        error: 'INTERNAL_ERROR',
        message: '伺服器發生未預期的錯誤',
      },
      500,
    );
  });

  return app;
}
