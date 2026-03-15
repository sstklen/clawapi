// Auth Middleware 單元測試
// 測試：5 種失敗場景 + 成功場景

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { VPSDatabase } from '../../storage/database';
import { deviceAuth, adminAuth } from '../auth';
import type { AuthVariables } from '../auth';

// 建立測試用 Hono app（套用 AuthVariables 型別）
function createTestApp(db: VPSDatabase) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('/v1/*', deviceAuth(db));
  app.get('/v1/test', (c) => {
    const device = c.get('device');
    return c.json({ ok: true, deviceId: device?.device_id });
  });
  app.get('/v1/devices/register', (c) => c.json({ skipped: true }));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  return app;
}

// 測試用裝置資料（token 未過期）
const VALID_DEVICE = {
  device_id: 'clw_auth_test01',
  device_fingerprint: 'fp_auth_test',
  device_token: 'tok_valid_abc123',
  token_expires_at: '2099-12-31T00:00:00Z',  // 未過期
  client_version: '0.1.0',
  os: 'darwin',
  arch: 'arm64',
};

// 測試用裝置資料（token 已過期）
const EXPIRED_DEVICE = {
  device_id: 'clw_expired01',
  device_fingerprint: 'fp_expired',
  device_token: 'tok_expired_xyz',
  token_expires_at: '2000-01-01T00:00:00Z',  // 已過期
  client_version: '0.1.0',
  os: 'linux',
  arch: 'x64',
};

// 測試用裝置資料（被暫停）
const SUSPENDED_DEVICE = {
  device_id: 'clw_suspended01',
  device_fingerprint: 'fp_suspended',
  device_token: 'tok_suspended_abc',
  token_expires_at: '2099-12-31T00:00:00Z',
  client_version: '0.1.0',
  os: 'win32',
  arch: 'x64',
};

