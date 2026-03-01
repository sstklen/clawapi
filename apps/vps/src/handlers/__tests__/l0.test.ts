// L0 HTTP Handler 整合測試
// 使用 in-memory mock DB + mock L0Manager，透過 Hono app.request() 測試端點行為
// 涵蓋：GET /v1/l0/keys、POST /v1/l0/donate、POST /v1/l0/usage

import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { ErrorCode } from '@clawapi/protocol';
import { createL0Router } from '../l0';
import type { L0Manager, L0KeyRecord, DonateBody, UsageEntry } from '../../services/l0-manager';
import type { VPSDatabase, Device } from '../../storage/database';
import type { AuthVariables } from '../../middleware/auth';

// ===== Mock 建構器 =====

// 建立 mock device（通過 deviceAuth 的裝置）
function makeMockDevice(deviceId: string): Device {
  return {
    device_id: deviceId,
    device_fingerprint: 'fp_test',
    device_token: 'token_test_' + deviceId,
    token_expires_at: new Date(Date.now() + 86400000 * 120).toISOString(),
    client_version: '0.1.0',
    os: 'macos',
    arch: 'arm64',
    locale: 'zh-TW',
    timezone: 'Asia/Taipei',
    region: 'asia',
    assigned_region: 'asia',
    vps_public_key_id: 'vps_key_v1',
    reputation_weight: 1.0,
    reputation_tier: 'normal',
    anomaly_count: 0,
    status: 'active',
    suspended_reason: null,
    google_id_hash: null,
    google_email_masked: null,
    nickname: null,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// 建立 mock DB（只需要支援 l0 handler 使用的查詢）
function createMockDb(deviceId: string) {
  const today = new Date().toISOString().slice(0, 10);

  return {
    query<T>(sql: string, _params?: unknown[]): T[] {
      const s = sql.trim().toLowerCase();

      // 查 l0_device_usage
      if (s.includes('from l0_device_usage')) {
        return [] as T[]; // 無用量記錄（新裝置）
      }

      return [] as T[];
    },
    run(_sql: string, _params?: unknown[]) {
      return { changes: 1, lastInsertRowid: 0 };
    },
  } as unknown as VPSDatabase;
}

// 建立 mock L0Manager
function createMockL0Manager(options?: {
  getKeysReturn?: L0KeyRecord[] | null;
  handleDonateError?: Error & { errorCode?: string };
  handleDonateReturn?: { accepted: boolean; l0_key_id: string; message: string; validation: { key_valid: boolean; service_confirmed: string; estimated_daily_quota: number } };
  reportUsageReturn?: { updated: number };
}) {
  const now = new Date().toISOString();

  const defaultKey: L0KeyRecord = {
    id: 'l0_mock_key_001',
    service_id: 'openai',
    status: 'active',
    key_value_encrypted: null,
    key_hash: 'hash_mock',
    encryption_key_id: 'l0_master_v1',
    daily_quota: 1000,
    daily_used: 50,
    daily_reset_at: null,
    donated_by_device_id: null,
    donated_by_display: 'MockDonor',
    is_anonymous_donation: 0,
    last_health_check: null,
    created_at: now,
    updated_at: now,
  };

  return {
    getKeys(_since?: string): L0KeyRecord[] | null {
      if (options?.getKeysReturn !== undefined) return options.getKeysReturn;
      return [defaultKey];
    },
    getDeviceLimits(_deviceId: string): Record<string, number> {
      return { openai: 50, anthropic: 30 };
    },
    async handleDonate(_deviceId: string, _body: DonateBody) {
      if (options?.handleDonateError) throw options.handleDonateError;
      return options?.handleDonateReturn ?? {
        accepted: true,
        l0_key_id: 'l0_new_001',
        message: '感謝捐贈！您的 Key 已加入公共池',
        validation: {
          key_valid: true,
          service_confirmed: 'openai',
          estimated_daily_quota: 1000,
        },
      };
    },
    async reportUsage(_deviceId: string, _entries: UsageEntry[]) {
      return options?.reportUsageReturn ?? { updated: 1 };
    },
    prepareForDownload(record: L0KeyRecord) {
      return {
        id: record.id,
        service_id: record.service_id,
        key_encrypted: null,
        encryption_method: null as null,
        encryption_key_id: record.encryption_key_id,
        status: record.status,
        daily_quota_per_device: null,
        total_daily_quota: record.daily_quota,
        total_daily_used: record.daily_used,
        donated_by: record.is_anonymous_donation ? null : (record.donated_by_display ?? null),
        updated_at: record.updated_at,
      };
    },
  } as unknown as L0Manager;
}

// 建立測試 Hono app（繞過 deviceAuth，直接注入 deviceId）
function createTestApp(
  db: VPSDatabase,
  l0Manager: L0Manager,
  deviceId: string,
) {
  const app = new Hono<{ Variables: AuthVariables }>();

  // 注入裝置認證（不用真實 middleware，直接 set context）
  app.use('*', async (c, next) => {
    c.set('deviceId', deviceId);
    c.set('device', makeMockDevice(deviceId));
    return next();
  });

  const l0Router = createL0Router(db, l0Manager);
  app.route('/v1/l0', l0Router);

  return app;
}

// ===== GET /v1/l0/keys 測試 =====

describe('GET /v1/l0/keys', () => {
  const deviceId = 'clw_l0test0000000000000000000001';
  let db: VPSDatabase;

  beforeEach(() => {
    db = createMockDb(deviceId);
  });

  it('1. 正常取得 Key 列表 → 200 + L0KeysResponse 格式', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/keys', {
      method: 'GET',
      headers: {
        'X-Device-Id': deviceId,
        'X-Device-Token': 'token_test_' + deviceId,
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as {
      schema_version: number;
      keys: unknown[];
      l0_encryption_key: string;
      device_daily_limits: Record<string, unknown>;
      cache_ttl: number;
      server_time: string;
    };

    expect(json.schema_version).toBe(1);
    expect(Array.isArray(json.keys)).toBe(true);
    expect(json.keys.length).toBeGreaterThan(0);
    expect(json.l0_encryption_key).toBeTruthy();
    expect(json.cache_ttl).toBe(300);
    expect(json.server_time).toBeTruthy();
    expect(typeof json.device_daily_limits).toBe('object');
  });

  it('2. 帶 since 且有新 key → 200 + 差異 key', async () => {
    const now = new Date().toISOString();
    const newKey: L0KeyRecord = {
      id: 'l0_new_since', service_id: 'anthropic', status: 'active',
      key_value_encrypted: null, key_hash: 'hashS', encryption_key_id: null,
      daily_quota: 500, daily_used: 10, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    };

    const l0Manager = createMockL0Manager({ getKeysReturn: [newKey] });
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/keys?since=2025-01-01T00:00:00Z', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { keys: Array<{ id: string }> };
    expect(json.keys.length).toBe(1);
    expect(json.keys[0].id).toBe('l0_new_since');
  });

  it('3. 帶 since 且無新 key → 304', async () => {
    const l0Manager = createMockL0Manager({ getKeysReturn: null });
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/keys?since=2099-01-01T00:00:00Z', {
      method: 'GET',
    });

    // Hono 對 304 的 body 可能是空的
    expect(res.status).toBe(304);
  });

  it('4. 無任何 key → 200 + 空陣列', async () => {
    const l0Manager = createMockL0Manager({ getKeysReturn: [] });
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/keys', { method: 'GET' });

    expect(res.status).toBe(200);
    const json = await res.json() as { keys: unknown[] };
    expect(json.keys).toEqual([]);
  });

  it('5. 回應包含 device_daily_limits（openai + anthropic）', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/keys', { method: 'GET' });
    const json = await res.json() as {
      device_daily_limits: Record<string, { limit: number; used: number; reset_at: string }>;
    };

    // openai 在 key 列表中，應有 daily limits
    expect(json.device_daily_limits['openai']).toBeDefined();
    expect(typeof json.device_daily_limits['openai'].limit).toBe('number');
    expect(typeof json.device_daily_limits['openai'].used).toBe('number');
    expect(json.device_daily_limits['openai'].reset_at).toBeTruthy();
  });
});

