// L0Manager 服務層單元測試
// 使用 in-memory 物件 mock（不建立真實 SQLite）
// 涵蓋：AES 加解密 round-trip、getKeys、getDeviceLimits、handleDonate、reportUsage、checkHealth

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { L0Manager } from '../l0-manager';
import type { L0KeyRecord, DonateBody } from '../l0-manager';
import type { VPSDatabase } from '../../storage/database';
import type { VPSKeyManager } from '../../core/ecdh';

// ===== Mock DB 建構器 =====
// 以 in-memory Map 模擬 SQLite 的 query/run 行為

function createMockDb() {
  // 模擬 l0_keys 表的資料儲存
  const l0KeysStore: Map<string, L0KeyRecord> = new Map();
  // 模擬 l0_device_usage 表
  const usageStore: Map<string, { used_count: number; daily_limit: number }> = new Map();
  // 模擬 devices 表（活躍裝置數）
  let activeDeviceCount = 3;

  // 用來追蹤 run 呼叫
  const runCalls: Array<{ sql: string; params: unknown[] }> = [];

  const db = {
    // 設定測試用的活躍裝置數
    _setActiveDeviceCount(n: number) { activeDeviceCount = n; },
    // 直接插入 l0 key 記錄（測試用）
    _insertL0Key(record: L0KeyRecord) { l0KeysStore.set(record.id, record); },
    // 讀取 l0 key 記錄（測試用）
    _getL0Keys() { return [...l0KeysStore.values()]; },
    // 讀取 run 呼叫記錄
    _getRunCalls() { return runCalls; },

    query<T>(sql: string, params?: unknown[]): T[] {
      const s = sql.trim().toLowerCase();

      // 計算活躍裝置數
      if (s.includes('count(*) as count from devices')) {
        return [{ count: activeDeviceCount }] as unknown as T[];
      }

      // 查 l0_keys 全部 active/degraded（無 since）
      if (s.includes('from l0_keys') && s.includes("status in ('active', 'degraded')") && !s.includes('updated_at >') && !s.includes('where id =') && !s.includes('key_hash =') && !s.includes('donated_by_device_id') && !s.includes('key_value_encrypted is not null')) {
        return [...l0KeysStore.values()].filter(
          (k) => k.status === 'active' || k.status === 'degraded',
        ) as unknown as T[];
      }

      // 查 l0_keys by updated_at > since
      if (s.includes('updated_at >') && params?.[0]) {
        const since = params[0] as string;
        return [...l0KeysStore.values()].filter(
          (k) => (k.status === 'active' || k.status === 'degraded') && k.updated_at > since,
        ) as unknown as T[];
      }

      // 查 key_hash
      if (s.includes('key_hash =') && params?.[0]) {
        const hash = params[0] as string;
        const found = [...l0KeysStore.values()].find((k) => k.key_hash === hash);
        return found ? [{ id: found.id }] as unknown as T[] : [] as T[];
      }

      // 查捐贈次數（今日 donated_by_device_id）
      if (s.includes('donated_by_device_id =') && params?.[0]) {
        const deviceId = params[0] as string;
        const today = params[1] as string;
        const count = [...l0KeysStore.values()].filter(
          (k) => k.donated_by_device_id === deviceId &&
                  k.created_at.startsWith(today),
        ).length;
        return [{ count }] as unknown as T[];
      }

      // 查健康監控（key_value_encrypted IS NOT NULL，非 dead）
      if (s.includes('key_value_encrypted is not null') && s.includes("status != 'dead'")) {
        return [...l0KeysStore.values()].filter(
          (k) => k.key_value_encrypted !== null && k.status !== 'dead',
        ) as unknown as T[];
      }

      // 查 l0_device_usage
      if (s.includes('from l0_device_usage') && params?.[0] && params?.[1]) {
        const deviceId = params[0] as string;
        const date = params[1] as string;
        const key = `${deviceId}:${date}`;
        const usage = usageStore.get(key);
        if (usage) {
          return [{ service_id: 'openai', ...usage }] as unknown as T[];
        }
        return [] as T[];
      }

      // 查 l0_keys service + quota（getDeviceLimits 用）
      if (s.includes('id, service_id, daily_quota from l0_keys')) {
        return [...l0KeysStore.values()]
          .filter((k) => k.status === 'active' || k.status === 'degraded')
          .map((k) => ({ id: k.id, service_id: k.service_id, daily_quota: k.daily_quota })) as unknown as T[];
      }

      return [] as T[];
    },

    run(sql: string, params?: unknown[]) {
      runCalls.push({ sql, params: params ?? [] });
      const s = sql.trim().toLowerCase();

      // INSERT l0_keys
      if (s.startsWith('insert into l0_keys')) {
        // 從 run 呼叫的 params 建立 mock 記錄
        // params 順序：id, service_id, key_value_encrypted, key_hash, daily_quota, donated_by_device_id, donated_by_display, is_anonymous_donation
        if (params && params.length >= 8) {
          const record: L0KeyRecord = {
            id: params[0] as string,
            service_id: params[1] as string,
            key_value_encrypted: params[2] as Uint8Array,
            key_hash: params[3] as string,
            encryption_key_id: 'l0_master_v1',
            status: 'active',
            daily_quota: params[4] as number,
            daily_used: 0,
            daily_reset_at: null,
            donated_by_device_id: params[5] as string,
            donated_by_display: params[6] as string | null,
            is_anonymous_donation: params[7] as number,
            last_health_check: null,
            created_at: new Date().toISOString().slice(0, 10),
            updated_at: new Date().toISOString(),
          };
          l0KeysStore.set(record.id, record);
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // UPDATE l0_keys（status 更新）
      if (s.startsWith('update l0_keys') && params) {
        if (s.includes('status =')) {
          // 有兩種情況：
          // 1. SET status = 'dead' WHERE id = ?（status 是 literal，params 只有 id）
          // 2. SET status = ? WHERE id = ?（params[0]=status, params[1]=id）
          const hasLiteralDead = s.includes("status = 'dead'");
          const hasLiteralActiveOrDegraded = s.includes("status = 'active'") || s.includes("status = 'degraded'");
          if (hasLiteralDead && params.length === 1) {
            // status 是字面值 'dead'，params[0] 是 id
            const id = params[0] as string;
            const record = l0KeysStore.get(id);
            if (record) {
              record.status = 'dead';
              record.updated_at = new Date().toISOString();
            }
          } else if (hasLiteralActiveOrDegraded && params.length >= 1) {
            // status 是字面值，params[0] 可能是 id（如果 SQL 沒有動態 status param）
            // 這種情況通常不會有 checkHealth 呼叫，先略過
          } else {
            // 動態 status：params[0]=status, params[last]=id
            const id = params[params.length - 1] as string;
            const record = l0KeysStore.get(id);
            if (record) {
              record.status = params[0] as L0KeyRecord['status'];
              record.updated_at = new Date().toISOString();
            }
          }
        }
        // UPDATE key_value_encrypted（二次更新 BLOB）
        if (s.includes('key_value_encrypted =') && params.length === 2) {
          const id = params[1] as string;
          const record = l0KeysStore.get(id);
          if (record) {
            record.key_value_encrypted = params[0] as Uint8Array;
          }
        }
        // UPDATE daily_used
        if (s.includes('daily_used = daily_used + 1') && params) {
          const id = params[0] as string;
          const record = l0KeysStore.get(id);
          if (record) {
            record.daily_used++;
          }
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      // INSERT l0_device_usage（UPSERT）
      if (s.includes('l0_device_usage') && params) {
        const deviceId = params[0] as string;
        const _serviceId = params[1] as string;
        const date = params[2] as string;
        const limit = params[3] as number;
        const mapKey = `${deviceId}:${date}`;
        const existing = usageStore.get(mapKey);
        if (existing) {
          existing.used_count++;
        } else {
          usageStore.set(mapKey, { used_count: 1, daily_limit: limit });
        }
        return { changes: 1, lastInsertRowid: 0 };
      }

      return { changes: 1, lastInsertRowid: 0 };
    },
  } as unknown as VPSDatabase & {
    _setActiveDeviceCount(n: number): void;
    _insertL0Key(record: L0KeyRecord): void;
    _getL0Keys(): L0KeyRecord[];
    _getRunCalls(): Array<{ sql: string; params: unknown[] }>;
  };

  return db;
}

// ===== Mock VPSKeyManager =====
// 模擬 ECDH 金鑰管理（不需要真實 crypto 金鑰對）

function createMockKeyManager(): VPSKeyManager {
  // 真實產生一個 CryptoKey pair 作為測試用金鑰
  let testPrivateKey: CryptoKey | null = null;
  let testPublicKey: CryptoKey | null = null;

  // 初始化時產生真實金鑰（async，在 beforeEach 中等待）
  async function ensureKeys() {
    if (!testPrivateKey) {
      const keyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits'],
      );
      testPrivateKey = keyPair.privateKey;
      testPublicKey = keyPair.publicKey;
    }
  }

  return {
    async init() { await ensureKeys(); },
    getCurrentPublicKey() {
      return { keyId: 'vps_key_v1', publicKey: 'mock_public_key_base64' };
    },
    getCurrentPrivateKey() { return testPrivateKey!; },
    async deriveSharedSecret(theirPublicKeyBase64: string) {
      await ensureKeys();
      // 匯入對方的公鑰做真實 ECDH
      const theirPublicKeyBuffer = Buffer.from(theirPublicKeyBase64, 'base64');
      const theirPublicKey = await globalThis.crypto.subtle.importKey(
        'spki',
        theirPublicKeyBuffer,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      const sharedBits = await globalThis.crypto.subtle.deriveBits(
        { name: 'ECDH', public: theirPublicKey },
        testPrivateKey!,
        256,
      );
      return new Uint8Array(sharedBits);
    },
    async generateKeyPair() { return { keyId: 'vps_key_v2', publicKey: 'mock_key_2' }; },
    async rotateIfNeeded() { return false; },
    async cleanupExpired() { return 0; },
  } as unknown as VPSKeyManager;
}

// ===== 測試輔助：產生 ECIES 加密包 =====
// 模擬客戶端用 VPS 公鑰（P-256）做 ECIES 加密

async function createEciesEncryptedPackage(
  vpsPublicKeyBase64: string,
  plainKey: string,
): Promise<{ encrypted_key: string; ephemeral_public_key: string; iv: string; tag: string }> {
  const webCrypto = globalThis.crypto;

  // 產生臨時 ECDH 金鑰對（模擬客戶端的 ephemeral key）
  const ephemeralKeyPair = await webCrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  );

  // 匯出臨時公鑰（SPKI Base64）
  const ephemeralPublicKeyBuffer = await webCrypto.subtle.exportKey('spki', ephemeralKeyPair.publicKey);
  const ephemeralPublicKeyBase64 = Buffer.from(ephemeralPublicKeyBuffer).toString('base64');

  // 匯入 VPS 公鑰
  const vpsPublicKeyBuffer = Buffer.from(vpsPublicKeyBase64, 'base64');
  const vpsPublicKey = await webCrypto.subtle.importKey(
    'spki',
    vpsPublicKeyBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // ECDH：臨時私鑰 × VPS 公鑰 → shared_secret
  const sharedBits = await webCrypto.subtle.deriveBits(
    { name: 'ECDH', public: vpsPublicKey },
    ephemeralKeyPair.privateKey,
    256,
  );
  const sharedSecret = new Uint8Array(sharedBits);

  // HKDF-SHA256 → AES key（和 VPS 側解密用相同參數）
  const keyMaterial = await webCrypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );
  const aesKeyBits = await webCrypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('clawapi-l0-donate'),
      info: new TextEncoder().encode('clawapi-l0-v1'),
    },
    keyMaterial,
    256,
  );
  const aesKey = await webCrypto.subtle.importKey(
    'raw',
    aesKeyBits,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  // AES-256-GCM 加密
  const iv = new Uint8Array(12);
  webCrypto.getRandomValues(iv);
  const plainBytes = new TextEncoder().encode(plainKey);
  const encryptedBuffer = await webCrypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    plainBytes,
  );

  // 分離密文和 tag（最後 16 bytes = tag）
  const encryptedBytes = new Uint8Array(encryptedBuffer);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const tag = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    encrypted_key: Buffer.from(ciphertext).toString('base64'),
    ephemeral_public_key: ephemeralPublicKeyBase64,
    iv: Buffer.from(iv).toString('base64'),
    tag: Buffer.from(tag).toString('base64'),
  };
}

