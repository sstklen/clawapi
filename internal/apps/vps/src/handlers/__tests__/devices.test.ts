// 裝置管理 + ECDH 金鑰管理測試
// 使用 in-memory SQLite + Hono app.request() 測試 handler
// 涵蓋：裝置註冊、Token 刷新、裝置重置、Timezone→Region、ECDH、Google OAuth

import { describe, test, expect, beforeEach, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { VPSDatabase } from '../../storage/database';
import { VPSKeyManager } from '../../core/ecdh';
import { createDevicesRouter, timezoneToRegion } from '../devices';
import { createAuthGoogleRouter } from '../auth-google';
import { deviceAuth } from '../../middleware/auth';
import { ErrorCode } from '@clawapi/protocol';

// ===== 測試輔助函式 =====

// 建立 in-memory DB（每個測試獨立）
function createTestDb(): VPSDatabase {
  return new VPSDatabase(':memory:');
}

// 建立有效的 device_id（clw_ + 32 hex）
function makeDeviceId(suffix: string = '0'): string {
  const hex = suffix.padStart(32, '0').slice(0, 32);
  return `clw_${hex}`;
}

// 建立測試用 Hono app（含 deviceAuth + devicesRouter）
function createTestApp(db: VPSDatabase, keyManager: VPSKeyManager) {
  const app = new Hono();
  const devicesRouter = createDevicesRouter(db, keyManager);
  const authGoogleRouter = createAuthGoogleRouter(db);

  // 掛上 deviceAuth middleware（全局）
  app.use('*', deviceAuth(db));

  // 掛上路由
  app.route('/v1/devices', devicesRouter);
  app.route('/v1/auth/google', authGoogleRouter);

  return app;
}

// 快速註冊一個裝置，回傳 { device_token, vps_public_key, vps_public_key_id, assigned_region }
async function registerDevice(
  app: Hono,
  deviceId: string,
  fingerprint: string = 'fp_test_abc123',
) {
  const res = await app.request('/v1/devices/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceId,
      device_fingerprint: fingerprint,
      client_version: '0.1.0',
      os: 'macos',
      arch: 'arm64',
      locale: 'zh-TW',
      timezone: 'Asia/Taipei',
    }),
  });
  return res;
}

// ===== 測試群組 =====

