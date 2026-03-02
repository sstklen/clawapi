// ClawAPI 開源引擎入口
// 負責初始化所有依賴並組裝 HTTP Server

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { loadConfig } from './core/config';
import type { ClawConfig, LoadConfigOptions } from './core/config';
import { CryptoModule } from './core/encryption';
import { EngineAuth } from './core/auth';
import { KeyPool } from './core/key-pool';
import { createDatabase } from './storage/database';
import type { ClawDatabase } from './storage/database';
import { WriteBuffer } from './storage/write-buffer';
import { AdapterExecutor } from './adapters/executor';
import { AdapterLoader } from './adapters/loader';
import type { AdapterConfig } from './adapters/loader';
import { Router } from './core/router';
import { handleRoutingUpdate } from './intelligence/routing-handler';
import { VPSClient } from './intelligence/vps-client';
import { TelemetryCollector } from './intelligence/telemetry';
import { L0Manager } from './l0/manager';
import { SubKeyManager } from './sharing/sub-key';
import { AidClient } from './sharing/mutual-aid';
import { ClawEngineServer } from './server';
import { NotificationManager } from './notifications/manager';

// ===== 型別定義 =====

export interface EngineOptions {
  /** 監聽 port（覆蓋 config） */
  port?: number;
  /** 主機位址 */
  host?: string;
  /** 設定檔路徑 */
  configPath?: string;
  /** 資料目錄 */
  dataDir?: string;
  /** 是否停用 VPS 連線 */
  noVps?: boolean;
  /** 詳細日誌 */
  verbose?: boolean;
}

// ===== 全域引擎實例（用於 stop） =====

let engineServer: ClawEngineServer | null = null;
let engineDb: ClawDatabase | null = null;
let engineWriteBuffer: WriteBuffer | null = null;
let engineVpsClient: VPSClient | null = null;

// ===== 啟動流程 =====

/**
 * 啟動 ClawAPI 引擎
 *
 * 初始化順序：
 * 1. 載入設定（config.yaml + CLI 覆蓋）
 * 2. 確保資料目錄存在
 * 3. 初始化加密模組（Master Key）
 * 4. 初始化資料庫（SQLite + 自動遷移）
 * 5. 初始化寫入緩衝區
 * 6. 初始化認證模組（auth.token）
 * 7. 初始化 Key 池
 * 8. 載入 Adapter（YAML 定義）
 * 9. 初始化 VPS 客戶端（可選）
 * 10. 初始化 L0 管理器
 * 11. 初始化 Adapter 執行器
 * 12. 初始化路由器
 * 13. 初始化管理功能（Sub-Key、互助、遙測）
 * 14. 組裝並啟動 HTTP Server
 */