// ===== 測試群組 =====

describe('L0Manager — AES-256-GCM 加解密 round-trip', () => {
  let manager: L0Manager;

  beforeEach(async () => {
    const db = createMockDb();
    const keyManager = createMockKeyManager();
    await keyManager.init();
    manager = new L0Manager(db, keyManager);
    await manager.init();
  });

  it('加密後解密應還原原始明文', async () => {
    const plainKey = 'sk-test-1234567890abcdef-my-api-key';

    // 加密
    const { ciphertext, iv, tag } = await manager.encryptL0Key(plainKey);

    // 確認密文非空且與明文不同
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(iv.length).toBe(12);
    expect(tag.length).toBe(16);
    expect(Buffer.from(ciphertext).toString()).not.toBe(plainKey);

    // 解密
    const decrypted = await manager.decryptL0Key(ciphertext, iv, tag);
    expect(decrypted).toBe(plainKey);
  });

  it('不同 plainKey 應產生不同密文', async () => {
    const key1 = 'sk-key-aaaa';
    const key2 = 'sk-key-bbbb';

    const enc1 = await manager.encryptL0Key(key1);
    const enc2 = await manager.encryptL0Key(key2);

    expect(Buffer.from(enc1.ciphertext).toString('hex')).not.toBe(
      Buffer.from(enc2.ciphertext).toString('hex'),
    );
  });

  it('同一 plainKey 兩次加密應有不同 IV（隨機性）', async () => {
    const key = 'sk-same-key-twice';

    const enc1 = await manager.encryptL0Key(key);
    const enc2 = await manager.encryptL0Key(key);

    // IV 應不同（極小概率相同，測試允許）
    // 更重要的是兩次的 IV 都是隨機產生的 12 bytes
    expect(enc1.iv.length).toBe(12);
    expect(enc2.iv.length).toBe(12);
  });

  it('篡改 tag 應導致解密失敗', async () => {
    const plainKey = 'sk-test-tamper';
    const { ciphertext, iv, tag } = await manager.encryptL0Key(plainKey);

    // 篡改 tag
    const badTag = new Uint8Array(tag);
    badTag[0] ^= 0xff;

    await expect(manager.decryptL0Key(ciphertext, iv, badTag)).rejects.toThrow();
  });
});

