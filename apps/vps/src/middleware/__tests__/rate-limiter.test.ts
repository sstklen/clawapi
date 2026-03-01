// Rate Limiter Middleware 單元測試
// 測試：21 個端點覆蓋、超限回 429、正確 headers

import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { rateLimiter, clearRateLimitStore, checkIpDeviceLimit, registerIpDevice, clearIpDeviceRegistry } from '../rate-limiter';
import { RATE_LIMITS } from '@clawapi/protocol';

// 建立測試用 Hono app（掛載 rate limiter）
function createTestApp() {
  const app = new Hono();
  app.use('*', rateLimiter());

  // 為每個 RATE_LIMITS 端點都建立對應路由
  for (const key of Object.keys(RATE_LIMITS)) {
    const [method, ...pathParts] = key.split(' ');
    const path = pathParts.join(' ');
    const m = method?.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    if (m && path) {
      app[m](path, (c) => c.json({ ok: true }));
    }
  }

  return app;
}

// 發送多次請求到同一端點（使用同一個 device_id）
async function sendRequests(
  app: Hono,
  method: string,
  path: string,
  count: number,
  deviceId = 'clw_rate_test01',
): Promise<Response[]> {
  const results: Response[] = [];
  for (let i = 0; i < count; i++) {
    const res = await app.request(path, {
      method,
      headers: { 'X-Device-Id': deviceId },
    });
    results.push(res);
  }
  return results;
}

describe('rateLimiter Middleware', () => {
  let app: Hono;

  beforeEach(() => {
    // 每個測試前清空 rate limit 記錄
    clearRateLimitStore();
    app = createTestApp();
  });

  // ===== 核心功能測試 =====

  it('POST /v1/telemetry/batch：第 3 次應回 429（limit=2）', async () => {
    const responses = await sendRequests(app, 'POST', '/v1/telemetry/batch', 3);

    expect(responses[0]?.status).toBe(200);
    expect(responses[1]?.status).toBe(200);
    expect(responses[2]?.status).toBe(429);

    const body = await responses[2]!.json() as { error: string; retry_after: number };
    expect(body.error).toBe('RATE_LIMIT_EXCEEDED');
    expect(typeof body.retry_after).toBe('number');
    expect(body.retry_after).toBeGreaterThan(0);
  });

  it('超限回應應帶正確 X-RateLimit-* headers', async () => {
    const responses = await sendRequests(app, 'POST', '/v1/telemetry/batch', 3);
    const limited = responses[2]!;

    expect(limited.status).toBe(429);
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
    // X-RateLimit-Reset 應為 Unix timestamp（10 位數）
    const resetTs = limited.headers.get('X-RateLimit-Reset');
    expect(resetTs).not.toBeNull();
    expect(Number(resetTs)).toBeGreaterThan(Date.now() / 1000);
  });

  it('正常請求應帶 X-RateLimit-* headers', async () => {
    const res = await app.request('/v1/telemetry/batch', {
      method: 'POST',
      headers: { 'X-Device-Id': 'clw_header_test' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('1');  // 2-1=1
    expect(res.headers.get('X-RateLimit-Reset')).not.toBeNull();
  });

  // ===== 隔離性測試（不同 device_id 互不影響）=====

  it('不同 device_id 的計數應互相獨立', async () => {
    // device A 已用完額度
    await sendRequests(app, 'POST', '/v1/telemetry/batch', 2, 'clw_device_a');

    // device B 應該還能請求
    const res = await app.request('/v1/telemetry/batch', {
      method: 'POST',
      headers: { 'X-Device-Id': 'clw_device_b' },
    });
    expect(res.status).toBe(200);
  });

  // ===== 沒有設定 rate limit 的端點應直接放行 =====

  it('沒有設定 rate limit 的端點應直接放行', async () => {
    const testApp = new Hono();
    testApp.use('*', rateLimiter());
    testApp.get('/v1/some-unknown-endpoint', (c) => c.json({ ok: true }));

    const res = await testApp.request('/v1/some-unknown-endpoint', {
      method: 'GET',
      headers: { 'X-Device-Id': 'clw_test' },
    });
    expect(res.status).toBe(200);
    // 沒有 rate limit headers
    expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
  });

  // ===== 21 個端點全部覆蓋測試 =====

  it('RATE_LIMITS 應定義 21 個端點', () => {
    const count = Object.keys(RATE_LIMITS).length;
    expect(count).toBe(21);
  });

  describe('各端點 limit 驗證', () => {
    const endpointsToTest: Array<{ method: string; path: string; limit: number }> = [
      { method: 'POST', path: '/v1/devices/register',   limit: 5  },
      { method: 'POST', path: '/v1/devices/refresh',    limit: 10 },
      { method: 'POST', path: '/v1/devices/reset',      limit: 3  },
      { method: 'POST', path: '/v1/auth/google',        limit: 10 },
      { method: 'POST', path: '/v1/telemetry/batch',    limit: 2  },
      { method: 'POST', path: '/v1/telemetry/feedback', limit: 20 },
      { method: 'GET',  path: '/v1/telemetry/quota',    limit: 30 },
      { method: 'GET',  path: '/v1/l0/keys',            limit: 10 },
      { method: 'POST', path: '/v1/l0/usage',           limit: 60 },
      { method: 'POST', path: '/v1/l0/donate',          limit: 5  },
      { method: 'POST', path: '/v1/aid/request',        limit: 30 },
      { method: 'PUT',  path: '/v1/aid/config',         limit: 10 },
      { method: 'GET',  path: '/v1/aid/config',         limit: 30 },
      { method: 'GET',  path: '/v1/aid/stats',          limit: 30 },
      { method: 'GET',  path: '/v1/version/check',      limit: 5  },
      { method: 'GET',  path: '/v1/adapters/updates',   limit: 5  },
      { method: 'GET',  path: '/v1/adapters/official',  limit: 10 },
      { method: 'PUT',  path: '/v1/backup',             limit: 5  },
      { method: 'GET',  path: '/v1/backup',             limit: 10 },
      { method: 'DELETE', path: '/v1/backup',           limit: 3  },
      { method: 'POST', path: '/v1/subkeys/validate',   limit: 60 },
    ];

    for (const { method, path, limit } of endpointsToTest) {
      it(`${method} ${path}：X-RateLimit-Limit 應為 ${limit}`, async () => {
        clearRateLimitStore();
        const res = await app.request(path, {
          method,
          headers: { 'X-Device-Id': `clw_endpoint_check_${Math.random()}` },
        });
        // 確認回應帶有正確的 limit header
        expect(res.headers.get('X-RateLimit-Limit')).toBe(limit.toString());
      });
    }
  });

  // ===== 第 N 次（剛好等於 limit）應仍能通過 =====

  it('剛好等於 limit 的請求應通過，超過才 429', async () => {
    // POST /v1/devices/reset limit=3
    const responses = await sendRequests(app, 'POST', '/v1/devices/reset', 4);

    expect(responses[0]?.status).toBe(200);  // 第 1 次 ok
    expect(responses[1]?.status).toBe(200);  // 第 2 次 ok
    expect(responses[2]?.status).toBe(200);  // 第 3 次 ok（limit=3，恰好）
    expect(responses[3]?.status).toBe(429);  // 第 4 次 429
  });

  // ===== Remaining 計數正確性 =====

  it('X-RateLimit-Remaining 應正確遞減', async () => {
    // limit=5 for POST /v1/devices/register
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/v1/devices/register', {
        method: 'POST',
        headers: { 'X-Device-Id': 'clw_remaining_test' },
      });
      const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
      expect(remaining).toBe(5 - 1 - i);  // 5-1=4, 5-1-1=3, ...
    }
  });
});

