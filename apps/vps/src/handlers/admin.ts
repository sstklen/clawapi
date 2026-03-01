// Admin 路由處理器
// 涵蓋：健康狀態、管理員統計、L0 Key 手動新增、Prometheus metrics
// /health 公開；/admin/* 需 X-Admin-Token 認證

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Context, Next, MiddlewareHandler } from 'hono';
import type { VPSDatabase } from '../storage/database';
import type { VPSKeyManager } from '../core/ecdh';
import type { L0Manager } from '../services/l0-manager';
import type { WebSocketManager } from '../ws/manager';

// 安全比較（防 timing attack）
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// 伺服器啟動時間（用於計算 uptime）
const SERVER_START_TIME = Date.now();

// ===== 管理員 Token 認證 middleware =====
// Header: X-Admin-Token: {ADMIN_TOKEN}
// 認證失敗 → 401
function adminTokenAuth(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const adminToken = process.env['ADMIN_TOKEN'];
    const token = c.req.header('X-Admin-Token');

    if (!adminToken || !token || !safeCompare(token, adminToken)) {
      return c.json({ error: 'ADMIN_AUTH_FAILED', message: '管理員 Token 無效或缺少 X-Admin-Token header' }, 401);
    }

    return next();
  };
}

// ===== 健康狀態結構 =====
interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'error';
  size_mb?: number;
  key_age_days?: number;
  active_keys?: number;
  connections?: number;
  error?: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  checks: {
    database: HealthCheckResult;
    ecdh: HealthCheckResult;
    l0: HealthCheckResult;
    websocket: HealthCheckResult;
  };
}

// ===== 健康狀態收集函式 =====

