// ClawAPI 引擎端 HTTP Server
// 使用 Hono 框架，提供 OpenAI 相容 API
// 支援 auth.token / sk_live_ 認證、優雅關機

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Context } from 'hono';
import { createOpenAICompatRouter } from './api/openai-compat';
import { createClawAPIRouter } from './api/clawapi';
import { createManagementRouter } from './api/management';
import type { ManagementDeps } from './api/management';
import { createEventsRouter, getEventBus } from './api/events';
import type { Router } from './core/router';
import type { KeyPool } from './core/key-pool';
import { EngineAuth, engineAuth } from './core/auth';
import type { AdapterConfig, AdapterLoader } from './adapters/loader';
import type { ClawDatabase } from './storage/database';
import type { WriteBuffer } from './storage/write-buffer';
import type { SubKeyManager } from './sharing/sub-key';
import type { AidClient } from './sharing/mutual-aid';
import type { TelemetryCollector } from './intelligence/telemetry';
import type { L0Manager } from './l0/manager';
import type { ClawConfig } from './core/config';
import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { createUIRouter } from './ui/router';
import type { UIDeps } from './ui/router';

// ===== 型別定義 =====

/** Server 啟動選項 */
export interface ServerOptions {
  /** 監聽 port（預設 11434） */
  port?: number;
  /** 主機位址（預設 127.0.0.1） */
  host?: string;
  /** 資料目錄（含 auth.token） */
  dataDir?: string;
  /** 優雅關機超時（ms，預設 30000） */
  shutdownTimeoutMs?: number;
}

/** 管理 API 所需的選用依賴（未傳入則跳過管理 API 路由） */
export interface ManagementOptions {
  subKeyManager: SubKeyManager;
  aidClient: AidClient;
  adapterLoader: AdapterLoader;
  telemetry: TelemetryCollector;
  l0Manager: L0Manager;
  getConfig: () => ClawConfig;
  updateConfig: (partial: Partial<ClawConfig>) => Promise<void>;
}

/** Server 實例（用於測試或程式控制） */
export interface EngineServer {
  /** 啟動 server */
  start(): Promise<void>;
  /** 停止 server（優雅關機） */
  stop(): Promise<void>;
  /** 取得 Hono 實例（測試用） */
  getApp(): Hono;
  /** 是否正在運行 */
  isRunning(): boolean;
}

/** 進行中的請求追蹤 */
interface ActiveRequest {
  id: string;
  startedAt: number;
}

// ===== Server 主類別 =====

/**
 * ClawAPI 引擎 HTTP Server
 *
 * 職責：
 * 1. 掛載 OpenAI 相容路由（/v1/*）
 * 2. 設定 auth.token 中介層
 * 3. 管理優雅關機流程
 * 4. 顯示啟動資訊
 */
export class ClawEngineServer implements EngineServer {
  private app: Hono;
  private serverInstance: ReturnType<typeof Bun.serve> | null = null;
  private running = false;
  private shuttingDown = false;

  /** 進行中的請求 Map（用於優雅關機計數） */
  private activeRequests = new Map<string, ActiveRequest>();
  private requestCounter = 0;

  private readonly port: number;
  private readonly host: string;
  private readonly shutdownTimeoutMs: number;
  private readonly dataDir: string | undefined;

  constructor(
    private readonly router: Router,
    private readonly keyPool: KeyPool,
    private readonly auth: EngineAuth,
    private readonly adapters: Map<string, AdapterConfig>,
    private readonly db: ClawDatabase,
    private readonly writeBuffer: WriteBuffer,
    options: ServerOptions = {},
    private readonly mgmtOptions?: ManagementOptions
  ) {
    this.port = options.port ?? 11434;
    this.host = options.host ?? '127.0.0.1';
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
    this.dataDir = options.dataDir;

    this.app = this.buildApp();
  }

  // ===== 公開方法 =====

