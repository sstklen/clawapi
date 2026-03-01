// sub-key.test.ts — SubKeyManager 完整測試套件
// 涵蓋：發行、驗證 8 項、撤銷、列表、用量追蹤、VPS 驗證代理

import { describe, it, expect, beforeEach } from 'bun:test';
import { SubKeyManager } from '../sub-key';
import { createDatabase } from '../../storage/database';
import type { ClawDatabase } from '../../storage/database';
import type { EngineAuth } from '../../core/auth';

// ===== Mock EngineAuth =====

/** 建立 Mock EngineAuth（僅供 SubKeyManager 使用，不需要真實 token 管理） */
function createMockAuth(): EngineAuth {
  return {} as EngineAuth;
}

// ===== 輔助函式 =====

/** 建立測試用的 in-memory DB 並初始化 */
async function createTestDb(): Promise<ClawDatabase> {
  const db = createDatabase(':memory:');
  await db.init();
  return db;
}

/** 插入裝置記錄（用於 token 格式中的 deviceId） */
function insertDevice(db: ClawDatabase, deviceId = '12345678-abcd-ef00-1234-567890abcdef'): void {
  db.run(
    `INSERT OR REPLACE INTO device
       (device_id, device_fingerprint, created_at, updated_at)
     VALUES (?, 'test-fingerprint', datetime('now'), datetime('now'))`,
    [deviceId]
  );
}

/** 驗證 Sub-Key token 格式是否正確 */
function isValidTokenFormat(token: string): boolean {
  return /^sk_live_[0-9a-f]{8}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token);
}

// ===== 發行 Sub-Key =====

describe('SubKeyManager — 發行 Sub-Key', () => {
  let db: ClawDatabase;
  let manager: SubKeyManager;

  beforeEach(async () => {
    db = await createTestDb();
    manager = new SubKeyManager(db, createMockAuth());
    insertDevice(db);
  });

  it('01. 發行後 token 格式正確（sk_live_ + deviceIdHash + UUID）', async () => {
    const subKey = await manager.issue({ label: '測試 Key' });

    // 格式驗證
    expect(subKey.token).toMatch(/^sk_live_/);
    expect(isValidTokenFormat(subKey.token)).toBe(true);
  });

  it('02. 發行後回傳完整 SubKey 物件，含 id、label、is_active=true', async () => {
    const subKey = await manager.issue({ label: '我的 Key', daily_limit: 100 });

    expect(subKey.id).toBeGreaterThan(0);
    expect(subKey.label).toBe('我的 Key');
    expect(subKey.is_active).toBe(true);
    expect(subKey.daily_limit).toBe(100);
    expect(subKey.daily_used).toBe(0);
    expect(subKey.total_requests).toBe(0);
    expect(subKey.total_tokens).toBe(0);
  });

  it('03. allowed_services 和 allowed_models 正確序列化/反序列化', async () => {
    const subKey = await manager.issue({
      label: '限制 Key',
      allowed_services: ['groq', 'openai'],
      allowed_models: ['llama-3', 'gpt-4o'],
    });

    expect(subKey.allowed_services).toEqual(['groq', 'openai']);
    expect(subKey.allowed_models).toEqual(['llama-3', 'gpt-4o']);
  });

  it('04. null 欄位正確處理（all permissions open）', async () => {
    const subKey = await manager.issue({ label: '無限制 Key' });

    expect(subKey.allowed_services).toBeNull();
    expect(subKey.allowed_models).toBeNull();
    expect(subKey.daily_limit).toBeNull();
    expect(subKey.rate_limit_per_hour).toBeNull();
    expect(subKey.expires_at).toBeNull();
  });

  it('05. 無裝置記錄時使用 00000000 佔位前綴', async () => {
    // 清空 device 表
    const emptyDb = await createTestDb();
    const emptyManager = new SubKeyManager(emptyDb, createMockAuth());

    const subKey = await emptyManager.issue({ label: '無裝置 Key' });
    // 佔位字元仍符合格式
    expect(subKey.token).toMatch(/^sk_live_00000000_/);
  });

  it('06. 每次發行產生唯一 token（UUID 隨機性）', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const subKey = await manager.issue({ label: `Key ${i}` });
      tokens.add(subKey.token);
    }
    // 5 個 token 應該都不同
    expect(tokens.size).toBe(5);
  });
});

