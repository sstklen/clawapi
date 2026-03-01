// Admin Handler 測試
// 驗證：Admin auth、/health 回應結構、Prometheus 格式、stats 正確性

import { describe, test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { VPSDatabase } from '../../storage/database';
import { VPSKeyManager } from '../../core/ecdh';
import { createAdminRouter } from '../admin';
import type { WebSocketManager } from '../../ws/manager';

// ===== 測試輔助 =====

function createTestDb(): VPSDatabase {
  return new VPSDatabase(':memory:');
}

// 建立 WebSocketManager Mock（只需要 getOnlineCount）
function createMockWsManager(connectionCount = 0): WebSocketManager {
  return {
    getOnlineCount: () => connectionCount,
  } as unknown as WebSocketManager;
}

// 建立 L0Manager Mock（只需要 handleDonate）
function createMockL0Manager() {
  return {
    handleDonate: async () => ({
      accepted: true,
      l0_key_id: 'test-l0-key-id',
      message: '已新增',
      validation: { key_valid: true, service_confirmed: 'openai', estimated_daily_quota: 1000 },
    }),
    checkHealth: async () => ({ checked: 0, updated: 0, warnings: 0 }),
  } as unknown as Parameters<typeof createAdminRouter>[2];
}

// 建立測試 Hono App
async function createTestApp(
  db: VPSDatabase,
  wsConnectionCount = 0,
  adminToken = 'test-admin-token',
) {
  await db.init();
  const keyManager = new VPSKeyManager(db);
  await keyManager.init();

  // 設定環境變數
  process.env['ADMIN_TOKEN'] = adminToken;

  const wsManager = createMockWsManager(wsConnectionCount);
  const l0Manager = createMockL0Manager();

  const adminRouter = createAdminRouter(db, keyManager, l0Manager, wsManager);

  const app = new Hono();
  app.route('/', adminRouter);

  return { app, db, keyManager };
}

// ===== 測試群組 =====

describe('GET /health — 公開端點', () => {
  test('正常狀態：回傳 200 + status=ok', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test('/health 結構完整：包含 checks.database/ecdh/l0/websocket', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/health');
    const body = await res.json();

    expect(body.checks).toBeDefined();
    expect(body.checks.database).toBeDefined();
    expect(body.checks.ecdh).toBeDefined();
    expect(body.checks.l0).toBeDefined();
    expect(body.checks.websocket).toBeDefined();
  });

  test('/health.checks.database 包含 status 和 size_mb', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/health');
    const body = await res.json();

    expect(body.checks.database.status).toBe('ok');
    expect(typeof body.checks.database.size_mb).toBe('number');
  });

  test('/health.checks.ecdh 包含 key_age_days', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/health');
    const body = await res.json();

    expect(body.checks.ecdh.status).toBe('ok');
    expect(typeof body.checks.ecdh.key_age_days).toBe('number');
    expect(body.checks.ecdh.key_age_days).toBeGreaterThanOrEqual(0);
  });

  test('/health.checks.websocket 包含 connections 數量', async () => {
    const { app } = await createTestApp(createTestDb(), 42);

    const res = await app.request('/health');
    const body = await res.json();

    expect(body.checks.websocket.status).toBe('ok');
    expect(body.checks.websocket.connections).toBe(42);
  });

  test('/health 不需要認證 header', async () => {
    const { app } = await createTestApp(createTestDb());

    // 完全不帶任何 header
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/health-report — Admin 認證', () => {
  test('無 X-Admin-Token：回傳 401', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/health-report');
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('ADMIN_AUTH_FAILED');
  });

  test('錯誤 Token：回傳 401', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/health-report', {
      headers: { 'X-Admin-Token': 'wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('正確 Token：回傳 200 + 完整報告', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/health-report', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBeDefined();
    expect(body.uptime).toBeDefined();
    expect(body.devices).toBeDefined();
    expect(typeof body.devices.total).toBe('number');
    expect(typeof body.devices.active).toBe('number');
    expect(body.telemetry).toBeDefined();
  });
});

