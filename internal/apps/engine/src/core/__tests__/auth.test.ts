// auth.test.ts — Auth 模組測試
// 涵蓋 Token 管理、請求驗證、Sub-Key 驗證、用量記錄、Middleware

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { Hono } from 'hono';
import { EngineAuth, engineAuth } from '../auth';
import { createDatabase } from '../../storage/database';
import type { ClawDatabase } from '../../storage/database';

// ===== 輔助函式 =====

/** 建立臨時目錄 + in-memory DB，初始化 EngineAuth */
async function createAuth(): Promise<{
  auth: EngineAuth;
  db: ClawDatabase;
  tmpDir: string;
}> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-auth-test-'));
  // 使用 :memory: in-memory SQLite（跑 migration 001 建表）
  const db = createDatabase(':memory:');
  await db.init();
  const auth = new EngineAuth(db, tmpDir);
  await auth.initToken();
  return { auth, db, tmpDir };
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理錯誤
  }
}

/** 在 DB 中插入一筆 Sub-Key */
function insertSubKey(
  db: ClawDatabase,
  overrides: Partial<{
    token: string;
    is_active: number;
    expires_at: string | null;
    daily_limit: number | null;
    daily_used: number;
    allowed_services: string | null;
    allowed_models: string | null;
    rate_limit_per_hour: number | null;
    rate_used_this_hour: number;
    rate_hour_start: string | null;
  }> = {}
): number {
  const defaults = {
    token: 'sk_live_test_' + Math.random().toString(36).slice(2),
    is_active: 1,
    expires_at: null,
    daily_limit: null,
    daily_used: 0,
    allowed_services: null,
    allowed_models: null,
    rate_limit_per_hour: null,
    rate_used_this_hour: 0,
    rate_hour_start: null,
  };
  const row = { ...defaults, ...overrides };

  const result = db.run(
    `INSERT INTO sub_keys
       (token, is_active, expires_at, daily_limit, daily_used,
        allowed_services, allowed_models, rate_limit_per_hour,
        rate_used_this_hour, rate_hour_start)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.token,
      row.is_active,
      row.expires_at,
      row.daily_limit,
      row.daily_used,
      row.allowed_services,
      row.allowed_models,
      row.rate_limit_per_hour,
      row.rate_used_this_hour,
      row.rate_hour_start,
    ]
  );
  return result.lastInsertRowid;
}

// ===== Token 管理 =====

describe('EngineAuth — Token 管理', () => {
  it('01. initToken 首次 → 產生新 token，格式 clw_t + 64 hex', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-auth-test-'));
    const db = createDatabase(':memory:');
    await db.init();
    try {
      const auth = new EngineAuth(db, tmpDir);
      await auth.initToken();
      const token = auth.getToken();

      // 格式驗證：clw_t 前綴 + 64 hex 字元 = 69 字元
      expect(token).toMatch(/^clw_t[0-9a-f]{64}$/);
      expect(token.length).toBe(69);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('02. initToken 二次 → 讀取已存在的 token，應與第一次相同', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-auth-test-'));
    const db = createDatabase(':memory:');
    await db.init();
    try {
      // 第一次初始化
      const auth1 = new EngineAuth(db, tmpDir);
      await auth1.initToken();
      const token1 = auth1.getToken();

      // 第二次初始化，應讀取同一個檔案
      const auth2 = new EngineAuth(db, tmpDir);
      await auth2.initToken();
      const token2 = auth2.getToken();

      expect(token1).toBe(token2);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('03. token 檔案權限應為 0600（POSIX 系統）', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-auth-test-'));
    const db = createDatabase(':memory:');
    await db.init();
    try {
      const auth = new EngineAuth(db, tmpDir);
      await auth.initToken();

      const tokenPath = join(tmpDir, 'auth.token');
      expect(existsSync(tokenPath)).toBe(true);

      // 在 POSIX 系統上確認權限
      if (process.platform !== 'win32') {
        const stat = statSync(tokenPath);
        // stat.mode & 0o777 取低 9 bits（rwxrwxrwx）
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('04. getToken 未初始化 → 拋出錯誤', async () => {
    const db = createDatabase(':memory:');
    await db.init();
    // 不呼叫 initToken，直接呼叫 getToken
    const auth = new EngineAuth(db);
    expect(() => auth.getToken()).toThrow();
  });

  it('05. resetToken → 產生新 token，跟舊的不同', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'clawapi-auth-test-'));
    const db = createDatabase(':memory:');
    await db.init();
    try {
      const auth = new EngineAuth(db, tmpDir);
      await auth.initToken();
      const oldToken = auth.getToken();

      const newToken = await auth.resetToken();

      // 新舊 token 不同
      expect(newToken).not.toBe(oldToken);
      // 新 token 格式正確
      expect(newToken).toMatch(/^clw_t[0-9a-f]{64}$/);
      // getToken 回傳新 token
      expect(auth.getToken()).toBe(newToken);
    } finally {
      cleanupDir(tmpDir);
    }
  });
});

// ===== 請求驗證 =====

describe('EngineAuth — 請求驗證', () => {
  let auth: EngineAuth;
  let db: ClawDatabase;
  let tmpDir: string;

  beforeEach(async () => {
    ({ auth, db, tmpDir } = await createAuth());
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('06. 無 Authorization header → AUTH_MISSING', () => {
    const result = auth.validateRequest(undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('AUTH_MISSING');
  });

  it('07. 不是 Bearer → AUTH_INVALID_FORMAT', () => {
    const result = auth.validateRequest('Basic abc123');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('AUTH_INVALID_FORMAT');
  });

  it('08. Bearer + 正確 token → valid, type=master', () => {
    const token = auth.getToken();
    const result = auth.validateRequest(`Bearer ${token}`);
    expect(result.valid).toBe(true);
    expect(result.type).toBe('master');
  });

  it('09. Bearer + 錯誤 token → AUTH_INVALID_TOKEN', () => {
    const result = auth.validateRequest('Bearer clw_t' + 'a'.repeat(64));
    expect(result.valid).toBe(false);
    expect(result.error).toBe('AUTH_INVALID_TOKEN');
  });

  it('10. Bearer sk_live_xxx → valid, type=subkey, token=sk_live_xxx', () => {
    const result = auth.validateRequest('Bearer sk_live_mysubkey123');
    expect(result.valid).toBe(true);
    expect(result.type).toBe('subkey');
    expect(result.token).toBe('sk_live_mysubkey123');
  });
});

// ===== Sub-Key 驗證 =====

describe('EngineAuth — Sub-Key 驗證', () => {
  let auth: EngineAuth;
  let db: ClawDatabase;
  let tmpDir: string;

  beforeEach(async () => {
    ({ auth, db, tmpDir } = await createAuth());
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('11. 有效 Sub-Key → valid: true', async () => {
    const token = 'sk_live_valid_key_001';
    insertSubKey(db, { token });

    const result = await auth.validateSubKey(token);
    expect(result.valid).toBe(true);
    expect(result.subKeyId).toBeGreaterThan(0);
  });

  it('12. 不存在的 token → SUBKEY_INVALID', async () => {
    const result = await auth.validateSubKey('sk_live_nonexistent');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('13. is_active=0 → SUBKEY_INVALID', async () => {
    const token = 'sk_live_disabled_key';
    insertSubKey(db, { token, is_active: 0 });

    const result = await auth.validateSubKey(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('14. 已過期 → SUBKEY_INVALID', async () => {
    const token = 'sk_live_expired_key';
    // 設定過去的時間
    const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    insertSubKey(db, { token, expires_at: pastDate });

    const result = await auth.validateSubKey(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('15. daily_used >= daily_limit → daily_limit_exceeded', async () => {
    const token = 'sk_live_daily_limited';
    insertSubKey(db, { token, daily_limit: 10, daily_used: 10 });

    const result = await auth.validateSubKey(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('daily_limit_exceeded');
  });

  it('16. rate_used_this_hour >= rate_limit_per_hour → rate_limit_exceeded', async () => {
    const token = 'sk_live_rate_limited';
    // rate_hour_start 設定為目前整點（確保在同一小時內）
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const rateHourStart = now.toISOString();

    insertSubKey(db, {
      token,
      rate_limit_per_hour: 5,
      rate_used_this_hour: 5,
      rate_hour_start: rateHourStart,
    });

    const result = await auth.validateSubKey(token);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('rate_limit_exceeded');
  });

  it('17. service 不在 allowed_services → service_not_allowed', async () => {
    const token = 'sk_live_service_restricted';
    insertSubKey(db, {
      token,
      allowed_services: JSON.stringify(['groq', 'openai']),
    });

    const result = await auth.validateSubKey(token, 'anthropic');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('service_not_allowed');
  });

  it('18. allowed_services=null → 允許全部服務', async () => {
    const token = 'sk_live_all_services';
    insertSubKey(db, { token, allowed_services: null });

    const result = await auth.validateSubKey(token, 'any-service-id');
    expect(result.valid).toBe(true);
  });

  it('allowed_models 不在列表 → model_not_allowed', async () => {
    const token = 'sk_live_model_restricted';
    insertSubKey(db, {
      token,
      allowed_models: JSON.stringify(['gpt-4', 'claude-3']),
    });

    const result = await auth.validateSubKey(token, undefined, 'llama-3');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('model_not_allowed');
  });

  it('allowed_models=null → 允許全部模型', async () => {
    const token = 'sk_live_all_models';
    insertSubKey(db, { token, allowed_models: null });

    const result = await auth.validateSubKey(token, undefined, 'any-model');
    expect(result.valid).toBe(true);
  });

  it('permissions 回傳正確欄位', async () => {
    const token = 'sk_live_with_limits';
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    insertSubKey(db, {
      token,
      daily_limit: 100,
      daily_used: 20,
      rate_limit_per_hour: 10,
      allowed_services: JSON.stringify(['groq']),
      allowed_models: JSON.stringify(['llama-3']),
      expires_at: futureDate,
    });

    const result = await auth.validateSubKey(token, 'groq', 'llama-3');
    expect(result.valid).toBe(true);
    expect(result.permissions).toBeDefined();
    expect(result.permissions!.daily_limit).toBe(100);
    expect(result.permissions!.daily_remaining).toBe(80);
    expect(result.permissions!.allowed_services).toEqual(['groq']);
    expect(result.permissions!.allowed_models).toEqual(['llama-3']);
  });
});

// ===== Sub-Key 用量記錄 =====

describe('EngineAuth — Sub-Key 用量記錄', () => {
  let auth: EngineAuth;
  let db: ClawDatabase;
  let tmpDir: string;

  beforeEach(async () => {
    ({ auth, db, tmpDir } = await createAuth());
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('19. recordSubKeyUsage → daily_used +1, rate_used_this_hour +1', async () => {
    const token = 'sk_live_usage_test';
    // 設定 rate_hour_start 為目前整點（確保在同一小時內）
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const rateHourStart = now.toISOString();

    const id = insertSubKey(db, {
      token,
      daily_used: 5,
      rate_used_this_hour: 3,
      rate_hour_start: rateHourStart,
    });

    await auth.recordSubKeyUsage(id);

    // 查詢更新後的數值
    interface UsageRow { daily_used: number; rate_used_this_hour: number }
    const rows = db.query<UsageRow>(
      'SELECT daily_used, rate_used_this_hour FROM sub_keys WHERE id = ?',
      [id]
    );

    expect(rows[0].daily_used).toBe(6);
    expect(rows[0].rate_used_this_hour).toBe(4);
  });

  it('20. 跨小時 → rate_used_this_hour 重置為 1', async () => {
    const token = 'sk_live_cross_hour';
    // 設定 rate_hour_start 為上個小時
    const lastHour = new Date(Date.now() - 1000 * 60 * 61); // 61 分鐘前
    lastHour.setMinutes(0, 0, 0);
    const lastHourStart = lastHour.toISOString();

    const id = insertSubKey(db, {
      token,
      daily_used: 10,
      rate_used_this_hour: 8,
      rate_hour_start: lastHourStart,
    });

    await auth.recordSubKeyUsage(id);

    interface UsageRow { daily_used: number; rate_used_this_hour: number }
    const rows = db.query<UsageRow>(
      'SELECT daily_used, rate_used_this_hour FROM sub_keys WHERE id = ?',
      [id]
    );

    // daily_used 應該 +1
    expect(rows[0].daily_used).toBe(11);
    // rate_used_this_hour 應重置為 1（新的一小時第一次）
    expect(rows[0].rate_used_this_hour).toBe(1);
  });
});

// ===== Middleware =====

describe('engineAuth Middleware', () => {
  let auth: EngineAuth;
  let db: ClawDatabase;
  let tmpDir: string;
  let app: Hono;

  beforeEach(async () => {
    ({ auth, db, tmpDir } = await createAuth());

    app = new Hono();
    app.use('*', engineAuth(auth));

    // 測試路由
    app.get('/health', (c) => c.json({ status: 'ok' }));
    app.get('/v1/health', (c) => c.json({ status: 'ok' }));
    app.get('/api/test', (c) => {
      const authType = c.get('authType' as never);
      const subkey = c.get('subkey' as never);
      return c.json({ authType, subkey: subkey ?? null });
    });
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('21. 有效 master token → 通過，authType === master', async () => {
    const token = auth.getToken();
    const res = await app.request('/api/test', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { authType: string };
    expect(body.authType).toBe('master');
  });

  it('22. /health → 跳過認證（無需 token）', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('22b. /v1/health → 跳過認證', async () => {
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
  });

  it('23. 無效 token → 401 回應', async () => {
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer invalid_token_xyz' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBeDefined();
  });

  it('無 Authorization header → 401', async () => {
    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
  });

  it('Bearer sk_live_xxx（Sub-Key 存在且有效）→ 通過', async () => {
    const token = 'sk_live_middleware_test';
    insertSubKey(db, { token });

    const res = await app.request('/api/test', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { subkey: { valid: boolean } };
    expect(body.subkey).toBeDefined();
    expect(body.subkey.valid).toBe(true);
  });

  it('Bearer sk_live_xxx（Sub-Key 不存在）→ 401', async () => {
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer sk_live_nonexistent_key' },
    });
    expect(res.status).toBe(401);
  });
});