// ===== IP 裝置限制測試 =====

describe('checkIpDeviceLimit / registerIpDevice', () => {
  beforeEach(() => {
    clearIpDeviceRegistry();
  });

  it('同 IP 前 5 個 device_id 應通過', () => {
    const ip = '192.168.1.1';
    for (let i = 1; i <= 5; i++) {
      const deviceId = `clw_ip_${i}`;
      expect(checkIpDeviceLimit(ip, deviceId)).toBe(true);
      registerIpDevice(ip, deviceId);
    }
  });

  it('同 IP 第 6 個 device_id 應被拒絕', () => {
    const ip = '192.168.1.2';
    for (let i = 1; i <= 5; i++) {
      registerIpDevice(ip, `clw_ip2_${i}`);
    }
    // 第 6 個新 device_id
    expect(checkIpDeviceLimit(ip, 'clw_ip2_6')).toBe(false);
  });

  it('已存在的 device_id 再次檢查應通過（不算新增）', () => {
    const ip = '192.168.1.3';
    for (let i = 1; i <= 5; i++) {
      registerIpDevice(ip, `clw_ip3_${i}`);
    }
    // 已存在的 device_id 應該仍可通過
    expect(checkIpDeviceLimit(ip, 'clw_ip3_3')).toBe(true);
  });

  it('不同 IP 的限制應互相獨立', () => {
    const ip1 = '10.0.0.1';
    const ip2 = '10.0.0.2';

    // ip1 已滿 5 個
    for (let i = 1; i <= 5; i++) {
      registerIpDevice(ip1, `clw_ipdiff_${i}`);
    }
    expect(checkIpDeviceLimit(ip1, 'clw_ipdiff_6')).toBe(false);

    // ip2 還可以新增
    expect(checkIpDeviceLimit(ip2, 'clw_ipdiff_new')).toBe(true);
  });
});