describe('GET /admin/stats — 統計端點', () => {
  test('無認證：回傳 401', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/stats');
    expect(res.status).toBe(401);
  });

  test('有效認證：回傳正確統計結構', async () => {
    const { app } = await createTestApp(createTestDb(), 15);

    const res = await app.request('/admin/stats', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    expect(res.status).toBe(200);

    const body = await res.json();

    // 裝置統計
    expect(body.devices).toBeDefined();
    expect(typeof body.devices.total).toBe('number');
    expect(typeof body.devices.active_24h).toBe('number');

    // WebSocket 統計
    expect(body.websocket).toBeDefined();
    expect(body.websocket.connections).toBe(15);

    // 遙測統計
    expect(body.telemetry).toBeDefined();
    expect(typeof body.telemetry.batches_today).toBe('number');

    // L0 Key 統計
    expect(body.l0_keys).toBeDefined();
    expect(typeof body.l0_keys.active).toBe('number');

    // server_time
    expect(body.server_time).toBeDefined();
  });

  test('空 DB：裝置數應為 0', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/stats', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    const body = await res.json();

    expect(body.devices.total).toBe(0);
    expect(body.devices.active_24h).toBe(0);
  });
});

describe('GET /admin/prometheus — Prometheus metrics', () => {
  test('無認證：回傳 401', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/prometheus');
    expect(res.status).toBe(401);
  });

  test('有效認證：Content-Type 應為 text/plain', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/prometheus', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  test('Prometheus 格式包含必要 metrics', async () => {
    const { app } = await createTestApp(createTestDb(), 42);

    const res = await app.request('/admin/prometheus', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    const text = await res.text();

    // 驗證必要的 metric 名稱
    expect(text).toContain('clawapi_vps_devices_total');
    expect(text).toContain('clawapi_vps_ws_connections');
    expect(text).toContain('clawapi_vps_l0_usage_today');
    expect(text).toContain('clawapi_vps_l0_active_keys');
    expect(text).toContain('clawapi_vps_uptime_seconds');
  });

  test('Prometheus 格式包含 # HELP 和 # TYPE 註解', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/prometheus', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    const text = await res.text();

    expect(text).toContain('# HELP clawapi_vps_devices_total');
    expect(text).toContain('# TYPE clawapi_vps_devices_total gauge');
    expect(text).toContain('# HELP clawapi_vps_ws_connections');
    expect(text).toContain('# TYPE clawapi_vps_ws_connections gauge');
    expect(text).toContain('# HELP clawapi_vps_l0_usage_today');
    expect(text).toContain('# TYPE clawapi_vps_l0_usage_today counter');
  });

  test('Prometheus ws_connections 反映實際連線數', async () => {
    const { app } = await createTestApp(createTestDb(), 99);

    const res = await app.request('/admin/prometheus', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    const text = await res.text();

    // ws_connections 應為 99
    expect(text).toContain('clawapi_vps_ws_connections 99');
  });

  test('Prometheus 每行格式：metric_name 數字', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/prometheus', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    const text = await res.text();

    // 每個 metric 行都應符合 Prometheus 格式（metric_name 數字）
    const metricLines = text
      .split('\n')
      .filter((line) => line.startsWith('clawapi_'));

    for (const line of metricLines) {
      // 格式：clawapi_xxx_yyy 數字
      expect(line).toMatch(/^clawapi_\w+ \d+$/);
    }
  });
});

describe('POST /admin/l0/add-key — 手動新增 L0 Key', () => {
  test('無認證：回傳 401', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/l0/add-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id: 'openai', key_value: 'sk-test' }),
    });
    expect(res.status).toBe(401);
  });

  test('缺少必填欄位：回傳 400', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/l0/add-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'test-admin-token',
      },
      body: JSON.stringify({ service_id: 'openai' }), // 缺少 key_value
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
  });

  test('有效請求：mock L0Manager 回傳成功', async () => {
    const { app } = await createTestApp(createTestDb());

    const res = await app.request('/admin/l0/add-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'test-admin-token',
      },
      body: JSON.stringify({
        service_id: 'openai',
        key_value: 'sk-test-key-12345',
        display_name: '測試 Key',
      }),
    });

    // Mock L0Manager 應回傳成功
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(true);
    expect(body.l0_key_id).toBe('test-l0-key-id');
  });
});
