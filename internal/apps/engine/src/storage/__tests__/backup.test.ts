// 備份模組測試
// 測試加密 round-trip、雲端備份 mock、錯誤處理

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createDatabase, ClawDatabase } from '../database';
import {
  collectBackupData,
  encryptBackup,
  decryptBackup,
  exportBackup,
  importBackup,
  importBackupToDb,
  importBackupFromFile,
  validateBackupFileStructure,
  validateBackupData,
  CloudBackupClient,
  type BackupFile,
  type BackupData,
  type ImportMode,
} from '../backup';
import { BACKUP_MAX_SIZE_BYTES } from '@clawapi/protocol';

// ===== 輔助函式 =====

/** 建立記憶體測試 DB 並插入範例資料 */
async function createTestDbWithData(): Promise<ClawDatabase> {
  const db = createDatabase(':memory:');
  await db.init();

  // 插入範例 keys（key_encrypted 是 BLOB，用 Buffer 模擬）
  const fakeEncrypted = Buffer.from('fake-encrypted-key-data');
  db.run(
    `INSERT INTO keys (service_id, key_encrypted, pool_type, label, status, priority, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['groq', fakeEncrypted, 'king', '測試 Key', 'active', 0, 0]
  );

  db.run(
    `INSERT INTO keys (service_id, key_encrypted, pool_type, label, status, priority, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['openai', fakeEncrypted, 'friend', null, 'active', 1, 1]
  );

  // 插入範例 claw_keys
  db.run(
    `INSERT INTO claw_keys (service_id, key_encrypted, model_id, is_active, daily_limit)
     VALUES (?, ?, ?, ?, ?)`,
    ['openai', fakeEncrypted, 'gpt-4o', 1, 100]
  );

  // 插入範例 sub_keys
  db.run(
    `INSERT INTO sub_keys (token, label, daily_limit, allowed_services, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    ['sk_test_1234567890', '測試 Sub-Key', 50, 'groq,openai', 1]
  );

  // 插入範例 settings
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)`,
    ['theme', 'dark']
  );
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)`,
    ['locale', 'zh-TW']
  );

  return db;
}

/** 建立空的測試 DB */
async function createEmptyTestDb(): Promise<ClawDatabase> {
  const db = createDatabase(':memory:');
  await db.init();
  return db;
}

// ===== 測試套件 =====

describe('Backup — 資料收集', () => {
  let db: ClawDatabase;

  beforeEach(async () => {
    db = await createTestDbWithData();
  });

  afterEach(async () => {
    await db.close();
  });

  it('應收集所有表的資料', () => {
    const data = collectBackupData(db);

    expect(data.keys).toHaveLength(2);
    expect(data.claw_keys).toHaveLength(1);
    expect(data.sub_keys).toHaveLength(1);
    expect(data.config).toHaveLength(2);
  });

  it('keys 應包含正確欄位', () => {
    const data = collectBackupData(db);
    const key = data.keys[0]!;

    expect(key.service_id).toBe('groq');
    expect(key.pool_type).toBe('king');
    expect(key.label).toBe('測試 Key');
    expect(key.status).toBe('active');
    expect(typeof key.key_encrypted).toBe('string'); // 已轉為 base64
  });

  it('claw_keys 應包含正確欄位', () => {
    const data = collectBackupData(db);
    const gk = data.claw_keys[0]!;

    expect(gk.service_id).toBe('openai');
    expect(gk.model_id).toBe('gpt-4o');
    expect(gk.is_active).toBe(1);
    expect(gk.daily_limit).toBe(100);
  });

  it('sub_keys 應包含正確欄位', () => {
    const data = collectBackupData(db);
    const sk = data.sub_keys[0]!;

    expect(sk.token).toBe('sk_test_1234567890');
    expect(sk.label).toBe('測試 Sub-Key');
    expect(sk.daily_limit).toBe(50);
  });

  it('settings 應包含正確欄位', () => {
    const data = collectBackupData(db);
    const themeConfig = data.config.find(c => c.key === 'theme');
    expect(themeConfig).toBeDefined();
    expect(themeConfig!.value).toBe('dark');
  });

  it('空 DB 應回傳空陣列', async () => {
    const emptyDb = await createEmptyTestDb();
    const data = collectBackupData(emptyDb);

    expect(data.keys).toHaveLength(0);
    expect(data.claw_keys).toHaveLength(0);
    expect(data.sub_keys).toHaveLength(0);
    expect(data.config).toHaveLength(0);

    await emptyDb.close();
  });
});

describe('Backup — 加密 Round-Trip', () => {
  let db: ClawDatabase;

  beforeEach(async () => {
    db = await createTestDbWithData();
  });

  afterEach(async () => {
    await db.close();
  });

  it('加密後再解密，資料應一致', () => {
    const password = 'test-password-123!';
    const originalData = collectBackupData(db);

    // 加密
    const backupFile = encryptBackup(originalData, password);

    // 驗證 BackupFile 結構
    expect(backupFile.version).toBe(1);
    expect(backupFile.engine_version).toBeTruthy();
    expect(backupFile.salt).toBeTruthy();
    expect(backupFile.iv).toBeTruthy();
    expect(backupFile.auth_tag).toBeTruthy();
    expect(backupFile.encrypted_data).toBeTruthy();
    expect(backupFile.created_at).toBeTruthy();

    // 解密
    const decryptedData = decryptBackup(backupFile, password);

    // 驗證資料一致
    expect(decryptedData.keys).toHaveLength(originalData.keys.length);
    expect(decryptedData.claw_keys).toHaveLength(originalData.claw_keys.length);
    expect(decryptedData.sub_keys).toHaveLength(originalData.sub_keys.length);
    expect(decryptedData.config).toHaveLength(originalData.config.length);

    // 驗證具體值
    expect(decryptedData.keys[0]!.service_id).toBe(originalData.keys[0]!.service_id);
    expect(decryptedData.keys[0]!.key_encrypted).toBe(originalData.keys[0]!.key_encrypted);
    expect(decryptedData.claw_keys[0]!.model_id).toBe(originalData.claw_keys[0]!.model_id);
    expect(decryptedData.sub_keys[0]!.token).toBe(originalData.sub_keys[0]!.token);
  });

  it('用錯密碼解密應失敗', () => {
    const data = collectBackupData(db);
    const backupFile = encryptBackup(data, 'correct-password');

    expect(() => {
      decryptBackup(backupFile, 'wrong-password');
    }).toThrow('備份解密失敗');
  });

  it('不同密碼加密的結果應不同', () => {
    const data = collectBackupData(db);

    const backup1 = encryptBackup(data, 'password-1');
    const backup2 = encryptBackup(data, 'password-2');

    expect(backup1.encrypted_data).not.toBe(backup2.encrypted_data);
    expect(backup1.salt).not.toBe(backup2.salt);
    expect(backup1.iv).not.toBe(backup2.iv);
  });

  it('空資料也能正常 round-trip', () => {
    const emptyData: BackupData = {
      keys: [],
      claw_keys: [],
      sub_keys: [],
      config: [],
      adapters: [],
    };
    const password = 'empty-test';

    const backupFile = encryptBackup(emptyData, password);
    const decrypted = decryptBackup(backupFile, password);

    expect(decrypted.keys).toHaveLength(0);
    expect(decrypted.claw_keys).toHaveLength(0);
    expect(decrypted.sub_keys).toHaveLength(0);
    expect(decrypted.config).toHaveLength(0);
  });
});

describe('Backup — exportBackup + importBackup round-trip', () => {
  let sourceDb: ClawDatabase;
  let targetDb: ClawDatabase;

  beforeEach(async () => {
    sourceDb = await createTestDbWithData();
    targetDb = await createEmptyTestDb();
  });

  afterEach(async () => {
    await sourceDb.close();
    await targetDb.close();
  });

  it('完整 export → import round-trip 應成功', () => {
    const password = 'round-trip-test';

    // 匯出
    const backupFile = exportBackup(sourceDb, password);

    // 匯入到空 DB
    const result = importBackup(targetDb, backupFile, password, 'overwrite');

    expect(result.imported.keys).toBe(2);
    expect(result.imported.claw_keys).toBe(1);
    expect(result.imported.sub_keys).toBe(1);
    expect(result.imported.config).toBe(2);

    // 驗證 target DB 中的資料
    const keys = targetDb.query<{ service_id: string }>(
      'SELECT service_id FROM keys ORDER BY id'
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]!.service_id).toBe('groq');
    expect(keys[1]!.service_id).toBe('openai');

    const clawKeys = targetDb.query<{ model_id: string }>(
      'SELECT model_id FROM claw_keys'
    );
    expect(clawKeys).toHaveLength(1);
    expect(clawKeys[0]!.model_id).toBe('gpt-4o');

    const subKeys = targetDb.query<{ token: string }>(
      'SELECT token FROM sub_keys'
    );
    expect(subKeys).toHaveLength(1);
    expect(subKeys[0]!.token).toBe('sk_test_1234567890');

    const settings = targetDb.query<{ key: string; value: string }>(
      'SELECT key, value FROM settings ORDER BY key'
    );
    expect(settings).toHaveLength(2);
  });

  it('merge 模式應跳過重複資料', () => {
    const password = 'merge-test';

    // 先匯入一次
    const backupFile = exportBackup(sourceDb, password);
    importBackup(targetDb, backupFile, password, 'overwrite');

    // 再匯入一次（merge 模式）
    const result2 = importBackup(targetDb, backupFile, password, 'merge');

    // merge 模式下重複的 sub_keys（unique token）會失敗，被跳過
    // keys 沒有 unique 約束，所以會多新增
    // settings 用 REPLACE，所以不會重複
    expect(result2.imported.config).toBe(2); // REPLACE 生效
  });

  it('overwrite 模式應清空後匯入', () => {
    const password = 'overwrite-test';

    // 先匯入一次
    const backupFile = exportBackup(sourceDb, password);
    importBackup(targetDb, backupFile, password, 'overwrite');

    // 再匯入一次（overwrite 模式）
    const result2 = importBackup(targetDb, backupFile, password, 'overwrite');

    expect(result2.imported.keys).toBe(2);
    expect(result2.imported.claw_keys).toBe(1);
    expect(result2.imported.sub_keys).toBe(1);

    // 確認沒有多餘的
    const keys = targetDb.query<{ id: number }>('SELECT id FROM keys');
    expect(keys).toHaveLength(2);
  });
});

describe('Backup — 驗證', () => {
  it('validateBackupFileStructure 應通過正確結構', () => {
    const valid: BackupFile = {
      version: 1,
      created_at: new Date().toISOString(),
      engine_version: '0.1.0',
      salt: 'aabbccdd',
      iv: '112233',
      auth_tag: '445566',
      encrypted_data: 'base64data==',
    };

    expect(() => validateBackupFileStructure(valid)).not.toThrow();
  });

  it('validateBackupFileStructure 不支援版本 2', () => {
    const invalid = {
      version: 2,
      created_at: new Date().toISOString(),
      engine_version: '0.1.0',
      salt: 'aa',
      iv: 'bb',
      auth_tag: 'cc',
      encrypted_data: 'dd',
    } as unknown as BackupFile;

    expect(() => validateBackupFileStructure(invalid)).toThrow('版本不支援');
  });

  it('validateBackupFileStructure 缺少 salt 應失敗', () => {
    const invalid = {
      version: 1,
      created_at: new Date().toISOString(),
      engine_version: '0.1.0',
      // salt 缺少
      iv: 'bb',
      auth_tag: 'cc',
      encrypted_data: 'dd',
    } as unknown as BackupFile;

    expect(() => validateBackupFileStructure(invalid)).toThrow('salt');
  });

  it('validateBackupData 應通過正確資料', () => {
    const valid: BackupData = {
      keys: [],
      claw_keys: [],
      sub_keys: [],
      config: [],
      adapters: [],
    };

    expect(() => validateBackupData(valid)).not.toThrow();
  });

  it('validateBackupData keys 不是陣列應失敗', () => {
    const invalid = {
      keys: 'not-array',
      claw_keys: [],
      sub_keys: [],
      config: [],
      adapters: [],
    } as unknown as BackupData;

    expect(() => validateBackupData(invalid)).toThrow('keys 應為陣列');
  });

  it('validateBackupData null 應失敗', () => {
    expect(() => validateBackupData(null as unknown as BackupData)).toThrow('不是有效的物件');
  });
});

describe('Backup — 雲端備份 Client（mock）', () => {
  it('upload 成功時應回傳上傳結果', async () => {
    // Mock fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({
        uploaded: true,
        backup_size: 1024,
        server_checksum: 'abc123',
        stored_at: new Date().toISOString(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as any;

    const client = new CloudBackupClient({
      baseUrl: 'https://api.clawapi.com',
      deviceToken: 'test-token',
      googleToken: 'google-token',
    });

    const backupFile: BackupFile = {
      version: 1,
      created_at: new Date().toISOString(),
      engine_version: '0.1.0',
      salt: 'aa',
      iv: 'bb',
      auth_tag: 'cc',
      encrypted_data: 'dd',
    };

    const result = await client.upload(backupFile);
    expect(result.uploaded).toBe(true);
    expect(result.backup_size).toBe(1024);

    globalThis.fetch = originalFetch;
  });

  it('upload 失敗時應拋出錯誤', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Forbidden', { status: 403 })) as any;

    const client = new CloudBackupClient({
      baseUrl: 'https://api.clawapi.com',
      deviceToken: 'test-token',
      googleToken: 'google-token',
    });

    const backupFile: BackupFile = {
      version: 1,
      created_at: new Date().toISOString(),
      engine_version: '0.1.0',
      salt: 'aa',
      iv: 'bb',
      auth_tag: 'cc',
      encrypted_data: 'dd',
    };

    await expect(client.upload(backupFile)).rejects.toThrow('HTTP 403');

    globalThis.fetch = originalFetch;
  });

  it('download 成功時應回傳 BackupFile', async () => {
    const expectedBackup: BackupFile = {
      version: 1,
      created_at: new Date().toISOString(),
      engine_version: '0.1.0',
      salt: 'salt-hex',
      iv: 'iv-hex',
      auth_tag: 'tag-hex',
      encrypted_data: 'encrypted-base64',
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify(expectedBackup),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as any;

    const client = new CloudBackupClient({
      baseUrl: 'https://api.clawapi.com',
      deviceToken: 'test-token',
      googleToken: 'google-token',
    });

    const result = await client.download();
    expect(result.version).toBe(1);
    expect(result.salt).toBe('salt-hex');

    globalThis.fetch = originalFetch;
  });

  it('download 失敗時應拋出錯誤', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as any;

    const client = new CloudBackupClient({
      baseUrl: 'https://api.clawapi.com',
      deviceToken: 'test-token',
      googleToken: 'google-token',
    });

    await expect(client.download()).rejects.toThrow('HTTP 404');

    globalThis.fetch = originalFetch;
  });

  it('delete 成功時應回傳刪除結果', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ deleted: true, message: '備份已刪除' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as any;

    const client = new CloudBackupClient({
      baseUrl: 'https://api.clawapi.com',
      deviceToken: 'test-token',
      googleToken: 'google-token',
    });

    const result = await client.delete();
    expect(result.deleted).toBe(true);
    expect(result.message).toContain('已刪除');

    globalThis.fetch = originalFetch;
  });

  it('delete 失敗時應拋出錯誤', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Server Error', { status: 500 })) as any;

    const client = new CloudBackupClient({
      baseUrl: 'https://api.clawapi.com',
      deviceToken: 'test-token',
      googleToken: 'google-token',
    });

    await expect(client.delete()).rejects.toThrow('HTTP 500');

    globalThis.fetch = originalFetch;
  });
});

// ===== 突變測試：安全防護 =====
// 這些測試專門保護安全邏輯，確保移除防護時測試會失敗

describe('Backup — 路徑穿越防護（突變偵測）', () => {
  it('嘗試讀取 /etc/passwd 應被擋下', () => {
    expect(() => {
      importBackupFromFile('/etc/passwd', 'any-password');
    }).toThrow('路徑受限');
  });

  it('嘗試 ../ 穿越應被擋下', () => {
    expect(() => {
      importBackupFromFile('/tmp/../etc/shadow', 'any-password');
    }).toThrow('路徑受限');
  });

  it('嘗試讀取 home 根目錄檔案應被擋下', () => {
    expect(() => {
      importBackupFromFile(`${process.env.HOME}/.ssh/id_rsa`, 'any-password');
    }).toThrow('路徑受限');
  });

  it('/tmp/ 底下的檔案路徑應被允許（不丟路徑受限錯誤）', () => {
    // 這裡會因為檔案不存在而丟 ENOENT，但不應丟「路徑受限」
    try {
      importBackupFromFile('/tmp/clawapi-test-nonexistent.bak', 'password');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('路徑受限');
      // 應該是 ENOENT 或其他錯誤，不是路徑拒絕
    }
  });
});

describe('Backup — 備份大小上限（突變偵測）', () => {
  it('驗證 BACKUP_MAX_SIZE_BYTES 常數存在且合理', () => {
    // 如果有人把上限改成 Infinity 或 0，這個測試會發現
    expect(BACKUP_MAX_SIZE_BYTES).toBeGreaterThan(0);
    expect(BACKUP_MAX_SIZE_BYTES).toBeLessThan(1024 * 1024 * 1024); // < 1GB
    expect(Number.isFinite(BACKUP_MAX_SIZE_BYTES)).toBe(true);
  });
});