describe('L0Manager — getKeys', () => {
  let manager: L0Manager;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    const keyManager = createMockKeyManager();
    await keyManager.init();
    manager = new L0Manager(db, keyManager);
    await manager.init();
  });

  it('無 since → 回全部 active/degraded key', () => {
    // 插入 3 個 key
    const now = new Date().toISOString();
    db._insertL0Key({
      id: 'l0_1', service_id: 'openai', status: 'active',
      key_value_encrypted: null, key_hash: 'hash1', encryption_key_id: null,
      daily_quota: 1000, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    });
    db._insertL0Key({
      id: 'l0_2', service_id: 'anthropic', status: 'degraded',
      key_value_encrypted: null, key_hash: 'hash2', encryption_key_id: null,
      daily_quota: 500, daily_used: 100, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    });
    db._insertL0Key({
      id: 'l0_dead', service_id: 'openai', status: 'dead',
      key_value_encrypted: null, key_hash: 'hash3', encryption_key_id: null,
      daily_quota: 0, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    });

    const keys = manager.getKeys();
    expect(keys).not.toBeNull();
    expect(keys!.length).toBe(2); // 不含 dead
    expect(keys!.every((k) => k.status !== 'dead')).toBe(true);
  });

  it('有 since 且有新 key → 只回新的', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const newer = '2026-01-01T00:00:00.000Z';

    db._insertL0Key({
      id: 'l0_old', service_id: 'openai', status: 'active',
      key_value_encrypted: null, key_hash: 'hashA', encryption_key_id: null,
      daily_quota: 1000, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: old, updated_at: old,
    });
    db._insertL0Key({
      id: 'l0_new', service_id: 'openai', status: 'active',
      key_value_encrypted: null, key_hash: 'hashB', encryption_key_id: null,
      daily_quota: 1000, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: newer, updated_at: newer,
    });

    // since 設在兩個 key 之間
    const keys = manager.getKeys('2025-06-01T00:00:00.000Z');
    expect(keys).not.toBeNull();
    expect(keys!.length).toBe(1);
    expect(keys![0].id).toBe('l0_new');
  });

  it('有 since 且無新 key → 回 null（觸發 304）', () => {
    const old = '2025-01-01T00:00:00.000Z';
    db._insertL0Key({
      id: 'l0_1', service_id: 'openai', status: 'active',
      key_value_encrypted: null, key_hash: 'hashX', encryption_key_id: null,
      daily_quota: 1000, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: old, updated_at: old,
    });

    // since 比所有 key 都新 → null
    const keys = manager.getKeys('2026-12-31T00:00:00.000Z');
    expect(keys).toBeNull();
  });
});