  /** 啟動 Server */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Server 已在運行中');
    }

    // 初始化 auth.token
    await this.auth.initToken(this.dataDir);

    // 啟動 Bun HTTP Server
    const app = this.app;
    const port = this.port;
    const host = this.host;

    this.serverInstance = Bun.serve({
      port,
      hostname: host,
      fetch: app.fetch,
    });

    this.running = true;

    // 顯示啟動資訊
    this.printStartupInfo();

    // 註冊信號處理器
    this.registerSignalHandlers();
  }

  /** 停止 Server（優雅關機） */
  async stop(): Promise<void> {
    if (!this.running || this.shuttingDown) return;
    this.shuttingDown = true;

    console.log('\n[Server] 收到關機信號，開始優雅關機...');

    // 1. 等待進行中請求完成（最多 shutdownTimeoutMs）
    await this.waitForActiveRequests();

    // 2. 停止接受新連線（Bun Server 關閉）
    if (this.serverInstance) {
      this.serverInstance.stop(true);
      this.serverInstance = null;
    }

    // 3. Flush 寫入緩衝區
    console.log('[Server] 正在 flush 寫入緩衝區...');
    try {
      await this.writeBuffer.stop();
    } catch (err) {
      console.error('[Server] WriteBuffer flush 失敗:', err);
    }

    // 4. 關閉 DB（含 WAL checkpoint）
    console.log('[Server] 正在關閉資料庫...');
    try {
      await this.db.close();
    } catch (err) {
      console.error('[Server] DB 關閉失敗:', err);
    }

    this.running = false;
    this.shuttingDown = false;
    console.log('[Server] 已安全關機');
  }

  /** 取得 Hono 實例（測試用） */
  getApp(): Hono {
    return this.app;
  }

  /** 是否正在運行 */
  isRunning(): boolean {
    return this.running;
  }

  // ===== App 構建 =====

  /** 構建 Hono 應用程式 */
  private buildApp(): Hono {
    const app = new Hono();

    // === 全域中介層 ===

    // CORS
    app.use('*', cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      exposeHeaders: ['X-ClawAPI-Service', 'X-ClawAPI-Model', 'X-ClawAPI-Layer', 'X-ClawAPI-Latency'],
    }));

    // Request Logger
    app.use('*', logger());

    // 請求追蹤（用於優雅關機）
    app.use('*', async (c, next) => {
      // 若正在關機，拒絕新請求
      if (this.shuttingDown) {
        return c.json(
          {
            error: 'service_unavailable',
            message: 'Server 正在關機，請稍後再試',
          },
          503
        );
      }

      const reqId = this.trackRequest();
      try {
        await next();
      } finally {
        this.untrackRequest(reqId);
      }
    });

    // === 公開端點（不需認證） ===

    // 健康檢查
    app.get('/health', (c) => {
      return c.json({
        status: 'ok',
        version: CLAWAPI_VERSION,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    app.get('/v1/health', (c) => {
      return c.json({
        status: 'ok',
        version: CLAWAPI_VERSION,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });

    // === 掛載 Web UI 路由（/ui/*，不需 API auth） ===
    if (this.mgmtOptions) {
      const uiDeps: UIDeps = {
        keyPool: this.keyPool,
        subKeyManager: this.mgmtOptions.subKeyManager,
        aidClient: this.mgmtOptions.aidClient,
        adapterLoader: this.mgmtOptions.adapterLoader,
        telemetry: this.mgmtOptions.telemetry,
        l0Manager: this.mgmtOptions.l0Manager,
        db: this.db,
        adapters: this.adapters,
        getConfig: this.mgmtOptions.getConfig,
        startedAt: new Date(),
      };
      const uiRouter = createUIRouter(uiDeps);
      app.route('/ui', uiRouter);
    }

    // === Auth 中介層（保護所有 /v1/* 和 /api/* 路由，除 /v1/health） ===
    app.use('/v1/*', engineAuth(this.auth));
    app.use('/api/*', engineAuth(this.auth));

    // === 掛載 OpenAI 相容路由 ===
    const openaiRouter = createOpenAICompatRouter(
      this.router,
      this.keyPool,
      this.adapters
    );
    app.route('/v1', openaiRouter);

    // === 掛載 ClawAPI 簡化 API 路由 ===
    const clawAPIRouter = createClawAPIRouter(this.router);
    app.route('/api', clawAPIRouter);

    // === 掛載 SSE 事件流路由 ===
    const eventsRouter = createEventsRouter(getEventBus());
    app.route('/api', eventsRouter);

    // === 掛載管理 API 路由（若有提供 mgmtOptions） ===
    // 安全規則：管理 API 僅允許 master token，Sub-Key 不可存取
    if (this.mgmtOptions) {
      // 管理路由專用中介層：攔截 Sub-Key 存取
      const masterOnlyGuard = async (c: Context, next: () => Promise<void>) => {
        const authType = c.get('authType');
        if (authType !== 'master') {
          return c.json(
            { error: 'forbidden', message: '管理 API 僅允許 Master Token，Sub-Key 無權存取' },
            403
          );
        }
        return next();
      };
      app.use('/api/keys*', masterOnlyGuard);
      app.use('/api/gold-keys*', masterOnlyGuard);
      app.use('/api/sub-keys*', masterOnlyGuard);
      app.use('/api/settings*', masterOnlyGuard);
      app.use('/api/backup*', masterOnlyGuard);
      app.use('/api/adapters*', masterOnlyGuard);

      const mgmtDeps: ManagementDeps = {
        keyPool: this.keyPool,
        subKeyManager: this.mgmtOptions.subKeyManager,
        aidClient: this.mgmtOptions.aidClient,
        adapterLoader: this.mgmtOptions.adapterLoader,
        telemetry: this.mgmtOptions.telemetry,
        l0Manager: this.mgmtOptions.l0Manager,
        db: this.db,
        adapters: this.adapters,
        getConfig: this.mgmtOptions.getConfig,
        updateConfig: this.mgmtOptions.updateConfig,
        startedAt: new Date(),
      };
      const mgmtRouter = createManagementRouter(mgmtDeps);
      app.route('/api', mgmtRouter);
    }

    // === 404 處理 ===
    app.notFound((c: Context) => {
      return c.json(
        {
          error: 'not_found',
          message: `路徑 ${c.req.method} ${c.req.path} 不存在`,
        },
        404
      );
    });

    // === 錯誤處理 ===
    app.onError((err: Error, c: Context) => {
      console.error('[Server] 未處理的錯誤:', err);
      return c.json(
        {
          error: 'internal_server_error',
          message: '伺服器發生內部錯誤',
        },
        500
      );
    });

    return app;
  }

  // ===== 優雅關機輔助 =====

  /** 追蹤新請求，回傳請求 ID */
  private trackRequest(): string {
    const id = `req_${++this.requestCounter}`;
    this.activeRequests.set(id, {
      id,
      startedAt: Date.now(),
    });
    return id;
  }

  /** 移除已完成的請求 */
  private untrackRequest(id: string): void {
    this.activeRequests.delete(id);
  }

  /**
   * 等待進行中請求完成
   * 最多等待 shutdownTimeoutMs，超時後強制繼續
   */
  private async waitForActiveRequests(): Promise<void> {
    const deadline = Date.now() + this.shutdownTimeoutMs;

    while (this.activeRequests.size > 0) {
      if (Date.now() >= deadline) {
        console.warn(
          `[Server] 優雅關機超時（${this.shutdownTimeoutMs}ms），` +
          `仍有 ${this.activeRequests.size} 個請求未完成，強制關機`
        );
        break;
      }

      const remaining = this.activeRequests.size;
      console.log(`[Server] 等待 ${remaining} 個進行中請求完成...`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (this.activeRequests.size === 0) {
      console.log('[Server] 所有請求已完成');
    }
  }

  // ===== 信號處理 =====

  /** 註冊 SIGTERM / SIGINT 信號處理器 */
  private registerSignalHandlers(): void {
    const shutdown = async () => {
      await this.stop();
      process.exit(0);
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  // ===== 啟動資訊 =====

  /** 顯示啟動資訊 */
  private printStartupInfo(): void {
    const token = (() => {
      try {
        const t = this.auth.getToken();
        return `${t.slice(0, 12)}...（已隱藏）`;
      } catch {
        return '（尚未初始化）';
      }
    })();

    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║        ClawAPI 開源引擎 已啟動           ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  版本：${CLAWAPI_VERSION.padEnd(34)}║`);
    console.log(`║  位址：http://${this.host}:${this.port}`.padEnd(44) + '║');
    console.log(`║  Token：${token.padEnd(33)}║`);
    console.log('╠══════════════════════════════════════════╣');
    console.log('║  已掛載路由：                            ║');
    console.log('║    GET  /health                          ║');
    console.log('║    GET  /v1/health                       ║');
    console.log('║    POST /v1/chat/completions             ║');
    console.log('║    GET  /v1/models                       ║');
    console.log('║    POST /v1/embeddings                   ║');
    console.log('║    POST /v1/images/generations           ║');
    console.log('║    POST /v1/audio/transcriptions         ║');
    console.log('║    POST /v1/audio/speech                 ║');
    console.log('║    POST /v1/files                        ║');
    console.log('║    GET  /v1/files                        ║');
    console.log('║    GET  /v1/files/:file_id               ║');
    console.log('║    DELETE /v1/files/:file_id             ║');
    console.log('║  ClawAPI 簡化 API：                      ║');
    console.log('║    POST /api/llm                         ║');
    console.log('║    POST /api/search                      ║');
    console.log('║    POST /api/translate                   ║');
    console.log('║    POST /api/ask                         ║');
    console.log('║    POST /api/task                        ║');
    console.log('║  管理 API 和 SSE：                       ║');
    console.log('║    GET  /api/events（SSE）               ║');
    console.log('║    GET  /api/status                      ║');
    console.log('║    GET  /api/keys                        ║');
    console.log('║    GET  /api/logs                        ║');
    console.log('║  Web UI：                                ║');
    console.log('║    GET  /ui（Dashboard + 12 頁）         ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('按 Ctrl+C 安全關機');
    console.log('');
  }
}

// ===== 工廠函式 =====

/**
 * 建立並初始化 ClawEngineServer
 * 用於 apps/engine/src/index.ts 的快速啟動
 */
export function createServer(
  router: Router,
  keyPool: KeyPool,
  auth: EngineAuth,
  adapters: Map<string, AdapterConfig>,
  db: ClawDatabase,
  writeBuffer: WriteBuffer,
  options?: ServerOptions,
  mgmtOptions?: ManagementOptions
): ClawEngineServer {
  return new ClawEngineServer(router, keyPool, auth, adapters, db, writeBuffer, options, mgmtOptions);
}

export default ClawEngineServer;