describe('deviceAuth Middleware', () => {
  let db: VPSDatabase;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    db = new VPSDatabase(':memory:');
    await db.init();

    // 插入測試裝置
    db.run(
      `INSERT INTO devices
        (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        VALID_DEVICE.device_id,
        VALID_DEVICE.device_fingerprint,
        VALID_DEVICE.device_token,
        VALID_DEVICE.token_expires_at,
        VALID_DEVICE.client_version,
        VALID_DEVICE.os,
        VALID_DEVICE.arch,
      ],
    );

    db.run(
      `INSERT INTO devices
        (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        EXPIRED_DEVICE.device_id,
        EXPIRED_DEVICE.device_fingerprint,
        EXPIRED_DEVICE.device_token,
        EXPIRED_DEVICE.token_expires_at,
        EXPIRED_DEVICE.client_version,
        EXPIRED_DEVICE.os,
        EXPIRED_DEVICE.arch,
      ],
    );

    db.run(
      `INSERT INTO devices
        (device_id, device_fingerprint, device_token, token_expires_at, client_version, os, arch, status, suspended_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        SUSPENDED_DEVICE.device_id,
        SUSPENDED_DEVICE.device_fingerprint,
        SUSPENDED_DEVICE.device_token,
        SUSPENDED_DEVICE.token_expires_at,
        SUSPENDED_DEVICE.client_version,
        SUSPENDED_DEVICE.os,
        SUSPENDED_DEVICE.arch,
        'suspended',
        '異常刷單行為',
      ],
    );

    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.close();
  });

  // ===== 失敗場景 =====

  it('場景 1：缺少 header → 401 AUTH_MISSING_HEADERS', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      // 沒有任何 auth header
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('AUTH_MISSING_HEADERS');
  });

  it('場景 1b：只有 X-Device-Id，缺少 X-Device-Token → 401', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      headers: { 'X-Device-Id': 'clw_auth_test01' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('AUTH_MISSING_HEADERS');
  });

  it('場景 2：device 不存在 → 401 AUTH_DEVICE_NOT_FOUND', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      headers: {
        'X-Device-Id': 'clw_not_exist',
        'X-Device-Token': 'tok_whatever',
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('AUTH_DEVICE_NOT_FOUND');
  });

  it('場景 3：token 不匹配 → 401 AUTH_INVALID_TOKEN', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      headers: {
        'X-Device-Id': VALID_DEVICE.device_id,
        'X-Device-Token': 'tok_wrong_token',
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('AUTH_INVALID_TOKEN');
  });

  it('場景 4：token 過期 → 401 AUTH_TOKEN_EXPIRED', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      headers: {
        'X-Device-Id': EXPIRED_DEVICE.device_id,
        'X-Device-Token': EXPIRED_DEVICE.device_token,
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string; suggestion: string };
    expect(body.error).toBe('AUTH_TOKEN_EXPIRED');
    expect(body.suggestion).toContain('refresh');
  });

  it('場景 5a：fingerprint 不符 → 403 DEVICE_FINGERPRINT_MISMATCH', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      headers: {
        'X-Device-Id': VALID_DEVICE.device_id,
        'X-Device-Token': VALID_DEVICE.device_token,
        'X-Device-Fingerprint': 'fp_wrong_fingerprint',  // 不符
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('DEVICE_FINGERPRINT_MISMATCH');
  });

  it('場景 5b：裝置被暫停 → 403 DEVICE_SUSPENDED', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      headers: {
        'X-Device-Id': SUSPENDED_DEVICE.device_id,
        'X-Device-Token': SUSPENDED_DEVICE.device_token,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('DEVICE_SUSPENDED');
    expect(body.message).toContain('異常刷單行為');
  });

  // ===== 成功場景 =====

  it('通過認證 → 200，device 存入 context', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      headers: {
        'X-Device-Id': VALID_DEVICE.device_id,
        'X-Device-Token': VALID_DEVICE.device_token,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; deviceId: string };
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(VALID_DEVICE.device_id);
  });

  it('fingerprint 符合時應通過認證', async () => {
    const res = await app.request('/v1/test', {
      method: 'GET',
      headers: {
        'X-Device-Id': VALID_DEVICE.device_id,
        'X-Device-Token': VALID_DEVICE.device_token,
        'X-Device-Fingerprint': VALID_DEVICE.device_fingerprint,  // 正確的 fingerprint
      },
    });
    expect(res.status).toBe(200);
  });

  // ===== Skip paths 測試 =====

  it('skipPaths：/v1/devices/register 不需要認證', async () => {
    const res = await app.request('/v1/devices/register', {
      method: 'GET',
      // 沒有任何 auth header
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { skipped: boolean };
    expect(body.skipped).toBe(true);
  });

  it('skipPaths：/health 不需要認證', async () => {
    const res = await app.request('/health', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('adminAuth Middleware', () => {
  let app: Hono;
  const TEST_ADMIN_TOKEN = 'test_admin_token_abc';

  beforeEach(() => {
    // 設定測試用 admin token
    process.env['ADMIN_TOKEN'] = TEST_ADMIN_TOKEN;

    app = new Hono();
    app.use('/admin/*', adminAuth());
    app.get('/admin/stats', (c) => c.json({ stats: true }));
  });

  afterEach(() => {
    delete process.env['ADMIN_TOKEN'];
  });

  it('缺少 Authorization header → 401', async () => {
    const res = await app.request('/admin/stats', { method: 'GET' });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('AUTH_MISSING_HEADERS');
  });

  it('錯誤的 Bearer token → 401', async () => {
    const res = await app.request('/admin/stats', {
      method: 'GET',
      headers: { Authorization: 'Bearer wrong_token' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('AUTH_INVALID_TOKEN');
  });

  it('正確的 Bearer token → 200', async () => {
    const res = await app.request('/admin/stats', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { stats: boolean };
    expect(body.stats).toBe(true);
  });
});
