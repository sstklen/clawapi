// ClawAPI VPS 服務入口
// 負責初始化所有依賴並啟動 HTTP + WebSocket 伺服器

import { VPSDatabase } from './storage/database';
import { VPSKeyManager } from './core/ecdh';
import { IntelligenceEngine } from './services/intelligence-engine';
import { AnomalyDetector } from './services/anomaly-detector';
import { AidEngine } from './services/aid-engine';
import { L0Manager } from './services/l0-manager';
import { SubKeyValidator } from './services/subkey-validator';
import { initWebSocketManager } from './ws/manager';
import { createServer } from './server';

export interface VPSOptions {
  port?: number;
  dbPath?: string;
}

export async function start(options?: VPSOptions): Promise<void> {
  const port = options?.port ?? (Number(process.env.VPS_PORT) || 3100);
  const dbPath = options?.dbPath ?? (process.env.DB_PATH || '/data/clawapi-vps.db');

  console.log(`[ClawAPI] 正在啟動 VPS 服務...`);
  console.log(`[ClawAPI] 資料庫路徑：${dbPath}`);
  console.log(`[ClawAPI] 監聽埠：${port}`);

  // 1. 初始化資料庫
  const db = new VPSDatabase(dbPath);
  await db.init();
  console.log(`[ClawAPI] ✅ 資料庫初始化完成`);

  // 2. 初始化 ECDH 金鑰管理器
  const keyManager = new VPSKeyManager(db);
  await keyManager.init();
  console.log(`[ClawAPI] ✅ 金鑰管理器初始化完成`);

  // 3. 初始化遙測分析引擎
  const intelligenceEngine = new IntelligenceEngine(db);
  console.log(`[ClawAPI] ✅ 智慧引擎初始化完成`);

  // 4. 初始化異常偵測器
  const anomalyDetector = new AnomalyDetector(db);
  console.log(`[ClawAPI] ✅ 異常偵測器初始化完成`);

  // 5. 初始化 L0 金鑰管理器
  const l0Manager = new L0Manager(db, keyManager);
  await l0Manager.init();
  console.log(`[ClawAPI] ✅ L0 管理器初始化完成`);

  // 6. 初始化 WebSocket 管理器
  const wsManager = initWebSocketManager(db);
  console.log(`[ClawAPI] ✅ WebSocket 管理器初始化完成`);

  // 7. 初始化互助引擎
  const aidEngine = new AidEngine(db, wsManager);
  console.log(`[ClawAPI] ✅ 互助引擎初始化完成`);

  // 8. 初始化 Sub-Key 驗證器
  const subKeyValidator = new SubKeyValidator(db, wsManager);
  console.log(`[ClawAPI] ✅ Sub-Key 驗證器初始化完成`);

  // 9. 組裝所有依賴，建立 Hono 應用程式
  const app = createServer({
    db,
    keyManager,
    intelligenceEngine,
    anomalyDetector,
    aidEngine,
    l0Manager,
    subKeyValidator,
    wsManager,
  });

  // 10. 啟動 HTTP 伺服器
  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`[ClawAPI] 🚀 VPS 服務已啟動：http://localhost:${server.port}`);

  // 啟動背景定時任務
  intelligenceEngine.startHourlyAnalysis();
  l0Manager.startHealthCheck();

  // 優雅關機
  process.on('SIGTERM', () => {
    console.log(`[ClawAPI] 收到 SIGTERM，正在關閉...`);
    server.stop();
    db.close();
    console.log(`[ClawAPI] 已關閉`);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log(`[ClawAPI] 收到 SIGINT，正在關閉...`);
    server.stop();
    db.close();
    console.log(`[ClawAPI] 已關閉`);
    process.exit(0);
  });
}

// 直接執行時啟動伺服器
start().catch((err) => {
  console.error('[ClawAPI] 啟動失敗：', err);
  process.exit(1);
});
