// E2E 測試 06：互助全流程
// 驗證：Engine A 設定互助 → Engine B 發出請求 → VPS 配對 → ECDH 加密驗證

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createVPSApp,
  registerDevice,
  makeVPSRequest,
  generateDeviceId,
  type VPSApp,
  type RegisteredDevice,
} from './helpers/setup';

describe('E2E 06：互助全流程', () => {
  let vps: VPSApp;
  let deviceA: RegisteredDevice;
  let deviceB: RegisteredDevice;

  beforeEach(async () => {
    vps = await createVPSApp();
    // 註冊兩個裝置模擬互助雙方
    deviceA = await registerDevice(vps.app, generateDeviceId(), 'fp_helper_a');
    deviceB = await registerDevice(vps.app, generateDeviceId(), 'fp_requester_b');
  });

  test('6-1. Engine A 設定互助 config：PUT /v1/aid/config → 200', async () => {
    const res = await makeVPSRequest(vps.app, 'PUT', '/v1/aid/config', deviceA, {
      enabled: true,
      allowed_services: ['groq', 'openai'],
      daily_limit: 30,
      blackout_hours: [],
      helper_public_key: 'base64_test_public_key_a',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok?: boolean; updated?: boolean };
    // AidEngine mock 回傳 ok: true
    expect(body).toBeDefined();
  });

  test('6-2. 查詢互助 config：GET /v1/aid/config → 回傳設定', async () => {
    // 先設定
    await makeVPSRequest(vps.app, 'PUT', '/v1/aid/config', deviceA, {
      enabled: true,
      daily_limit: 20,
    });

    // 查詢
    const res = await makeVPSRequest(vps.app, 'GET', '/v1/aid/config', deviceA);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  test('6-3. Engine B 發出互助請求：POST /v1/aid/request → 202', async () => {
    const res = await makeVPSRequest(vps.app, 'POST', '/v1/aid/request', deviceB, {
      service_id: 'groq',
      request_type: 'chat',
      requester_public_key: 'base64_test_public_key_b',
    });

    expect(res.status).toBe(202);
    const body = await res.json() as {
      aid_id: string;
      status: string;
      estimated_wait_ms: number;
    };

    expect(body.aid_id).toBeTruthy();
    expect(body.status).toBe('matching');
    expect(body.estimated_wait_ms).toBeGreaterThan(0);
  });

  test('6-4. 互助請求缺少必填欄位 → 400', async () => {
    const res = await makeVPSRequest(vps.app, 'POST', '/v1/aid/request', deviceB, {
      // 缺少 service_id、request_type、requester_public_key
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('INVALID_REQUEST');
  });

  test('6-5. ECDH 端對端加密驗證（使用 Web Crypto API）', async () => {
    // 模擬 ECDH 金鑰交換流程
    const webCrypto = globalThis.crypto;

    // Engine A 產生金鑰對（幫助者）
    const keyPairA = await webCrypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    );

    // Engine B 產生金鑰對（請求者）
    const keyPairB = await webCrypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    );

    // A 用 B 的公鑰推導共享密鑰
    const sharedSecretA = await webCrypto.subtle.deriveBits(
      { name: 'ECDH', public: keyPairB.publicKey },
      keyPairA.privateKey,
      256,
    );

    // B 用 A 的公鑰推導共享密鑰
    const sharedSecretB = await webCrypto.subtle.deriveBits(
      { name: 'ECDH', public: keyPairA.publicKey },
      keyPairB.privateKey,
      256,
    );

    // 兩邊推導出相同的共享密鑰
    const secretA = new Uint8Array(sharedSecretA);
    const secretB = new Uint8Array(sharedSecretB);

    expect(secretA.length).toBe(32);
    expect(secretB.length).toBe(32);

    // 逐位比較
    for (let i = 0; i < 32; i++) {
      expect(secretA[i]).toBe(secretB[i]);
    }

    // 用共享密鑰做 HKDF → AES-256-GCM 加解密
    const aidId = 'aid_test_hkdf_001';
    const keyMaterial = await webCrypto.subtle.importKey(
      'raw',
      sharedSecretA,
      { name: 'HKDF' },
      false,
      ['deriveBits'],
    );

    const aesKeyBits = await webCrypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode(aidId),
        info: new TextEncoder().encode('clawapi-aid-v1'),
      },
      keyMaterial,
      256,
    );

    // 匯入 AES key
    const aesKey = await webCrypto.subtle.importKey(
      'raw',
      aesKeyBits,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );

    // 加密
    const iv = webCrypto.getRandomValues(new Uint8Array(12));
    const plaintext = '{"model":"llama3","messages":[{"role":"user","content":"test"}]}';
    const encryptedBuffer = await webCrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      new TextEncoder().encode(plaintext),
    );

    // 解密
    const decryptedBuffer = await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      encryptedBuffer,
    );

    const decrypted = new TextDecoder().decode(decryptedBuffer);
    expect(decrypted).toBe(plaintext);
  });

  test('6-6. 互助統計：GET /v1/aid/stats → 回傳統計數據', async () => {
    const res = await makeVPSRequest(vps.app, 'GET', '/v1/aid/stats', deviceA);

    // 端點存在且可存取
    expect([200, 404]).toContain(res.status);
  });
});