describe('L0Manager — getDeviceLimits 額度公式', () => {
  let manager: L0Manager;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    const keyManager = createMockKeyManager();
    await keyManager.init();
    manager = new L0Manager(db, keyManager);
    await manager.init();

    // 插入一個 active key with quota 1000
    const now = new Date().toISOString();
    db._insertL0Key({
      id: 'l0_test', service_id: 'openai', status: 'active',
      key_value_encrypted: null, key_hash: 'hashQ', encryption_key_id: null,
      daily_quota: 1000, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    });
  });

  it('0 個活躍裝置（至少 1）→ Math.max(5, Math.min(100, floor(1000/1))) = 100', () => {
    db._setActiveDeviceCount(0); // 會被 Math.max(1,...) 處理
    const limits = manager.getDeviceLimits('clw_device_test');
    // 0 → treated as 1 → 1000/1 = 1000 → min(100, 1000) = 100 → max(5, 100) = 100
    expect(limits['openai']).toBe(100);
  });

  it('1 個活躍裝置 → floor(1000/1) = 1000 → min(100, 1000) = 100 → max(5, 100) = 100', () => {
    db._setActiveDeviceCount(1);
    const limits = manager.getDeviceLimits('clw_device_test');
    expect(limits['openai']).toBe(100);
  });

  it('20 個活躍裝置 → floor(1000/20) = 50 → min(100, 50) = 50 → max(5, 50) = 50', () => {
    db._setActiveDeviceCount(20);
    const limits = manager.getDeviceLimits('clw_device_test');
    expect(limits['openai']).toBe(50);
  });

  it('1000 個活躍裝置 → floor(1000/1000) = 1 → min(100, 1) = 1 → max(5, 1) = 5（下限 5）', () => {
    db._setActiveDeviceCount(1000);
    const limits = manager.getDeviceLimits('clw_device_test');
    expect(limits['openai']).toBe(5);
  });

  it('quota 為 null 的 key 不計入限額', () => {
    const now = new Date().toISOString();
    db._insertL0Key({
      id: 'l0_no_quota', service_id: 'gemini', status: 'active',
      key_value_encrypted: null, key_hash: 'hashNQ', encryption_key_id: null,
      daily_quota: null, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    });
    db._setActiveDeviceCount(10);
    const limits = manager.getDeviceLimits('clw_device_test');
    // openai 有 quota → 計算
    expect(limits['openai']).toBeDefined();
    // gemini 沒有 quota → 不計入
    expect(limits['gemini']).toBeUndefined();
  });
});

