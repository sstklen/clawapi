// UI 路由器
// 掛載到 /ui/*，提供 SSR HTML 頁面
// 使用 Hono JSX 伺服器端渲染
//
// 路由表：
//   GET /ui                     Dashboard
//   GET /ui/keys                Key 管理
//   GET /ui/keys/add            新增 Key
//   GET /ui/gold-key            金鑰匙設定
//   GET /ui/sub-keys            Sub-Key 管理
//   GET /ui/sub-keys/issue      發行 Sub-Key
//   GET /ui/aid                 互助設定
//   GET /ui/adapters            Adapter 管理
//   GET /ui/logs                使用紀錄
//   GET /ui/settings            設定
//   GET /ui/backup              備份管理
//   GET /ui/about               關於

import { Hono } from 'hono';
import type { Context } from 'hono';

/** 安全規則：Sub-Key token 只顯示前後綴遮罩 */
function maskSubKeyToken(token: string): string {
  if (token.length <= 12) return '****';
  return token.slice(0, 8) + '****' + token.slice(-4);
}

/** 安全規則：JSON.parse 防呆，避免壞資料整頁 500 */
function safeJsonParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
import type { KeyPool } from '../core/key-pool';
import type { SubKeyManager } from '../sharing/sub-key';
import type { AidClient } from '../sharing/mutual-aid';
import type { AdapterConfig, AdapterLoader } from '../adapters/loader';
import type { TelemetryCollector } from '../intelligence/telemetry';
import type { L0Manager } from '../l0/manager';
import type { ClawDatabase } from '../storage/database';
import type { ClawConfig } from '../core/config';
import { getEngineVersion } from '../version';

import { DashboardPage } from './pages/dashboard';
import type { DashboardData } from './pages/dashboard';
import { KeysPage, KeysAddPage } from './pages/keys';
import { GoldKeyPage } from './pages/gold-key';
import { SubKeysPage, SubKeysIssuePage } from './pages/sub-keys';
import { AidPage } from './pages/aid';
import { AdaptersPage } from './pages/adapters';
import { LogsPage } from './pages/logs';
import { SettingsPage } from './pages/settings';
import { BackupPage } from './pages/backup';
import { AboutPage } from './pages/about';

// ===== 型別定義 =====

/** UI 路由依賴注入 */
export interface UIDeps {
  keyPool: KeyPool;
  subKeyManager: SubKeyManager;
  aidClient: AidClient;
  adapterLoader: AdapterLoader;
  telemetry: TelemetryCollector;
  l0Manager: L0Manager;
  db: ClawDatabase;
  adapters: Map<string, AdapterConfig>;
  getConfig: () => ClawConfig;
  startedAt: Date;
}

// ===== 輔助函式 =====

/** 將 JSX 轉為完整 HTML Response（帶 DOCTYPE） */
function renderPage(c: Context, jsx: JSX.Element): Response {
  // Hono 的 c.html() 會幫我們設定 Content-Type
  // 但我們要手動加上 DOCTYPE
  return c.html('<!DOCTYPE html>' + jsx.toString());
}

// ===== 路由器工廠 =====

/**
 * 建立 UI 路由器
 * @param deps UI 所需的依賴注入
 * @returns Hono 路由實例（掛到 /ui）
 */