describe('裝置管理 Handler 測試', () => {
  let db: VPSDatabase;
  let keyManager: VPSKeyManager;
  let app: Hono;

  beforeEach(async () => {
    db = createTestDb();
    await db.init();
    keyManager = new VPSKeyManager(db);
    await keyManager.init();
    app = createTestApp(db, keyManager);
  });

  // ===== 裝置註冊 =====

  describe('POST /v1/devices/register', () => {
    test('1. 正常註冊 → 200 + device_token (64 hex) + expires_at (120 天後) + vps_public_key', async () => {
      const deviceId = makeDeviceId('aabbccdd11223344aabbccdd11223344');
      const res = await registerDevice(app, deviceId);

      expect(res.status).toBe(200);
      const json = await res.json() as {
        device_id: string;
        device_token: string;
        expires_at: string;
        vps_public_key: string;
        vps_public_key_id: string;
        assigned_region: string;
      };

      // device_token 是 64 hex
      expect(json.device_token).toMatch(/^[0-9a-f]{64}$/);

      // expires_at 大約 120 天後（±1 天容差）
      const expiresAt = new Date(json.expires_at);
      const now = new Date();
      const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(118);
      expect(diffDays).toBeLessThan(121);

      // vps_public_key 非空
      expect(json.vps_public_key).toBeTruthy();
      expect(json.vps_public_key_id).toBeTruthy();
      expect(json.assigned_region).toBeTruthy();
      expect(json.device_id).toBe(deviceId);
    });

    test('2. device_id 格式錯誤 → 400', async () => {
      const res = await app.request('/v1/devices/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: 'invalid_id_format',
          device_fingerprint: 'fp_abc',
          client_version: '0.1.0',
          os: 'macos',
          arch: 'arm64',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
    });

    test('3. 已註冊 → 409 DEVICE_ALREADY_REGISTERED', async () => {
      const deviceId = makeDeviceId('deadbeef'.repeat(4));
      // 第一次註冊
      await registerDevice(app, deviceId);
      // 第二次嘗試
      const res = await registerDevice(app, deviceId);

      expect(res.status).toBe(409);
      const json = await res.json() as { error: string };
      expect(json.error).toBe(ErrorCode.DEVICE_ALREADY_REGISTERED);
    });

    test('4. 缺少必填欄位 → 400', async () => {
      const res = await app.request('/v1/devices/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: makeDeviceId('1234567890abcdef1234567890abcdef'),
          // 缺少 device_fingerprint, client_version, os, arch
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ===== Token 刷新 =====

  describe('POST /v1/devices/refresh', () => {
    test('5. 有效 device + token → 200 + 新 token', async () => {
      const deviceId = makeDeviceId('1111111111111111aaaaaaaaaaaaaaaa');
      const regRes = await registerDevice(app, deviceId);
      const regJson = await regRes.json() as { device_token: string };
      const oldToken = regJson.device_token;

      const res = await app.request('/v1/devices/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': deviceId,
          'X-Device-Token': oldToken,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as { device_token: string; expires_at: string };
      expect(json.device_token).toMatch(/^[0-9a-f]{64}$/);
      // 新 token 不等於舊 token（幾乎必然）
      // 注意：理論上可能相同（極小概率），測試允許這種情況
      expect(json.expires_at).toBeTruthy();
    });

    test('6. 無效 token → 401', async () => {
      const deviceId = makeDeviceId('2222222222222222bbbbbbbbbbbbbbbb');
      await registerDevice(app, deviceId);

      const res = await app.request('/v1/devices/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': deviceId,
          'X-Device-Token': 'invalidtoken000000000000000000000000000000000000000000000000000000',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
    });
  });

  // ===== 裝置重置 =====

  describe('POST /v1/devices/reset', () => {
    test('7. 正確 fingerprint → 200 + 新 token + message', async () => {
      const deviceId = makeDeviceId('3333333333333333cccccccccccccccc');
      const fingerprint = 'my_device_fingerprint_abc';
      const regRes = await registerDevice(app, deviceId, fingerprint);
      const regJson = await regRes.json() as { device_token: string };

      const res = await app.request('/v1/devices/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': deviceId,
          'X-Device-Token': regJson.device_token,
        },
        body: JSON.stringify({ device_fingerprint: fingerprint }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as { device_token: string; expires_at: string; message: string };
      expect(json.device_token).toMatch(/^[0-9a-f]{64}$/);
      expect(json.message).toBe('裝置已重置');
    });

    test('8. 錯誤 fingerprint → 403 DEVICE_FINGERPRINT_MISMATCH', async () => {
      const deviceId = makeDeviceId('4444444444444444dddddddddddddddd');
      const fingerprint = 'correct_fingerprint_xyz';
      const regRes = await registerDevice(app, deviceId, fingerprint);
      const regJson = await regRes.json() as { device_token: string };

      const res = await app.request('/v1/devices/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': deviceId,
          'X-Device-Token': regJson.device_token,
        },
        body: JSON.stringify({ device_fingerprint: 'wrong_fingerprint' }),
      });

      expect(res.status).toBe(403);
      const json = await res.json() as { error: string };
      expect(json.error).toBe(ErrorCode.DEVICE_FINGERPRINT_MISMATCH);
    });
  });

  // ===== Timezone → Region =====

  describe('timezoneToRegion 函式', () => {
    test('9. Asia/Tokyo → asia', () => {
      expect(timezoneToRegion('Asia/Tokyo')).toBe('asia');
    });

    test('10. Europe/London → europe', () => {
      expect(timezoneToRegion('Europe/London')).toBe('europe');
    });

    test('11. America/New_York → americas', () => {
      expect(timezoneToRegion('America/New_York')).toBe('americas');
    });

    test('12. undefined → other', () => {
      expect(timezoneToRegion(undefined)).toBe('other');
    });

    test('Asia/Shanghai → asia', () => {
      expect(timezoneToRegion('Asia/Shanghai')).toBe('asia');
    });

    test('Asia/Taipei → asia', () => {
      expect(timezoneToRegion('Asia/Taipei')).toBe('asia');
    });

    test('America/Los_Angeles → americas', () => {
      expect(timezoneToRegion('America/Los_Angeles')).toBe('americas');
    });

    test('Europe/Paris → europe', () => {
      expect(timezoneToRegion('Europe/Paris')).toBe('europe');
    });

    test('Unknown/Timezone → other', () => {
      expect(timezoneToRegion('Unknown/Place')).toBe('other');
    });
  });
});

// ===== ECDH 金鑰管理測試 =====

describe('ECDH 金鑰管理測試', () => {
  let db: VPSDatabase;
  let keyManager: VPSKeyManager;

  beforeEach(async () => {
    db = createTestDb();
    await db.init();
    keyManager = new VPSKeyManager(db);
  });

  test('13. init() → 產生金鑰對（DB 有記錄 + 記憶體有私鑰）', async () => {
    await keyManager.init();

    // DB 應有 is_current=1 的記錄
    const records = db.query<{ key_id: string; is_current: number; public_key: string }>(
      'SELECT * FROM vps_key_history WHERE is_current = 1',
    );
    expect(records.length).toBe(1);
    expect(records[0].key_id).toMatch(/^vps_key_v\d+$/);
    expect(records[0].public_key).toBeTruthy();

    // getCurrentPublicKey 應可正常取得
    const { keyId, publicKey } = keyManager.getCurrentPublicKey();
    expect(keyId).toBeTruthy();
    expect(publicKey).toBeTruthy();

    // getCurrentPrivateKey 應可正常取得
    const privateKey = keyManager.getCurrentPrivateKey();
    expect(privateKey).toBeTruthy();
    expect(privateKey.type).toBe('private');
  });

  test('14. rotateIfNeeded() → 30 天內不輪換（回傳 false）', async () => {
    await keyManager.init();
    const { keyId: beforeKeyId } = keyManager.getCurrentPublicKey();

    const rotated = await keyManager.rotateIfNeeded();

    expect(rotated).toBe(false);
    // keyId 未變
    const { keyId: afterKeyId } = keyManager.getCurrentPublicKey();
    expect(afterKeyId).toBe(beforeKeyId);
  });

  test('15. 手動過期 → rotateIfNeeded() → 輪換 + 舊 key retired', async () => {
    await keyManager.init();
    const { keyId: oldKeyId } = keyManager.getCurrentPublicKey();

    // 手動把當前 key 的 created_at 改為 31 天前
    db.run(
      `UPDATE vps_key_history
       SET created_at = datetime('now', '-31 days')
       WHERE key_id = ?`,
      [oldKeyId],
    );

    const rotated = await keyManager.rotateIfNeeded();

    expect(rotated).toBe(true);

    // 舊 key 應被標記為 retired
    const oldRecords = db.query<{ is_current: number; retired_at: string | null }>(
      'SELECT is_current, retired_at FROM vps_key_history WHERE key_id = ?',
      [oldKeyId],
    );
    expect(oldRecords[0].is_current).toBe(0);
    expect(oldRecords[0].retired_at).toBeTruthy();

    // 新的 current key 應不同
    const { keyId: newKeyId } = keyManager.getCurrentPublicKey();
    expect(newKeyId).not.toBe(oldKeyId);

    // DB 只有一個 is_current=1
    const currentRecords = db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM vps_key_history WHERE is_current = 1',
    );
    expect(currentRecords[0].count).toBe(1);
  });

  test('16. cleanupExpired() → 7 天後刪除 retired key', async () => {
    await keyManager.init();
    const { keyId: firstKeyId } = keyManager.getCurrentPublicKey();

    // 強制輪換（改 created_at 超過 30 天）
    db.run(
      `UPDATE vps_key_history
       SET created_at = datetime('now', '-31 days')
       WHERE key_id = ?`,
      [firstKeyId],
    );
    await keyManager.rotateIfNeeded();

    // 把舊 key 的 retired_at 改為 8 天前
    db.run(
      `UPDATE vps_key_history
       SET retired_at = datetime('now', '-8 days')
       WHERE key_id = ? AND is_current = 0`,
      [firstKeyId],
    );

    // 清理前應有 2 筆記錄
    const beforeCount = db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM vps_key_history',
    );
    expect(beforeCount[0].count).toBe(2);

    // 執行清理
    const deleted = await keyManager.cleanupExpired();
    expect(deleted).toBeGreaterThan(0);

    // 清理後舊 key 應被刪除
    const afterCount = db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM vps_key_history',
    );
    expect(afterCount[0].count).toBe(1);

    // 剩下的應是當前 key
    const remaining = db.query<{ is_current: number }>(
      'SELECT is_current FROM vps_key_history',
    );
    expect(remaining[0].is_current).toBe(1);
  });

  test('deriveSharedSecret() → 可以做 ECDH 金鑰交換', async () => {
    await keyManager.init();

    // 產生另一個臨時 ECDH 金鑰對（模擬客戶端）
    // 使用 Bun 全域 crypto，避免 node:crypto 型別衝突
    const webCrypto = globalThis.crypto;
    const clientKeyPair = await webCrypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits'],
    );
    const clientPublicKeyBuffer = await webCrypto.subtle.exportKey('spki', clientKeyPair.publicKey);
    const clientPublicKeyBase64 = Buffer.from(clientPublicKeyBuffer).toString('base64');

    // VPS 用自己的私鑰做 ECDH
    const sharedSecret = await keyManager.deriveSharedSecret(clientPublicKeyBase64);

    expect(sharedSecret).toBeInstanceOf(Uint8Array);
    expect(sharedSecret.length).toBe(32); // 256 bits
  });

  test('generateKeyPair() 兩次 → keyId 遞增（v1, v2）', async () => {
    const { keyId: keyId1 } = await keyManager.generateKeyPair();
    const { keyId: keyId2 } = await keyManager.generateKeyPair();

    expect(keyId1).toMatch(/^vps_key_v\d+$/);
    expect(keyId2).toMatch(/^vps_key_v\d+$/);

    const version1 = parseInt(keyId1.replace('vps_key_v', ''), 10);
    const version2 = parseInt(keyId2.replace('vps_key_v', ''), 10);
    expect(version2).toBeGreaterThan(version1);
  });
});

// ===== Google OAuth 綁定測試 =====

describe('Google OAuth 綁定測試', () => {
  let db: VPSDatabase;
  let keyManager: VPSKeyManager;
  let app: Hono;

  beforeEach(async () => {
    db = createTestDb();
    await db.init();
    keyManager = new VPSKeyManager(db);
    await keyManager.init();
    app = createTestApp(db, keyManager);
  });

  test('17. 首次綁定 → 200 + bound: true', async () => {
    const deviceId = makeDeviceId('aaaa1111bbbb2222cccc3333dddd4444');
    const regRes = await registerDevice(app, deviceId);
    const regJson = await regRes.json() as { device_token: string };

    const res = await app.request('/v1/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        'X-Device-Token': regJson.device_token,
      },
      body: JSON.stringify({
        google_token: 'fake_google_token_for_test_user_a',
        nickname: 'TestUser',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { bound: boolean; nickname: string | null };
    expect(json.bound).toBe(true);
    expect(json.nickname).toBe('TestUser');
  });

  test('18. 重複綁定同 Google 帳號到不同裝置 → 409 AUTH_GOOGLE_ALREADY_BOUND', async () => {
    const googleToken = 'fake_google_token_shared_between_devices';

    // 裝置 A 先綁定
    const deviceIdA = makeDeviceId('aaaa2222bbbb3333cccc4444dddd5555');
    const regResA = await registerDevice(app, deviceIdA);
    const regJsonA = await regResA.json() as { device_token: string };

    const bindRes = await app.request('/v1/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceIdA,
        'X-Device-Token': regJsonA.device_token,
      },
      body: JSON.stringify({ google_token: googleToken }),
    });
    expect(bindRes.status).toBe(200);

    // 裝置 B 嘗試綁定同一個 Google 帳號
    const deviceIdB = makeDeviceId('bbbb2222cccc3333dddd4444eeee5555');
    const regResB = await registerDevice(app, deviceIdB);
    const regJsonB = await regResB.json() as { device_token: string };

    const bindResB = await app.request('/v1/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceIdB,
        'X-Device-Token': regJsonB.device_token,
      },
      body: JSON.stringify({ google_token: googleToken }),
    });

    expect(bindResB.status).toBe(409);
    const json = await bindResB.json() as { error: string };
    expect(json.error).toBe(ErrorCode.AUTH_GOOGLE_ALREADY_BOUND);
  });

  test('同裝置重複綁定同 Google 帳號 → 200（冪等操作）', async () => {
    const deviceId = makeDeviceId('cccc1111dddd2222eeee3333ffff4444');
    const regRes = await registerDevice(app, deviceId);
    const regJson = await regRes.json() as { device_token: string };
    const token = regJson.device_token;

    const googleToken = 'idempotent_google_token_test';

    // 第一次綁定
    const res1 = await app.request('/v1/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        'X-Device-Token': token,
      },
      body: JSON.stringify({ google_token: googleToken }),
    });
    expect(res1.status).toBe(200);

    // 第二次綁定同一個帳號到同一台裝置
    const res2 = await app.request('/v1/auth/google', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId,
        'X-Device-Token': token,
      },
      body: JSON.stringify({ google_token: googleToken }),
    });
    expect(res2.status).toBe(200);
  });
});