export async function start(options?: EngineOptions): Promise<ClawEngineServer> {
  const dataDir = options?.dataDir ?? join(homedir(), '.clawapi');

  // 1. 載入設定
  const configOptions: LoadConfigOptions = {};
  if (options?.configPath) {
    configOptions.configPath = options.configPath;
  }
  if (options?.port || options?.host) {
    configOptions.overrides = {
      server: {
        ...(options.port ? { port: options.port } : {}),
        ...(options.host ? { host: options.host } : {}),
      },
    };
  }
  const config = await loadConfig(configOptions);
  const port = options?.port ?? config.server.port;
  const host = options?.host ?? config.server.host;

  if (options?.verbose) {
    console.log(`[ClawAPI] 設定已載入：port=${port}, host=${host}`);
  }

  // 2. 確保資料目錄存在
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // 3. 初始化加密模組（Master Key）
  const crypto = new CryptoModule(dataDir);
  await crypto.initMasterKey();
  if (options?.verbose) {
    console.log(`[ClawAPI] ✅ 加密模組初始化完成`);
  }

  // 4. 初始化資料庫
  const dbPath = config.advanced?.db_path ?? join(dataDir, 'data.db');
  const db = createDatabase(dbPath);
  await db.init();
  engineDb = db;
  if (options?.verbose) {
    console.log(`[ClawAPI] ✅ 資料庫初始化完成：${dbPath}`);
  }

  // 5. 初始化寫入緩衝區
  const writeBuffer = new WriteBuffer(db);
  writeBuffer.start();
  engineWriteBuffer = writeBuffer;

  // 6. 初始化認證模組
  const auth = new EngineAuth(db, dataDir);
  await auth.initToken(dataDir);
  if (options?.verbose) {
    console.log(`[ClawAPI] ✅ 認證模組初始化完成`);
  }

  // 7. 初始化 Key 池
  const keyPool = new KeyPool(db, crypto);

  // 7.5 初始化通知管理器（Webhook + CLI + 內部回呼）
  const notificationManager = new NotificationManager(db);
  keyPool.setNotificationManager(notificationManager);
  if (options?.verbose) {
    console.log(`[ClawAPI] ✅ 通知管理器初始化完成`);
  }

  // 8. 載入 Adapter（內建 YAML 定義）
  const adapterLoader = new AdapterLoader();
  const adapterSchemaDir = join(import.meta.dir, 'adapters', 'schemas');
  let adapters = new Map<string, AdapterConfig>();
  try {
    if (existsSync(adapterSchemaDir)) {
      adapters = await adapterLoader.loadFromDirectory(adapterSchemaDir);
      if (options?.verbose) {
        console.log(`[ClawAPI] ✅ 載入 ${adapters.size} 個 Adapter`);
      }
    }
  } catch (err) {
    console.warn(`[ClawAPI] ⚠️ Adapter 載入失敗，將以空 Adapter 啟動:`, err);
  }

  // 9. 初始化 VPS 客戶端（可選）
  let vpsClient: VPSClient | null = null;
  if (!options?.noVps && config.vps.enabled) {
    try {
      vpsClient = new VPSClient(
        {
          baseUrl: config.vps.base_url,
          wsUrl: config.vps.websocket_url,
          clientVersion: CLAWAPI_VERSION,
        },
        db
      );
      await vpsClient.connect();
      engineVpsClient = vpsClient;
      if (options?.verbose) {
        console.log(`[ClawAPI] ✅ VPS 連線建立`);
      }
    } catch (err) {
      console.warn(`[ClawAPI] ⚠️ VPS 連線失敗，將以離線模式運行:`, err);
      vpsClient = null;
    }
  }

  // 9.5 接通 VPS 事件處理（路由更新 → routing_intel 表）
  if (vpsClient) {
    // 接收 VPS 下發的路由建議，存入 routing_intel 表
    vpsClient.onRoutingUpdate((update: unknown) => {
      try {
        const count = handleRoutingUpdate(db, update);
        if (options?.verbose) {
          console.log(`[ClawAPI] 📡 路由更新：${count} 筆已存入 routing_intel`);
        }
      } catch (err) {
        if (options?.verbose) {
          console.warn(`[ClawAPI] ⚠️ 路由更新處理失敗:`, err);
        }
      }
    });

    // 接收 VPS 系統通知（目前只 log）
    vpsClient.onNotification((notif: unknown) => {
      if (options?.verbose) {
        console.log(`[ClawAPI] 📢 收到系統通知:`, notif);
      }
    });
  }

  // 10. 初始化 L0 管理器
  const l0Manager = new L0Manager(
    vpsClient ?? createDummyVPSClient(),
  );
  if (vpsClient) {
    await l0Manager.start();
  }

  // 11. 初始化 Adapter 執行器
  const executor = new AdapterExecutor(keyPool);

  // 12. 初始化路由器
  const router = new Router(keyPool, executor, adapters, l0Manager);

  // 13. 初始化管理功能
  const subKeyManager = new SubKeyManager(db, auth);

  // 遙測收集器（需要 VPS 客戶端）
  let telemetry: TelemetryCollector | null = null;
  if (vpsClient) {
    telemetry = new TelemetryCollector(db, vpsClient);
    telemetry.scheduleUpload();
  }

  // 互助客戶端（需要 VPS 客戶端）
  let aidClient: AidClient | null = null;
  if (vpsClient && config.aid.enabled) {
    aidClient = new AidClient(vpsClient, crypto, keyPool, db);
  }

  // 14. 組裝並啟動 HTTP Server
  const currentConfig = config;
  const mgmtOptions = {
    subKeyManager,
    aidClient: aidClient ?? createDummyAidClient(),
    adapterLoader: adapterLoader as any,
    telemetry: telemetry ?? createDummyTelemetry(),
    l0Manager,
    getConfig: () => currentConfig,
    updateConfig: async (_partial: Partial<ClawConfig>) => {
      // TODO: 寫回 config.yaml
    },
  };

  const server = new ClawEngineServer(
    router,
    keyPool,
    auth,
    adapters,
    db,
    writeBuffer,
    { port, host, dataDir },
    mgmtOptions
  );

  await server.start();
  engineServer = server;

  return server;
}

// ===== 停止流程 =====

export async function stop(): Promise<void> {
  if (engineServer) {
    await engineServer.stop();
    engineServer = null;
  }
  if (engineWriteBuffer) {
    await engineWriteBuffer.stop();
    engineWriteBuffer = null;
  }
  if (engineVpsClient) {
    await engineVpsClient.disconnect();
    engineVpsClient = null;
  }
  if (engineDb) {
    await engineDb.close();
    engineDb = null;
  }
}

// ===== Dummy 物件（VPS 離線模式用） =====

/** 離線模式的假 VPS 客戶端 */
function createDummyVPSClient(): any {
  return {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
    fetchL0Keys: async () => [],
    submitTelemetry: async () => {},
    on: () => {},
    off: () => {},
  };
}

/** 離線模式的假互助客戶端 */
function createDummyAidClient(): any {
  return {
    requestAid: async () => ({ success: false, reason: 'offline' }),
    handleIncomingAidRequest: async () => {},
    updateConfig: async () => {},
    getStats: async () => ({ requests_made: 0, requests_received: 0, success_rate: 0 }),
    getCooldownRemaining: () => 0,
  };
}

/** 離線模式的假遙測收集器 */
function createDummyTelemetry(): any {
  return {
    recordEvent: async () => {},
    buildBatch: async () => null,
    uploadBatch: async () => {},
    scheduleUpload: () => {},
    stopSchedule: () => {},
    submitFeedback: async () => {},
  };
}