export function createUIRouter(deps: UIDeps): Hono {
  const app = new Hono();

  const {
    keyPool,
    subKeyManager,
    aidClient,
    db,
    adapters,
    getConfig,
    startedAt,
  } = deps;

  // =========================================================
  // GET /ui — Dashboard
  // =========================================================
  app.get('/', async (c: Context) => {
    // 收集 Dashboard 所需資料
    const keys = await keyPool.listKeys();

    // 統計 Key 狀態分佈
    let active = 0;
    let rateLimited = 0;
    let dead = 0;
    for (const k of keys) {
      const status = (k as { status?: string }).status ?? 'active';
      if (status === 'active') active++;
      else if (status === 'rate_limited') rateLimited++;
      else dead++;
    }

    // 今日用量（從 DB 查詢）
    const today = new Date().toISOString().slice(0, 10);
    const usageRows = db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM usage_log WHERE timestamp >= ?',
      [`${today}T00:00:00`]
    );
    const todayCount = usageRows[0]?.cnt ?? 0;

    // 成功率
    const successRows = db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM usage_log WHERE timestamp >= ? AND success = 1',
      [`${today}T00:00:00`]
    );
    const successCount = successRows[0]?.cnt ?? 0;
    const successRate = todayCount > 0 ? (successCount / todayCount) * 100 : 100;

    const data: DashboardData = {
      keyPool: {
        total: keys.length,
        active,
        rateLimited,
        dead,
      },
      todayUsage: {
        count: todayCount,
        trend: todayCount > 0 ? '\u2191 \u6d3b\u8e8d' : '\u2014 \u9752\u975c',
      },
      successRate,
      collectiveIntel: {
        onlineLobsters: 0, // VPS 連線後才有資料
      },
    };

    return renderPage(c, DashboardPage({ data }));
  });

  // =========================================================
  // GET /ui/keys — Key 管理
  // =========================================================
  app.get('/keys', async (c: Context) => {
    const rawKeys = await keyPool.listKeys();

    // 轉換為 UI 用的格式
    const keys = rawKeys.map((k: Record<string, unknown>) => ({
      id: (k.id as number) ?? 0,
      service_id: (k.service_id as string) ?? '',
      masked_key: (k.masked_key as string) ?? '****',
      pool_type: ((k.pool_type as string) ?? 'king') as 'king' | 'friend',
      status: ((k.status as string) ?? 'active') as 'active' | 'rate_limited' | 'dead',
      label: k.label as string | undefined,
      pinned: (k.pinned as boolean) ?? false,
      success_rate: (k.success_rate as number) ?? 100,
      total_requests: (k.total_requests as number) ?? 0,
      created_at: (k.created_at as string) ?? new Date().toISOString(),
    }));

    return renderPage(c, KeysPage({ keys }));
  });

  // =========================================================
  // GET /ui/keys/add — 新增 Key
  // =========================================================
  app.get('/keys/add', (c: Context) => {
    return renderPage(c, KeysAddPage({}));
  });

  // =========================================================
  // GET /ui/gold-key — 金鑰匙設定
  // =========================================================
  app.get('/gold-key', (c: Context) => {
    const rows = db.query<{
      id: number;
      service_id: string;
      model_id: string;
      is_active: number;
      daily_used: number;
      daily_limit: number | null;
      created_at: string;
    }>('SELECT id, service_id, model_id, is_active, daily_used, daily_limit, created_at FROM gold_keys ORDER BY created_at DESC');

    const goldKeys = rows.map(r => ({
      id: r.id,
      service_id: r.service_id,
      model_id: r.model_id,
      is_active: r.is_active === 1,
      daily_used: r.daily_used,
      daily_limit: r.daily_limit,
      created_at: r.created_at,
    }));

    return renderPage(c, GoldKeyPage({ goldKeys }));
  });

  // =========================================================
  // GET /ui/sub-keys — Sub-Key 管理
  // =========================================================
  app.get('/sub-keys', async (c: Context) => {
    const rawSubKeys = await subKeyManager.list();

    const subKeys = rawSubKeys.map((sk: Record<string, unknown>) => ({
      id: (sk.id as number) ?? 0,
      label: (sk.label as string) ?? '',
      // 安全規則：UI 列表只顯示遮罩版 token，完整 token 僅在發行當下顯示一次
      token: maskSubKeyToken((sk.token as string) ?? '****'),
      is_active: (sk.is_active as boolean) ?? true,
      daily_used: (sk.daily_used as number) ?? 0,
      daily_limit: (sk.daily_limit as number | null) ?? null,
      total_requests: (sk.total_requests as number) ?? 0,
      created_at: (sk.created_at as string) ?? new Date().toISOString(),
      expires_at: (sk.expires_at as string | null) ?? null,
    }));

    return renderPage(c, SubKeysPage({ subKeys }));
  });

  // =========================================================
  // GET /ui/sub-keys/issue — 發行 Sub-Key
  // =========================================================
  app.get('/sub-keys/issue', (c: Context) => {
    return renderPage(c, SubKeysIssuePage({}));
  });

  // =========================================================
  // GET /ui/aid — 互助設定
  // =========================================================
  app.get('/aid', async (c: Context) => {
    // 讀取互助設定
    const configRows = db.query<{
      enabled: number;
      allowed_services: string | null;
      daily_limit: number;
      daily_given: number;
    }>('SELECT enabled, allowed_services, daily_limit, daily_given FROM aid_config LIMIT 1');

    const aidConfig = configRows.length > 0
      ? {
          enabled: configRows[0]!.enabled === 1,
          allowed_services: safeJsonParse<string[] | null>(configRows[0]!.allowed_services, null),
          daily_limit: configRows[0]!.daily_limit,
          daily_given: configRows[0]!.daily_given,
          blackout_hours: [] as number[],
          has_helper_key: false,
        }
      : {
          enabled: false,
          allowed_services: null,
          daily_limit: 50,
          daily_given: 0,
          blackout_hours: [] as number[],
          has_helper_key: false,
        };

    // 互助統計
    let stats = { total_given: 0, total_received: 0, karma_score: 0 };
    try {
      stats = await aidClient.getStats() as typeof stats;
    } catch {
      // 互助未啟用時 getStats 可能丟錯
    }

    return renderPage(c, AidPage({ config: aidConfig, stats }));
  });

  // =========================================================
  // GET /ui/adapters — Adapter 管理
  // =========================================================
  app.get('/adapters', (c: Context) => {
    const adapterList = Array.from(adapters.values()).map(a => ({
      id: a.adapter.id,
      name: a.adapter.name,
      version: a.adapter.version,
      category: a.adapter.category,
      requires_key: a.adapter.requires_key,
      free_tier: a.adapter.free_tier ?? false,
      capabilities: {
        chat: a.capabilities.chat,
        streaming: a.capabilities.streaming,
        embeddings: a.capabilities.embeddings,
        images: a.capabilities.images,
        audio: a.capabilities.audio,
        model_count: a.capabilities.models.length,
      },
    }));

    return renderPage(c, AdaptersPage({ adapters: adapterList }));
  });

  // =========================================================
  // GET /ui/logs — 使用紀錄
  // =========================================================
  app.get('/logs', (c: Context) => {
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
    const pageSize = 50;
    const offset = (page - 1) * pageSize;

    // 總筆數
    const countResult = db.query<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM usage_log');
    const total = countResult[0]?.cnt ?? 0;

    // 查詢本頁資料
    const rows = db.query<{
      id: number;
      timestamp: string;
      service_id: string;
      model: string | null;
      layer: string;
      success: number;
      latency_ms: number;
      tokens_input: number | null;
      tokens_output: number | null;
      error_code: string | null;
    }>(
      `SELECT id, timestamp, service_id, model, layer, success, latency_ms,
              tokens_input, tokens_output, error_code
       FROM usage_log ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );

    const logs = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      service_id: r.service_id,
      model: r.model,
      layer: r.layer,
      success: r.success === 1,
      latency_ms: r.latency_ms,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
      error_code: r.error_code,
    }));

    return renderPage(c, LogsPage({ logs, total, page, pageSize }));
  });

  // =========================================================
  // GET /ui/settings — 設定
  // =========================================================
  app.get('/settings', (c: Context) => {
    const config = getConfig();

    return renderPage(c, SettingsPage({
      settings: {
        server: config.server,
        l0: config.l0,
        aid: config.aid,
        telemetry: config.telemetry,
        routing: config.routing,
        advanced: config.advanced,
      },
    }));
  });

  // =========================================================
  // GET /ui/backup — 備份管理
  // =========================================================
  app.get('/backup', (c: Context) => {
    return renderPage(c, BackupPage({}));
  });

  // =========================================================
  // GET /ui/about — 關於
  // =========================================================
  app.get('/about', (c: Context) => {
    const uptime = Math.floor((Date.now() - startedAt.getTime()) / 1000);

    return renderPage(c, AboutPage({
      version: getEngineVersion(),
      uptime,
      startedAt: startedAt.toISOString(),
    }));
  });

  return app;
}

export default createUIRouter;