// ===== POST /v1/l0/donate 測試 =====

describe('POST /v1/l0/donate', () => {
  const deviceId = 'clw_l0test0000000000000000000002';
  let db: VPSDatabase;

  beforeEach(() => {
    db = createMockDb(deviceId);
  });

  const validBody: DonateBody = {
    service_id: 'openai',
    encrypted_key: Buffer.from('fake_encrypted_key').toString('base64'),
    ephemeral_public_key: Buffer.from('fake_ephemeral_public_key').toString('base64'),
    iv: Buffer.from('fake_iv_12345678').toString('base64'),
    tag: Buffer.from('fake_tag_12345678').toString('base64'),
    display_name: 'TestDonor',
    anonymous: false,
  };

  it('1. 捐贈成功 → 200 + accepted: true', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/donate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as {
      accepted: boolean;
      l0_key_id: string;
      message: string;
      validation: { key_valid: boolean; service_confirmed: string };
    };
    expect(json.accepted).toBe(true);
    expect(json.l0_key_id).toBeTruthy();
    expect(json.validation.key_valid).toBe(true);
    expect(json.validation.service_confirmed).toBe('openai');
  });

  it('2. 重複 Key → 409 L0_DONATE_DUPLICATE', async () => {
    const dupErr = Object.assign(new Error('此 Key 已存在'), { errorCode: 'L0_DONATE_DUPLICATE' });
    const l0Manager = createMockL0Manager({ handleDonateError: dupErr });
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/donate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(409);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.L0_DONATE_DUPLICATE);
  });

  it('3. 無效 Key → 400 L0_DONATE_INVALID_KEY', async () => {
    const invalidErr = Object.assign(new Error('Key 無效'), { errorCode: 'L0_DONATE_INVALID_KEY' });
    const l0Manager = createMockL0Manager({ handleDonateError: invalidErr });
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/donate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.L0_DONATE_INVALID_KEY);
  });

  it('4. 速率限制 → 429 L0_DONATE_RATE_LIMITED + retry_after', async () => {
    const rateErr = Object.assign(new Error('今日已達上限'), { errorCode: 'L0_DONATE_RATE_LIMITED' });
    const l0Manager = createMockL0Manager({ handleDonateError: rateErr });
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/donate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(429);
    const json = await res.json() as { error: string; retry_after: number };
    expect(json.error).toBe(ErrorCode.L0_DONATE_RATE_LIMITED);
    expect(json.retry_after).toBeDefined();
    expect(json.retry_after).toBeGreaterThan(0);
  });

  it('5. 缺少必填欄位 → 400 INVALID_REQUEST', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/donate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: 'openai',
        // 缺少 encrypted_key, ephemeral_public_key, iv, tag
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('6. body 格式錯誤 → 400 INVALID_REQUEST', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/donate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json',
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });
});

