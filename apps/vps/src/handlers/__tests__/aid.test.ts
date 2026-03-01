// Aid Handler 整合測試
// 使用 Hono app.request() 測試 HTTP 路由層
// Mock AidEngine（不測試配對邏輯，只測試 HTTP 協定層）

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { ErrorCode } from '@clawapi/protocol';
import { createAidRouter } from '../aid';
import type { AidEngine, AidRequestBody, AidConfigBody, AidRelayBody } from '../../services/aid-engine';
import type { AuthVariables } from '../../middleware/auth';

// ===== Mock AidEngine 建構器 =====
// 控制每個方法的回傳值，以便測試各種場景

type MockHandleRequestResult =
  | { ok: true; aid_id: string }
  | { ok: false; errorCode: ErrorCode; message: string; retry_after?: number };

function createMockAidEngine(overrides: Partial<{
  handleRequestResult: MockHandleRequestResult;
  updateConfigResult: { ok: true; config: AidConfigBody } | { ok: false; errorCode: ErrorCode; message: string };
  getConfigResult: AidConfigBody | null;
  relayAidDataResult: { ok: true } | { ok: false; errorCode: ErrorCode; message: string };
}> = {}) {
  return {
    handleRequest: mock(async (_deviceId: string, _body: AidRequestBody) => {
      return overrides.handleRequestResult ?? { ok: true as const, aid_id: 'aid_test_123_abc' };
    }),

    updateConfig: mock(async (_deviceId: string, config: AidConfigBody) => {
      return overrides.updateConfigResult ?? { ok: true as const, config };
    }),

    getConfig: mock((_deviceId: string): AidConfigBody | null => {
      return overrides.getConfigResult !== undefined
        ? overrides.getConfigResult
        : {
            enabled: true,
            allowed_services: ['openai'],
            daily_limit: 50,
            helper_public_key: 'helper_pub_key',
          };
    }),

    relayAidData: mock(async (_aidId: string, _fromDeviceId: string, _body: AidRelayBody) => {
      return overrides.relayAidDataResult ?? { ok: true as const };
    }),

    _resetCooldown: mock((_deviceId: string) => {}),
    _getActiveMatchCount: mock(() => 0),
    _getActiveMatch: mock(() => undefined),
    _clearAllTimers: mock(() => {}),
    markMatchResult: mock(() => {}),
  } as unknown as AidEngine;
}

// ===== 建立測試 Hono App =====

function createTestApp(engine: AidEngine, mockDeviceId: string = 'clw_test_device_001') {
  const app = new Hono<{ Variables: AuthVariables }>();

  // 模擬 deviceAuth middleware（直接設定 context 變數）
  app.use('*', async (c, next) => {
    // 模擬已認證的裝置
    c.set('deviceId', mockDeviceId);
    c.set('device', {
      device_id: mockDeviceId,
      device_fingerprint: 'fp_test',
      device_token: 'token_test',
      token_expires_at: new Date(Date.now() + 86400000).toISOString(),
      client_version: '0.1.0',
      os: 'macos',
      arch: 'arm64',
      locale: 'zh-TW',
      timezone: 'Asia/Taipei',
      region: 'asia',
      assigned_region: 'asia',
      vps_public_key_id: null,
      reputation_weight: 1.0,
      reputation_tier: 'new',
      anomaly_count: 0,
      status: 'active',
      suspended_reason: null,
      google_id_hash: null,
      google_email_masked: null,
      nickname: null,
      last_seen_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return next();
  });

  const aidRouter = createAidRouter(engine);
  app.route('/v1/aid', aidRouter);

  return app;
}

// ===== 測試群組 =====

describe('Aid Handler — POST /v1/aid/request', () => {
  it('1. 正常請求 → 202 + { aid_id, status: "matching" }', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: 'openai',
        request_type: 'chat_completion',
        requester_public_key: 'pub_key_base64',
      }),
    });

    expect(res.status).toBe(202);
    const json = await res.json() as {
      aid_id: string;
      status: string;
      estimated_wait_ms: number;
    };
    expect(json.aid_id).toBe('aid_test_123_abc');
    expect(json.status).toBe('matching');
    expect(json.estimated_wait_ms).toBe(30_000);
  });

  it('2. 缺少 service_id → 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 缺少 service_id
        request_type: 'chat_completion',
        requester_public_key: 'pub_key',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('3. 缺少 requester_public_key → 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: 'openai',
        request_type: 'chat',
        // 缺少 requester_public_key
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('4. 冷卻中 → 429 AID_COOLDOWN + retry_after', async () => {
    const engine = createMockAidEngine({
      handleRequestResult: {
        ok: false,
        errorCode: ErrorCode.AID_COOLDOWN,
        message: '請求太頻繁，請等待 55 秒後再試',
        retry_after: 55,
      },
    });
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: 'openai',
        request_type: 'chat',
        requester_public_key: 'pub_key',
      }),
    });

    expect(res.status).toBe(429);
    const json = await res.json() as { error: string; retry_after: number };
    expect(json.error).toBe(ErrorCode.AID_COOLDOWN);
    expect(json.retry_after).toBe(55);
  });

  it('5. 每日上限 → 429 AID_DAILY_LIMIT_REACHED', async () => {
    const engine = createMockAidEngine({
      handleRequestResult: {
        ok: false,
        errorCode: ErrorCode.AID_DAILY_LIMIT_REACHED,
        message: '今日互助請求已達上限',
        retry_after: 3600,
      },
    });
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: 'openai',
        request_type: 'chat',
        requester_public_key: 'pub_key',
      }),
    });

    expect(res.status).toBe(429);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.AID_DAILY_LIMIT_REACHED);
  });

  it('6. body 格式錯誤（非 JSON）→ 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json',
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });
});