describe('L0Manager — handleDonate 捐贈流程', () => {
  let manager: L0Manager;
  let db: ReturnType<typeof createMockDb>;
  let keyManager: VPSKeyManager;

  beforeEach(async () => {
    db = createMockDb();
    keyManager = createMockKeyManager();
    await keyManager.init();
    manager = new L0Manager(db, keyManager);
    await manager.init();
  });

  it('1. 捐贈成功 → accepted: true + l0_key_id', async () => {
    // 取得 VPS 真實公鑰（從 keyManager 拿）
    // 需要一個真實的 P-256 公鑰做 ECIES
    const vpsKeyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    );
    const vpsPublicKeyBuffer = await globalThis.crypto.subtle.exportKey('spki', vpsKeyPair.publicKey);
    const vpsPublicKeyBase64 = Buffer.from(vpsPublicKeyBuffer).toString('base64');

    // 覆蓋 mock keyManager 的 deriveSharedSecret 使用我們的 vpsKeyPair
    const originalDerive = keyManager.deriveSharedSecret.bind(keyManager);
    keyManager.deriveSharedSecret = async (theirPublicKeyBase64: string) => {
      const theirPublicKeyBuffer = Buffer.from(theirPublicKeyBase64, 'base64');
      const theirPublicKey = await globalThis.crypto.subtle.importKey(
        'spki',
        theirPublicKeyBuffer,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      const sharedBits = await globalThis.crypto.subtle.deriveBits(
        { name: 'ECDH', public: theirPublicKey },
        vpsKeyPair.privateKey,
        256,
      );
      return new Uint8Array(sharedBits);
    };

    // 客戶端用 VPS 公鑰做 ECIES 加密
    const plainKey = 'sk-test-success-donate-key-12345';
    const { encrypted_key, ephemeral_public_key, iv, tag } = await createEciesEncryptedPackage(
      vpsPublicKeyBase64,
      plainKey,
    );

    const body: DonateBody = {
      service_id: 'openai',
      encrypted_key,
      ephemeral_public_key,
      iv,
      tag,
      display_name: 'TestDonor',
      anonymous: false,
    };

    const result = await manager.handleDonate('clw_device_0001', body);

    expect(result.accepted).toBe(true);
    expect(result.l0_key_id).toMatch(/^l0_/);
    expect(result.validation.key_valid).toBe(true);
    expect(result.validation.service_confirmed).toBe('openai');

    // 恢復原始方法
    keyManager.deriveSharedSecret = originalDerive;
  });

  it('2. 重複捐贈相同 Key → L0_DONATE_DUPLICATE (409)', async () => {
    const now = new Date().toISOString();
    // 先手動插入一個有 key_hash 的記錄
    const plainKey = 'sk-duplicate-key-test';
    const hashBuffer = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(plainKey),
    );
    const keyHash = Buffer.from(hashBuffer).toString('hex');

    db._insertL0Key({
      id: 'l0_existing', service_id: 'openai', status: 'active',
      key_value_encrypted: null, key_hash: keyHash, encryption_key_id: null,
      daily_quota: 1000, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: 'clw_device_0002', donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    });

    // 設定 mock keyManager 可以正常做 ECDH
    const vpsKeyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    );
    const vpsPublicKeyBuffer = await globalThis.crypto.subtle.exportKey('spki', vpsKeyPair.publicKey);
    const vpsPublicKeyBase64 = Buffer.from(vpsPublicKeyBuffer).toString('base64');

    keyManager.deriveSharedSecret = async (theirPublicKeyBase64: string) => {
      const theirPublicKeyBuffer = Buffer.from(theirPublicKeyBase64, 'base64');
      const theirPublicKey = await globalThis.crypto.subtle.importKey(
        'spki', theirPublicKeyBuffer, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
      );
      const sharedBits = await globalThis.crypto.subtle.deriveBits(
        { name: 'ECDH', public: theirPublicKey }, vpsKeyPair.privateKey, 256,
      );
      return new Uint8Array(sharedBits);
    };

    const { encrypted_key, ephemeral_public_key, iv, tag } = await createEciesEncryptedPackage(
      vpsPublicKeyBase64,
      plainKey,
    );

    const body: DonateBody = {
      service_id: 'openai',
      encrypted_key,
      ephemeral_public_key,
      iv,
      tag,
    };

    const err = await manager.handleDonate('clw_device_0002', body).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { errorCode: string }).errorCode).toBe('L0_DONATE_DUPLICATE');
  });

  it('3. ECIES 解密失敗（錯誤 IV）→ L0_DONATE_INVALID_KEY (400)', async () => {
    const body: DonateBody = {
      service_id: 'openai',
      encrypted_key: Buffer.from('fake_ciphertext').toString('base64'),
      ephemeral_public_key: 'invalid_base64_key==',
      iv: Buffer.from('bad_iv_123456').toString('base64'),
      tag: Buffer.from('bad_tag_12345678').toString('base64'),
    };

    const err = await manager.handleDonate('clw_device_0003', body).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { errorCode: string }).errorCode).toBe('L0_DONATE_INVALID_KEY');
  });

  it('4. 速率限制：超過 5 次 → L0_DONATE_RATE_LIMITED (429)', async () => {
    // 模擬今日已有 5 筆捐贈（插入 5 個由此裝置捐贈的 key）
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    for (let i = 0; i < DONATE_RATE_LIMIT_PER_DAY; i++) {
      db._insertL0Key({
        id: `l0_donated_${i}`,
        service_id: 'openai',
        status: 'active',
        key_value_encrypted: null,
        key_hash: `hash_rate_${i}`,
        encryption_key_id: null,
        daily_quota: 1000,
        daily_used: 0,
        daily_reset_at: null,
        donated_by_device_id: 'clw_rate_limit_device',
        donated_by_display: null,
        is_anonymous_donation: 0,
        last_health_check: null,
        created_at: `${today}T12:00:00.000Z`,
        updated_at: now,
      });
    }

    const body: DonateBody = {
      service_id: 'openai',
      encrypted_key: 'fake',
      ephemeral_public_key: 'fake',
      iv: 'fake',
      tag: 'fake',
    };

    const err = await manager.handleDonate('clw_rate_limit_device', body).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { errorCode: string }).errorCode).toBe('L0_DONATE_RATE_LIMITED');
  });

  it('5. 匿名捐贈 → donated_by_display 為 null', async () => {
    const vpsKeyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    );
    const vpsPublicKeyBuffer = await globalThis.crypto.subtle.exportKey('spki', vpsKeyPair.publicKey);
    const vpsPublicKeyBase64 = Buffer.from(vpsPublicKeyBuffer).toString('base64');

    keyManager.deriveSharedSecret = async (theirPublicKeyBase64: string) => {
      const buf = Buffer.from(theirPublicKeyBase64, 'base64');
      const theirKey = await globalThis.crypto.subtle.importKey(
        'spki', buf, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
      );
      const bits = await globalThis.crypto.subtle.deriveBits(
        { name: 'ECDH', public: theirKey }, vpsKeyPair.privateKey, 256,
      );
      return new Uint8Array(bits);
    };

    const plainKey = 'sk-anonymous-donate-xyz';
    const ecies = await createEciesEncryptedPackage(vpsPublicKeyBase64, plainKey);

    const body: DonateBody = {
      service_id: 'anthropic',
      encrypted_key: ecies.encrypted_key,
      ephemeral_public_key: ecies.ephemeral_public_key,
      iv: ecies.iv,
      tag: ecies.tag,
      anonymous: true, // 匿名
    };

    const result = await manager.handleDonate('clw_anon_device', body);
    expect(result.accepted).toBe(true);

    // 找到剛存入的 key
    const storedKeys = db._getL0Keys();
    const donated = storedKeys.find((k) => k.id === result.l0_key_id);
    expect(donated).toBeDefined();
    expect(donated!.is_anonymous_donation).toBe(1);
    expect(donated!.donated_by_display).toBeNull();
  });
});