// 資料庫健康狀態
function checkDatabase(db: VPSDatabase): HealthCheckResult {
  try {
    // 查詢 DB 檔案大小（透過 page_count * page_size）
    const pageSizeResult = db.query<{ page_size: number }>('PRAGMA page_size');
    const pageCountResult = db.query<{ page_count: number }>('PRAGMA page_count');
    const pageSize = pageSizeResult[0]?.page_size ?? 4096;
    const pageCount = pageCountResult[0]?.page_count ?? 0;
    const sizeMb = Math.round((pageSize * pageCount) / (1024 * 1024) * 10) / 10;

    return { status: 'ok', size_mb: sizeMb };
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}

// ECDH 金鑰健康狀態
function checkEcdh(keyManager: VPSKeyManager, db: VPSDatabase): HealthCheckResult {
  try {
    const { keyId } = keyManager.getCurrentPublicKey();

    // 查詢金鑰建立時間
    const records = db.query<{ created_at: string }>(
      'SELECT created_at FROM vps_key_history WHERE key_id = ? AND is_current = 1',
      [keyId],
    );

    if (records.length === 0) {
      return { status: 'degraded', error: '找不到當前金鑰記錄' };
    }

    const createdAt = new Date(records[0].created_at);
    const keyAgeDays = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

    return { status: 'ok', key_age_days: keyAgeDays };
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}

// L0 Key 健康狀態
function checkL0(db: VPSDatabase): HealthCheckResult {
  try {
    const result = db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM l0_keys WHERE status = 'active'`,
    );
    const activeKeys = result[0]?.count ?? 0;

    return { status: 'ok', active_keys: activeKeys };
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}

// WebSocket 健康狀態
function checkWebSocket(wsManager: WebSocketManager): HealthCheckResult {
  try {
    const connections = wsManager.getOnlineCount();
    return { status: 'ok', connections };
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}

// 整體狀態判斷（任一 error → error；任一 degraded → degraded）
function overallStatus(checks: HealthResponse['checks']): 'ok' | 'degraded' | 'error' {
  const statuses = Object.values(checks).map((c) => c.status);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('degraded')) return 'degraded';
  return 'ok';
}

// ===== 建立 Admin 路由 =====
export function createAdminRouter(
  db: VPSDatabase,
  keyManager: VPSKeyManager,
  l0Manager: L0Manager,
  wsManager: WebSocketManager,
): Hono {
  const router = new Hono();

  // ─────────────────────────────────────────────────────────────────
  // GET /health（公開端點）
  // 回傳整體健康狀態（db/ecdh/l0/ws）
  // ─────────────────────────────────────────────────────────────────
  router.get('/health', (c) => {
    const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);

    const checks: HealthResponse['checks'] = {
      database: checkDatabase(db),
      ecdh: checkEcdh(keyManager, db),
      l0: checkL0(db),
      websocket: checkWebSocket(wsManager),
    };

    const response: HealthResponse = {
      status: overallStatus(checks),
      uptime: uptimeSeconds,
      checks,
    };

    // 任一子系統 error → HTTP 503
    const httpStatus = response.status === 'error' ? 503 : 200;
    return c.json(response, httpStatus);
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /admin/health-report（需要 X-Admin-Token）
  // 完整健康報告，包含詳細統計
  // ─────────────────────────────────────────────────────────────────
  router.get('/admin/health-report', adminTokenAuth(), (c) => {
    const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);

    const checks: HealthResponse['checks'] = {
      database: checkDatabase(db),
      ecdh: checkEcdh(keyManager, db),
      l0: checkL0(db),
      websocket: checkWebSocket(wsManager),
    };

    // 取得額外統計
    let deviceStats: { total: number; active: number; suspended: number } = {
      total: 0, active: 0, suspended: 0,
    };
    try {
      const rows = db.query<{ status: string; count: number }>(
        `SELECT status, COUNT(*) as count FROM devices GROUP BY status`,
      );
      for (const row of rows) {
        deviceStats.total += row.count;
        if (row.status === 'active') deviceStats.active = row.count;
        if (row.status === 'suspended') deviceStats.suspended = row.count;
      }
    } catch {
      // 忽略統計錯誤
    }

    let telemetryStats: { batches_24h: number; entries_24h: number } = {
      batches_24h: 0, entries_24h: 0,
    };
    try {
      const batchResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_batches WHERE received_at > datetime('now', '-24 hours')`,
      );
      const entryResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_entries WHERE received_at > datetime('now', '-24 hours')`,
      );
      telemetryStats.batches_24h = batchResult[0]?.count ?? 0;
      telemetryStats.entries_24h = entryResult[0]?.count ?? 0;
    } catch {
      // 忽略統計錯誤
    }

    return c.json({
      status: overallStatus(checks),
      uptime: uptimeSeconds,
      server_time: new Date().toISOString(),
      checks,
      devices: deviceStats,
      telemetry: telemetryStats,
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /admin/stats（需要 X-Admin-Token）
  // 裝置數、連線數、今日請求數等統計
  // ─────────────────────────────────────────────────────────────────
  router.get('/admin/stats', adminTokenAuth(), (c) => {
    try {
      // 裝置總數
      const totalDevicesResult = db.query<{ count: number }>(
        'SELECT COUNT(*) as count FROM devices',
      );
      const totalDevices = totalDevicesResult[0]?.count ?? 0;

      // 活躍裝置數（最近 24 小時有活動）
      const activeDevicesResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM devices
         WHERE last_seen_at > datetime('now', '-24 hours')`,
      );
      const activeDevices24h = activeDevicesResult[0]?.count ?? 0;

      // WebSocket 連線數
      const wsConnections = wsManager.getOnlineCount();

      // 今日遙測批次數
      const today = new Date().toISOString().slice(0, 10);
      const todayBatchesResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_batches
         WHERE date(received_at) = ?`,
        [today],
      );
      const todayBatches = todayBatchesResult[0]?.count ?? 0;

      // L0 Key 統計
      const l0StatsResult = db.query<{ status: string; count: number }>(
        `SELECT status, COUNT(*) as count FROM l0_keys GROUP BY status`,
      );
      const l0Stats: Record<string, number> = {};
      for (const row of l0StatsResult) {
        l0Stats[row.status] = row.count;
      }

      // 近 1 小時 API 請求數（從 telemetry_batches 估算）
      const lastHourBatchesResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_batches
         WHERE received_at > datetime('now', '-1 hour')`,
      );
      const requestsLastHour = lastHourBatchesResult[0]?.count ?? 0;

      return c.json({
        devices: {
          total: totalDevices,
          active_24h: activeDevices24h,
        },
        websocket: {
          connections: wsConnections,
        },
        telemetry: {
          batches_today: todayBatches,
          batches_last_hour: requestsLastHour,
        },
        l0_keys: {
          active: l0Stats['active'] ?? 0,
          degraded: l0Stats['degraded'] ?? 0,
          dead: l0Stats['dead'] ?? 0,
        },
        server_time: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[Admin] 取得統計失敗：', err);
      return c.json({ error: 'INTERNAL_ERROR', message: '取得統計失敗' }, 500);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /admin/l0/add-key（需要 X-Admin-Token）
  // 手動新增 L0 Key（管理員後台使用）
  // Body: { service_id, key_value, display_name?, daily_quota? }
  // ─────────────────────────────────────────────────────────────────
  router.post('/admin/l0/add-key', adminTokenAuth(), async (c) => {
    let body: {
      service_id?: string;
      key_value?: string;
      display_name?: string;
      daily_quota?: number;
    };

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'INVALID_REQUEST', message: '請求 body 格式錯誤' }, 400);
    }

    const { service_id, key_value, display_name, daily_quota } = body;

    if (!service_id || !key_value) {
      return c.json(
        { error: 'INVALID_REQUEST', message: '缺少必填欄位：service_id, key_value' },
        400,
      );
    }

    try {
      // 呼叫 L0Manager 的 handleDonate 處理加密和儲存
      const result = await l0Manager.handleDonate('__admin__', {
        service_id,
        encrypted_key: key_value,    // 管理員直接提供明文（由 L0Manager 處理）
        ephemeral_public_key: '',
        iv: '',
        tag: '',
        display_name: display_name ?? '管理員新增',
        anonymous: false,
      });

      return c.json({
        added: true,
        l0_key_id: result.l0_key_id,
        service_id,
        message: `L0 Key 已成功新增（服務：${service_id}）`,
      });
    } catch (err: unknown) {
      const error = err as Error & { errorCode?: string };
      console.error('[Admin] 手動新增 L0 Key 失敗：', err);
      return c.json(
        { error: error.errorCode ?? 'INTERNAL_ERROR', message: error.message ?? '新增失敗' },
        500,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /admin/prometheus（需要 X-Admin-Token）
  // Prometheus 格式 metrics 輸出
  // ─────────────────────────────────────────────────────────────────
  router.get('/admin/prometheus', adminTokenAuth(), (c) => {
    try {
      // 收集所需數據
      const totalDevicesResult = db.query<{ count: number }>(
        'SELECT COUNT(*) as count FROM devices',
      );
      const totalDevices = totalDevicesResult[0]?.count ?? 0;

      const wsConnections = wsManager.getOnlineCount();

      const today = new Date().toISOString().slice(0, 10);
      const todayUsageResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_entries
         WHERE date(received_at) = ?`,
        [today],
      );
      const l0UsageToday = todayUsageResult[0]?.count ?? 0;

      const l0ActiveResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM l0_keys WHERE status = 'active'`,
      );
      const l0ActiveKeys = l0ActiveResult[0]?.count ?? 0;

      const todayBatchesResult = db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM telemetry_batches WHERE date(received_at) = ?`,
        [today],
      );
      const todayBatches = todayBatchesResult[0]?.count ?? 0;

      const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);

      // 組裝 Prometheus 格式文字
      const lines: string[] = [
        '# HELP clawapi_vps_devices_total Total registered devices',
        '# TYPE clawapi_vps_devices_total gauge',
        `clawapi_vps_devices_total ${totalDevices}`,
        '',
        '# HELP clawapi_vps_ws_connections Active WebSocket connections',
        '# TYPE clawapi_vps_ws_connections gauge',
        `clawapi_vps_ws_connections ${wsConnections}`,
        '',
        '# HELP clawapi_vps_l0_usage_today Today\'s L0 usage',
        '# TYPE clawapi_vps_l0_usage_today counter',
        `clawapi_vps_l0_usage_today ${l0UsageToday}`,
        '',
        '# HELP clawapi_vps_l0_active_keys Active L0 keys',
        '# TYPE clawapi_vps_l0_active_keys gauge',
        `clawapi_vps_l0_active_keys ${l0ActiveKeys}`,
        '',
        '# HELP clawapi_vps_telemetry_batches_today Telemetry batches received today',
        '# TYPE clawapi_vps_telemetry_batches_today counter',
        `clawapi_vps_telemetry_batches_today ${todayBatches}`,
        '',
        '# HELP clawapi_vps_uptime_seconds Server uptime in seconds',
        '# TYPE clawapi_vps_uptime_seconds counter',
        `clawapi_vps_uptime_seconds ${uptimeSeconds}`,
        '',
      ];

      c.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return c.text(lines.join('\n'));
    } catch (err) {
      console.error('[Admin] 取得 Prometheus metrics 失敗：', err);
      return c.text('# Error fetching metrics\n', 500);
    }
  });

  return router;
}