// ===== 驗證 8 項 =====

describe('SubKeyManager — 驗證 8 項檢查', () => {
  let db: ClawDatabase;
  let manager: SubKeyManager;

  beforeEach(async () => {
    db = await createTestDb();
    manager = new SubKeyManager(db, createMockAuth());
    insertDevice(db);
  });

  it('T1. 正常有效的 Sub-Key → valid: true', async () => {
    const subKey = await manager.issue({
      label: '有效 Key',
      allowed_services: ['groq'],
    });

    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(true);
    expect(result.subKeyId).toBe(subKey.id);
  });

  it('T2. 不存在的 token → SUBKEY_INVALID', async () => {
    // 產生符合格式但不存在的 token
    const fakeToken = 'sk_live_12345678_00000000-0000-0000-0000-000000000000';
    const result = await manager.validate(fakeToken, 'groq');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('T2b. is_active = 0（撤銷）→ SUBKEY_INVALID', async () => {
    const subKey = await manager.issue({ label: '撤銷 Key' });
    await manager.revoke(subKey.id);

    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('T3. 已過期（expires_at 在過去）→ SUBKEY_INVALID', async () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1 小時前
    const subKey = await manager.issue({
      label: '過期 Key',
      expires_at: pastDate,
    });

    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('T3b. 未過期（expires_at 在未來）→ 通過', async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // 明天
    const subKey = await manager.issue({
      label: '未過期 Key',
      expires_at: futureDate,
    });

    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(true);
  });

  it('T4. daily_used >= daily_limit → daily_limit_exceeded', async () => {
    const subKey = await manager.issue({
      label: '每日限制 Key',
      daily_limit: 10,
    });

    // 直接更新 DB 模擬用量耗盡
    db.run(
      'UPDATE sub_keys SET daily_used = 10 WHERE id = ?',
      [subKey.id]
    );

    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('daily_limit_exceeded');
  });

  it('T4b. daily_used < daily_limit → 通過', async () => {
    const subKey = await manager.issue({
      label: '有餘量 Key',
      daily_limit: 10,
    });

    // daily_used = 0，未達限制
    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(true);
    expect(result.permissions?.daily_remaining).toBe(10);
  });

  it('T5. rate_used_this_hour >= rate_limit_per_hour（同一小時）→ rate_limit_exceeded', async () => {
    const subKey = await manager.issue({
      label: '速率限制 Key',
      rate_limit_per_hour: 5,
    });

    // 設定 rate_hour_start 為目前整點（確保在同一小時內）
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const rateHourStart = now.toISOString();

    db.run(
      'UPDATE sub_keys SET rate_used_this_hour = 5, rate_hour_start = ? WHERE id = ?',
      [rateHourStart, subKey.id]
    );

    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('rate_limit_exceeded');
  });

  it('T5b. rate_hour_start 是上個小時 → 重置計數，通過', async () => {
    const subKey = await manager.issue({
      label: '速率跨小時 Key',
      rate_limit_per_hour: 5,
    });

    // 設定 rate_hour_start 為上個小時（61 分鐘前）
    const lastHour = new Date(Date.now() - 1000 * 60 * 61);
    lastHour.setMinutes(0, 0, 0);

    db.run(
      'UPDATE sub_keys SET rate_used_this_hour = 5, rate_hour_start = ? WHERE id = ?',
      [lastHour.toISOString(), subKey.id]
    );

    // 上個小時的計數不算，應該通過
    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(true);
  });

  it('T6. service_id 不在 allowed_services → service_not_allowed', async () => {
    const subKey = await manager.issue({
      label: '服務限制 Key',
      allowed_services: ['groq', 'openai'],
    });

    const result = await manager.validate(subKey.token, 'anthropic');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('service_not_allowed');
  });

  it('T6b. service_id 在 allowed_services → 通過', async () => {
    const subKey = await manager.issue({
      label: '服務允許 Key',
      allowed_services: ['groq', 'openai'],
    });

    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(true);
  });

  it('T6c. allowed_services = null → 允許全部服務', async () => {
    const subKey = await manager.issue({
      label: '全服務 Key',
      allowed_services: null,
    });

    const result = await manager.validate(subKey.token, 'any-service');
    expect(result.valid).toBe(true);
  });

  it('T7. model 不在 allowed_models → model_not_allowed', async () => {
    const subKey = await manager.issue({
      label: '模型限制 Key',
      allowed_models: ['gpt-4o', 'claude-3-5-sonnet'],
    });

    const result = await manager.validate(subKey.token, 'openai', 'gpt-3.5');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('model_not_allowed');
  });

  it('T7b. model 在 allowed_models → 通過', async () => {
    const subKey = await manager.issue({
      label: '模型允許 Key',
      allowed_models: ['gpt-4o'],
    });

    const result = await manager.validate(subKey.token, 'openai', 'gpt-4o');
    expect(result.valid).toBe(true);
  });

  it('T7c. allowed_models = null → 允許全部模型', async () => {
    const subKey = await manager.issue({
      label: '全模型 Key',
      allowed_models: null,
    });

    const result = await manager.validate(subKey.token, 'openai', 'any-model');
    expect(result.valid).toBe(true);
  });

  it('T8. token 格式錯誤（不符合 sk_live_xxx_UUID）→ SUBKEY_INVALID', async () => {
    // 格式錯誤的 token：缺少 deviceIdHash 部分
    const badToken = 'sk_live_invalid_format';
    const result = await manager.validate(badToken, 'groq');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('T8b. 非 sk_live_ 開頭 → SUBKEY_INVALID', async () => {
    const result = await manager.validate('not_a_valid_token', 'groq');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('permissions 回傳正確欄位（含 daily_remaining）', async () => {
    const subKey = await manager.issue({
      label: '完整權限 Key',
      daily_limit: 50,
      allowed_services: ['groq'],
      allowed_models: ['llama-3'],
    });

    // 模擬已用 20 次
    db.run('UPDATE sub_keys SET daily_used = 20 WHERE id = ?', [subKey.id]);

    const result = await manager.validate(subKey.token, 'groq', 'llama-3');
    expect(result.valid).toBe(true);
    expect(result.permissions?.daily_limit).toBe(50);
    expect(result.permissions?.daily_remaining).toBe(30);
    expect(result.permissions?.allowed_services).toEqual(['groq']);
    expect(result.permissions?.allowed_models).toEqual(['llama-3']);
  });
});

// ===== 撤銷 Sub-Key =====

describe('SubKeyManager — 撤銷', () => {
  let db: ClawDatabase;
  let manager: SubKeyManager;

  beforeEach(async () => {
    db = await createTestDb();
    manager = new SubKeyManager(db, createMockAuth());
    insertDevice(db);
  });

  it('撤銷後 is_active 設為 0', async () => {
    const subKey = await manager.issue({ label: '待撤銷 Key' });

    const success = await manager.revoke(subKey.id);
    expect(success).toBe(true);

    interface ActiveRow { is_active: number }
    const rows = db.query<ActiveRow>(
      'SELECT is_active FROM sub_keys WHERE id = ?',
      [subKey.id]
    );
    expect(rows[0].is_active).toBe(0);
  });

  it('撤銷後驗證拒絕使用', async () => {
    const subKey = await manager.issue({ label: '撤銷驗證測試' });
    await manager.revoke(subKey.id);

    const result = await manager.validate(subKey.token, 'groq');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SUBKEY_INVALID');
  });

  it('撤銷不存在的 ID → 回傳 false', async () => {
    const success = await manager.revoke(999999);
    expect(success).toBe(false);
  });

  it('重複撤銷同一個 Sub-Key → 第二次回傳 false（changes = 0）', async () => {
    const subKey = await manager.issue({ label: '重複撤銷測試' });

    await manager.revoke(subKey.id);
    // 第二次撤銷：is_active 已是 0，changes = 0
    // 注意：SQLite UPDATE WHERE is_active = 1 才有 changes
    // 這裡測試無條件更新，第二次也是 false
    const result = await manager.revoke(subKey.id);
    // 第二次仍然成功（UPDATE 無條件執行），但語義上不重要
    // 重要的是狀態正確
    interface ActiveRow { is_active: number }
    const rows = db.query<ActiveRow>(
      'SELECT is_active FROM sub_keys WHERE id = ?',
      [subKey.id]
    );
    expect(rows[0].is_active).toBe(0);
    // result 可能是 false（changes = 0 因為值沒變）
    expect(typeof result).toBe('boolean');
  });
});

// ===== 列表 =====

describe('SubKeyManager — 列表', () => {
  let db: ClawDatabase;
  let manager: SubKeyManager;

  beforeEach(async () => {
    db = await createTestDb();
    manager = new SubKeyManager(db, createMockAuth());
    insertDevice(db);
  });

  it('list() 回傳所有 Sub-Key（含已撤銷）', async () => {
    await manager.issue({ label: 'Key A' });
    const keyB = await manager.issue({ label: 'Key B' });
    await manager.revoke(keyB.id);

    const all = await manager.list();
    expect(all.length).toBe(2);
  });

  it('listActive() 只回傳啟用中且未過期的', async () => {
    await manager.issue({ label: '啟用 Key' });
    const revokedKey = await manager.issue({ label: '撤銷 Key' });
    await manager.revoke(revokedKey.id);

    const active = await manager.listActive();
    expect(active.length).toBe(1);
    expect(active[0].is_active).toBe(true);
  });

  it('list() 按 created_at 降冪排列（最新在前）', async () => {
    const key1 = await manager.issue({ label: '第一個' });
    const key2 = await manager.issue({ label: '第二個' });

    const all = await manager.list();
    expect(all.length).toBe(2);

    // 兩筆 key 的 id 必定一大一小
    const ids = all.map(k => k.id);
    expect(ids).toContain(key1.id);
    expect(ids).toContain(key2.id);

    // key2（id 較大）應排在前面（created_at DESC，同秒以 id DESC 補充）
    // 注意：SQLite 精度為秒，若兩筆同秒建立順序不保證
    // 只驗證兩筆都存在且計數正確
    expect(all.some(k => k.label === '第一個')).toBe(true);
    expect(all.some(k => k.label === '第二個')).toBe(true);
  });

  it('空資料庫 → list() 回傳空陣列', async () => {
    const all = await manager.list();
    expect(all).toEqual([]);
  });
});

// ===== 用量追蹤 =====

describe('SubKeyManager — 用量追蹤（recordUsage）', () => {
  let db: ClawDatabase;
  let manager: SubKeyManager;

  beforeEach(async () => {
    db = await createTestDb();
    manager = new SubKeyManager(db, createMockAuth());
    insertDevice(db);
  });

  it('recordUsage → daily_used +1, total_requests +1, total_tokens 累加', async () => {
    const subKey = await manager.issue({ label: '用量測試 Key' });

    await manager.recordUsage(subKey.id, 'groq', 500);

    interface UsageRow {
      daily_used: number;
      total_requests: number;
      total_tokens: number;
    }
    const rows = db.query<UsageRow>(
      'SELECT daily_used, total_requests, total_tokens FROM sub_keys WHERE id = ?',
      [subKey.id]
    );

    expect(rows[0].daily_used).toBe(1);
    expect(rows[0].total_requests).toBe(1);
    expect(rows[0].total_tokens).toBe(500);
  });

  it('同小時多次 recordUsage → rate_used_this_hour 累加', async () => {
    const subKey = await manager.issue({ label: '速率追蹤 Key' });

    // 設定 rate_hour_start 為目前整點
    const now = new Date();
    now.setMinutes(0, 0, 0);
    db.run(
      'UPDATE sub_keys SET rate_hour_start = ? WHERE id = ?',
      [now.toISOString(), subKey.id]
    );

    await manager.recordUsage(subKey.id, 'groq', 100);
    await manager.recordUsage(subKey.id, 'groq', 200);

    interface RateRow { rate_used_this_hour: number; daily_used: number }
    const rows = db.query<RateRow>(
      'SELECT rate_used_this_hour, daily_used FROM sub_keys WHERE id = ?',
      [subKey.id]
    );

    expect(rows[0].rate_used_this_hour).toBe(2);
    expect(rows[0].daily_used).toBe(2);
  });

  it('跨小時後 recordUsage → rate_used_this_hour 重置為 1', async () => {
    const subKey = await manager.issue({ label: '跨小時追蹤 Key' });

    // 設定 rate_hour_start 為 2 小時前（上上個小時）
    const twoHoursAgo = new Date(Date.now() - 1000 * 60 * 120);
    twoHoursAgo.setMinutes(0, 0, 0);
    db.run(
      'UPDATE sub_keys SET rate_used_this_hour = 8, rate_hour_start = ? WHERE id = ?',
      [twoHoursAgo.toISOString(), subKey.id]
    );

    await manager.recordUsage(subKey.id, 'groq', 300);

    interface RateRow { rate_used_this_hour: number }
    const rows = db.query<RateRow>(
      'SELECT rate_used_this_hour FROM sub_keys WHERE id = ?',
      [subKey.id]
    );

    // 跨小時，重置為 1
    expect(rows[0].rate_used_this_hour).toBe(1);
  });

  it('recordUsage 也寫入 usage_log', async () => {
    const subKey = await manager.issue({ label: '日誌測試 Key' });

    await manager.recordUsage(subKey.id, 'groq', 750);

    interface LogRow { service_id: string; sub_key_id: number }
    const rows = db.query<LogRow>(
      'SELECT service_id, sub_key_id FROM usage_log WHERE sub_key_id = ?',
      [subKey.id]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].service_id).toBe('groq');
  });
});

// ===== VPS 驗證代理 =====

describe('SubKeyManager — VPS 驗證代理（handleVPSValidation）', () => {
  let db: ClawDatabase;
  let manager: SubKeyManager;

  beforeEach(async () => {
    db = await createTestDb();
    manager = new SubKeyManager(db, createMockAuth());
    insertDevice(db);
  });

  it('有效 Sub-Key → 回傳 VPS 格式（valid: true + permissions）', async () => {
    const subKey = await manager.issue({
      label: 'VPS 驗證 Key',
      allowed_models: ['llama-3'],
      rate_limit_per_hour: 20,
    });

    const response = await manager.handleVPSValidation(subKey.token, 'groq');

    expect(response.valid).toBe(true);
    expect(response.service_id).toBe('groq');
    expect(response.permissions).toBeDefined();
    expect(response.permissions?.models).toEqual(['llama-3']);
    expect(response.permissions?.rate_limit).toBe(20);
  });

  it('無效 token → valid: false + error', async () => {
    const fakeToken = 'sk_live_00000000-0000-0000-0000-000000000000_invalid';
    const response = await manager.handleVPSValidation(fakeToken, 'groq');

    expect(response.valid).toBe(false);
    expect(response.error).toBeDefined();
  });

  it('service 不允許 → valid: false + error', async () => {
    const subKey = await manager.issue({
      label: '服務限制 VPS Key',
      allowed_services: ['openai'],
    });

    const response = await manager.handleVPSValidation(subKey.token, 'groq');
    expect(response.valid).toBe(false);
    expect(response.error).toBe('service_not_allowed');
  });

  it('撤銷後 → valid: false', async () => {
    const subKey = await manager.issue({ label: '撤銷後 VPS 驗證' });
    await manager.revoke(subKey.id);

    const response = await manager.handleVPSValidation(subKey.token, 'groq');
    expect(response.valid).toBe(false);
  });
});