describe('Aid Handler — PUT /v1/aid/config', () => {
  it('7. 正常更新設定 → 200 + { updated: true }', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        allowed_services: ['openai', 'anthropic'],
        daily_limit: 100,
        blackout_hours: [0, 1, 2],
        helper_public_key: 'my_helper_pub_key',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { updated: boolean };
    expect(json.updated).toBe(true);
  });

  it('8. daily_limit = 0（無效值）→ 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_limit: 0 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('9. daily_limit = 201（超出範圍）→ 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_limit: 201 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('10. body 格式錯誤 → 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });
});

describe('Aid Handler — GET /v1/aid/config', () => {
  it('11. 有設定 → 200 + 設定內容', async () => {
    const mockConfig: AidConfigBody = {
      enabled: true,
      allowed_services: ['openai'],
      daily_limit: 75,
      helper_public_key: 'helper_pub_key_abc',
    };
    const engine = createMockAidEngine({ getConfigResult: mockConfig });
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/config', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as AidConfigBody;
    expect(json.enabled).toBe(true);
    expect(json.daily_limit).toBe(75);
    expect(json.helper_public_key).toBe('helper_pub_key_abc');
  });

  it('12. 未設定過 → 200 + 預設值（enabled: false）', async () => {
    const engine = createMockAidEngine({ getConfigResult: null });
    const app = createTestApp(engine);

    const res = await app.request('/v1/aid/config', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { enabled: boolean; daily_limit: number };
    expect(json.enabled).toBe(false);
    expect(json.daily_limit).toBe(50);
  });
});

describe('Aid Handler — POST /v1/aid/relay', () => {
  it('13. 正常轉發 → 200 + { relayed: true }', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine, 'clw_relay_requester');

    const res = await app.request('/v1/aid/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aid_id: 'aid_relay_123',
        from_device_id: 'clw_relay_requester',
        encrypted_payload: 'base64_payload',
        iv: 'base64_iv',
        tag: 'base64_tag',
        kind: 'encrypted_request',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { relayed: boolean; aid_id: string };
    expect(json.relayed).toBe(true);
    expect(json.aid_id).toBe('aid_relay_123');
  });

  it('14. from_device_id 與認證裝置不一致 → 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine, 'clw_real_device');

    const res = await app.request('/v1/aid/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aid_id: 'aid_relay_456',
        from_device_id: 'clw_fake_device', // 不一致
        encrypted_payload: 'payload',
        iv: 'iv',
        tag: 'tag',
        kind: 'encrypted_request',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('15. kind 無效值 → 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine, 'clw_device_kind');

    const res = await app.request('/v1/aid/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aid_id: 'aid_789',
        from_device_id: 'clw_device_kind',
        encrypted_payload: 'payload',
        iv: 'iv',
        tag: 'tag',
        kind: 'invalid_kind', // 無效
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('16. payload 超過大小 → 413 AID_PAYLOAD_TOO_LARGE', async () => {
    const engine = createMockAidEngine({
      relayAidDataResult: {
        ok: false,
        errorCode: ErrorCode.AID_PAYLOAD_TOO_LARGE,
        message: 'payload 超過大小限制',
      },
    });
    const app = createTestApp(engine, 'clw_large_payload');

    const res = await app.request('/v1/aid/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aid_id: 'aid_large',
        from_device_id: 'clw_large_payload',
        encrypted_payload: 'huge_payload',
        iv: 'iv',
        tag: 'tag',
        kind: 'encrypted_request',
      }),
    });

    expect(res.status).toBe(413);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.AID_PAYLOAD_TOO_LARGE);
  });

  it('17. 目標裝置不在線 → 503 SERVICE_UNAVAILABLE', async () => {
    const engine = createMockAidEngine({
      relayAidDataResult: {
        ok: false,
        errorCode: ErrorCode.SERVICE_UNAVAILABLE,
        message: '目標裝置目前不在線',
      },
    });
    const app = createTestApp(engine, 'clw_sender_device');

    const res = await app.request('/v1/aid/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aid_id: 'aid_offline',
        from_device_id: 'clw_sender_device',
        encrypted_payload: 'payload',
        iv: 'iv',
        tag: 'tag',
        kind: 'encrypted_request',
      }),
    });

    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.SERVICE_UNAVAILABLE);
  });

  it('18. 缺少必填欄位 → 400 INVALID_REQUEST', async () => {
    const engine = createMockAidEngine();
    const app = createTestApp(engine, 'clw_missing_fields');

    const res = await app.request('/v1/aid/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aid_id: 'aid_001',
        from_device_id: 'clw_missing_fields',
        // 缺少 encrypted_payload, iv, tag, kind
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });
});