// ===== POST /v1/l0/usage 測試 =====

describe('POST /v1/l0/usage', () => {
  const deviceId = 'clw_l0test0000000000000000000003';
  let db: VPSDatabase;

  beforeEach(() => {
    db = createMockDb(deviceId);
  });

  const validEntries: UsageEntry[] = [
    {
      l0_key_id: 'l0_mock_001',
      service_id: 'openai',
      timestamp: new Date().toISOString(),
      tokens_used: 1000,
      success: true,
    },
    {
      l0_key_id: 'l0_mock_002',
      service_id: 'anthropic',
      timestamp: new Date().toISOString(),
      success: false,
    },
  ];

  it('1. 正常回報用量 → 200 + accepted: true + updated', async () => {
    const l0Manager = createMockL0Manager({ reportUsageReturn: { updated: 2 } });
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: validEntries }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { accepted: boolean; updated: number; message: string };
    expect(json.accepted).toBe(true);
    expect(json.updated).toBe(2);
    expect(json.message).toBeTruthy();
  });

  it('2. entries 為空陣列 → 400 INVALID_REQUEST', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('3. 缺少 entries 欄位 → 400 INVALID_REQUEST', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('4. entry 缺少必填欄位 → 400 INVALID_REQUEST', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: [
          {
            // 缺少 l0_key_id
            service_id: 'openai',
            timestamp: new Date().toISOString(),
            success: true,
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });

  it('5. body 格式錯誤 → 400 INVALID_REQUEST', async () => {
    const l0Manager = createMockL0Manager();
    const app = createTestApp(db, l0Manager, deviceId);

    const res = await app.request('/v1/l0/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json-body',
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe(ErrorCode.INVALID_REQUEST);
  });
});