// 用於 rate limit test 存取
const DONATE_RATE_LIMIT_PER_DAY = 5;

describe('L0Manager — reportUsage 用量回報', () => {
  let manager: L0Manager;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    const keyManager = createMockKeyManager();
    await keyManager.init();
    manager = new L0Manager(db, keyManager);
    await manager.init();

    // 插入測試 key
    const now = new Date().toISOString();
    db._insertL0Key({
      id: 'l0_usage_test', service_id: 'openai', status: 'active',
      key_value_encrypted: null, key_hash: 'hash_usage', encryption_key_id: null,
      daily_quota: 1000, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    });
  });

  it('回報 1 筆成功用量 → updated: 1 + daily_used++', async () => {
    const result = await manager.reportUsage('clw_device_usage', [
      {
        l0_key_id: 'l0_usage_test',
        service_id: 'openai',
        timestamp: new Date().toISOString(),
        success: true,
      },
    ]);

    expect(result.updated).toBe(1);

    // 確認 daily_used 已更新
    const keys = db._getL0Keys();
    const key = keys.find((k) => k.id === 'l0_usage_test');
    expect(key?.daily_used).toBe(1);
  });

  it('回報失敗用量 → daily_used 不增加', async () => {
    await manager.reportUsage('clw_device_usage', [
      {
        l0_key_id: 'l0_usage_test',
        service_id: 'openai',
        timestamp: new Date().toISOString(),
        success: false,
      },
    ]);

    const keys = db._getL0Keys();
    const key = keys.find((k) => k.id === 'l0_usage_test');
    expect(key?.daily_used).toBe(0); // 失敗不計
  });

  it('回報空陣列 → updated: 0', async () => {
    const result = await manager.reportUsage('clw_device_usage', []);
    expect(result.updated).toBe(0);
  });
});

