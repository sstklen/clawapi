// E2E 測試 01：裝置註冊流程
// 驗證：Engine 的裝置透過 VPS 完成註冊 → 拿 Token → 使用 Token 存取受保護端點

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createVPSApp,
  registerDevice,
  makeVPSRequest,
  generateDeviceId,
  type VPSApp,
} from './helpers/setup';

describe('E2E 01：裝置註冊流程', () => {
  let vps: VPSApp;

  beforeEach(async () => {
    vps = await createVPSApp();
  });

  test('1-1. 完整註冊流程：POST /v1/devices/register → 取得 token + vps_public_key', async () => {
    const deviceId = generateDeviceId();

    const res = await vps.app.request('/v1/devices/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceId,
        device_fingerprint: 'fp_e2e_test_01',
        client_version: '0.1.0',
        os: 'darwin',
        arch: 'arm64',
        locale: 'zh-TW',
        timezone: 'Asia/Taipei',
      }),
    });

    expect(res.status).toBe(200);

    const body = await res.json() as {
      device_id: string;
      device_token: string;
      expires_at: string;
      vps_public_key: string;
      vps_public_key_id: string;
      assigned_region: string;
    };

    // 驗證回傳欄位
    expect(body.device_id).toBe(deviceId);
    expect(body.device_token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.vps_public_key).toBeTruthy();
    expect(body.vps_public_key_id).toBeTruthy();
    expect(body.assigned_region).toBe('asia'); // Asia/Taipei → asia

    // 驗證 token 到期日約 120 天後
    const expiresAt = new Date(body.expires_at);
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(118);
    expect(diffDays).toBeLessThan(122);
  });

  test('1-2. 用 device_token 呼叫受保護端點（GET /v1/telemetry/quota）確認認證通過', async () => {
    // 先註冊
    const device = await registerDevice(vps.app);

    // 用 token 存取受保護的端點
    const res = await makeVPSRequest(vps.app, 'GET', '/v1/telemetry/quota', device);

    // 應成功（200）
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  test('1-3. 無效 token 存取受保護端點 → 401', async () => {
    const device = await registerDevice(vps.app);

    // 用假 token 存取
    const fakeDevice = {
      ...device,
      device_token: '0'.repeat(64),
    };

    const res = await makeVPSRequest(vps.app, 'GET', '/v1/telemetry/quota', fakeDevice);
    expect(res.status).toBe(401);
  });

  test('1-4. POST /v1/devices/refresh → 取得新 token 且舊 token 失效', async () => {
    const device = await registerDevice(vps.app);
    const oldToken = device.device_token;

    // 刷新 token
    const refreshRes = await makeVPSRequest(
      vps.app, 'POST', '/v1/devices/refresh', device, {},
    );

    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as {
      device_token: string;
      expires_at: string;
    };

    // 新 token 格式正確
    expect(refreshBody.device_token).toMatch(/^[0-9a-f]{64}$/);
    expect(refreshBody.expires_at).toBeTruthy();

    // 用新 token 存取受保護端點
    const newDevice = {
      ...device,
      device_token: refreshBody.device_token,
    };
    const newRes = await makeVPSRequest(vps.app, 'GET', '/v1/telemetry/quota', newDevice);
    expect(newRes.status).toBe(200);

    // 舊 token 應該失效
    const oldRes = await makeVPSRequest(vps.app, 'GET', '/v1/telemetry/quota', device);
    expect(oldRes.status).toBe(401);
  });

  test('1-5. 重複註冊 → 409 DEVICE_ALREADY_REGISTERED', async () => {
    const deviceId = generateDeviceId();
    await registerDevice(vps.app, deviceId);

    // 第二次嘗試同一 device_id
    const res = await vps.app.request('/v1/devices/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceId,
        device_fingerprint: 'fp_another',
        client_version: '0.1.0',
        os: 'darwin',
        arch: 'arm64',
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('DEVICE_ALREADY_REGISTERED');
  });

  test('1-6. 無 auth headers 存取受保護端點 → 401', async () => {
    const res = await vps.app.request('/v1/telemetry/quota');
    expect(res.status).toBe(401);

    const body = await res.json() as { error: string };
    expect(body.error).toBe('AUTH_MISSING_HEADERS');
  });
});