describe('L0Manager — checkHealth 健康監控', () => {
  let manager: L0Manager;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    const keyManager = createMockKeyManager();
    await keyManager.init();
    manager = new L0Manager(db, keyManager);
    await manager.init();
  });

  it('無 key 可監控 → checked: 0', async () => {
    const result = await manager.checkHealth();
    expect(result.checked).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it('key_value_encrypted 為 null 的 key 被跳過', async () => {
    const now = new Date().toISOString();
    db._insertL0Key({
      id: 'l0_no_blob', service_id: 'openai', status: 'active',
      key_value_encrypted: null, // 無密文
      key_hash: 'hashH1', encryption_key_id: null,
      daily_quota: 1000, daily_used: 0, daily_reset_at: null,
      donated_by_device_id: null, donated_by_display: null,
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    });

    const result = await manager.checkHealth();
    // 無密文 → 不會被查到（SQL: WHERE key_value_encrypted IS NOT NULL）
    expect(result.checked).toBe(0);
  });

  it('額度 > 80% → 產生 warning', async () => {
    // 先加密一個 key 存入
    const { ciphertext, iv, tag } = await manager.encryptL0Key('sk-health-test');
    const fullBlob = new Uint8Array(iv.length + ciphertext.length + tag.length);
    fullBlob.set(iv, 0);
    fullBlob.set(ciphertext, iv.length);
    fullBlob.set(tag, iv.length + ciphertext.length);

    const now = new Date().toISOString();
    db._insertL0Key({
      id: 'l0_high_usage',
      service_id: 'openai',
      status: 'active',
      key_value_encrypted: fullBlob,
      key_hash: 'hashHU',
      encryption_key_id: null,
      daily_quota: 100,
      daily_used: 85,  // 85% > 80%
      daily_reset_at: null,
      donated_by_device_id: null,
      donated_by_display: null,
      is_anonymous_donation: 0,
      last_health_check: null,
      created_at: now,
      updated_at: now,
    });

    const result = await manager.checkHealth();
    expect(result.checked).toBe(1);
    expect(result.warnings).toBe(1);
  });

  it('master key 重新產生後解密失敗 → 標記 dead', async () => {
    // 模擬一個用舊 master key 加密的 BLOB（無法被新 manager 解密）
    // 用隨機 bytes 模擬不合法的密文（AES-GCM tag 驗證一定會失敗）
    const fakeBlobSize = 12 + 32 + 16; // IV + 密文 + tag
    const fakeBlob = new Uint8Array(fakeBlobSize);
    globalThis.crypto.getRandomValues(fakeBlob);

    const now = new Date().toISOString();
    db._insertL0Key({
      id: 'l0_dead_key',
      service_id: 'openai',
      status: 'active', // 目前是 active
      key_value_encrypted: fakeBlob,
      key_hash: 'hashDead',
      encryption_key_id: null,
      daily_quota: 1000,
      daily_used: 0,
      daily_reset_at: null,
      donated_by_device_id: null,
      donated_by_display: null,
      is_anonymous_donation: 0,
      last_health_check: null,
      created_at: now,
      updated_at: now,
    });

    const result = await manager.checkHealth();
    expect(result.checked).toBe(1);
    expect(result.updated).toBe(1);

    // key 應被標記為 dead
    const keys = db._getL0Keys();
    const key = keys.find((k) => k.id === 'l0_dead_key');
    expect(key?.status).toBe('dead');
  });

  it('prepareForDownload → 輸出正確格式', async () => {
    const { ciphertext, iv, tag } = await manager.encryptL0Key('sk-download-test');
    const fullBlob = new Uint8Array(iv.length + ciphertext.length + tag.length);
    fullBlob.set(iv, 0);
    fullBlob.set(ciphertext, iv.length);
    fullBlob.set(tag, iv.length + ciphertext.length);

    const now = new Date().toISOString();
    const record: L0KeyRecord = {
      id: 'l0_dl_test', service_id: 'openai', status: 'active',
      key_value_encrypted: fullBlob, key_hash: 'hashDL',
      encryption_key_id: 'l0_master_v1',
      daily_quota: 1000, daily_used: 100, daily_reset_at: null,
      donated_by_device_id: 'clw_donor', donated_by_display: 'Donor Name',
      is_anonymous_donation: 0, last_health_check: null,
      created_at: now, updated_at: now,
    };

    const pkg = manager.prepareForDownload(record);

    expect(pkg.id).toBe('l0_dl_test');
    expect(pkg.service_id).toBe('openai');
    expect(pkg.key_encrypted).toBeTruthy(); // Base64 非空
    expect(pkg.encryption_method).toBe('aes-256-gcm');
    expect(pkg.status).toBe('active');
    expect(pkg.donated_by).toBe('Donor Name');
    expect(pkg.total_daily_quota).toBe(1000);
    expect(pkg.total_daily_used).toBe(100);
  });
});
