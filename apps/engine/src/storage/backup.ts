// 備份匯出/匯入模組
// 支援本機加密備份（AES-256-GCM + PBKDF2）和雲端備份（VPS 端 API）
// 備份檔案格式：.clawapi-backup（JSON 包裝加密資料）

import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { BACKUP_MAX_SIZE_BYTES } from '@clawapi/protocol';
import { getEngineVersion } from '../version';
import type {
  BackupUploadHeaders,
  BackupUploadResponse,
  BackupDownloadHeaders,
  BackupDeleteResponse,
} from '@clawapi/protocol';
import type { ClawDatabase } from './database';

// ===== 常數 =====

/** PBKDF2 迭代次數（安全標準） */
const PBKDF2_ITERATIONS = 100_000;
/** PBKDF2 鹽值長度（bytes） */
const SALT_LENGTH = 16;
/** AES-256-GCM IV 長度（bytes） */
const IV_LENGTH = 12;
/** AES-256-GCM AuthTag 長度（bytes） */
const AUTH_TAG_LENGTH = 16;
/** AES Key 長度（bytes） */
const KEY_LENGTH = 32;

// ===== 型別定義 =====

/** 備份檔案結構（序列化為 JSON） */
export interface BackupFile {
  version: 1;
  created_at: string;
  engine_version: string;
  salt: string;          // hex，PBKDF2 用
  iv: string;            // hex，AES-256-GCM 用
  auth_tag: string;      // hex
  encrypted_data: string; // base64
}

/** 備份資料（加密前/解密後的結構） */
export interface BackupData {
  keys: BackupKeyRow[];
  claw_keys: BackupClawKeyRow[];
  sub_keys: BackupSubKeyRow[];
  config: BackupSettingRow[];
  adapters: string[];  // 已安裝的 adapter IDs
}

/** keys 表備份列 */
interface BackupKeyRow {
  service_id: string;
  key_encrypted: string;    // base64
  pool_type: string;
  label: string | null;
  status: string;
  priority: number;
  pinned: number;
  created_at: string;
}

/** claw_keys 表備份列 */
interface BackupClawKeyRow {
  service_id: string;
  key_encrypted: string;    // base64
  model_id: string;
  is_active: number;
  daily_limit: number | null;
  created_at: string;
}

/** sub_keys 表備份列 */
interface BackupSubKeyRow {
  token: string;
  label: string | null;
  daily_limit: number | null;
  allowed_services: string | null;
  allowed_models: string | null;
  rate_limit_per_hour: number | null;
  is_active: number;
  expires_at: string | null;
  created_at: string;
}

/** settings 表備份列 */
interface BackupSettingRow {
  key: string;
  value: string;
}

/** 匯入模式 */
export type ImportMode = 'merge' | 'overwrite';

// ===== 備份匯出 =====

/**
 * 從資料庫收集需要備份的資料
 */
export function collectBackupData(db: ClawDatabase): BackupData {
  // 收集 keys
  const keys = db.query<BackupKeyRow>(
    `SELECT service_id, key_encrypted, pool_type, label, status, priority, pinned, created_at
     FROM keys`
  ).map(row => ({
    ...row,
    // key_encrypted 是 BLOB，轉成 base64 字串以便 JSON 序列化
    key_encrypted: Buffer.from(row.key_encrypted as unknown as Uint8Array).toString('base64'),
  }));

  // 收集 claw_keys
  const claw_keys = db.query<BackupClawKeyRow>(
    `SELECT service_id, key_encrypted, model_id, is_active, daily_limit, created_at
     FROM claw_keys`
  ).map(row => ({
    ...row,
    key_encrypted: Buffer.from(row.key_encrypted as unknown as Uint8Array).toString('base64'),
  }));

  // 收集 sub_keys
  const sub_keys = db.query<BackupSubKeyRow>(
    `SELECT token, label, daily_limit, allowed_services, allowed_models,
            rate_limit_per_hour, is_active, expires_at, created_at
     FROM sub_keys`
  );

  // 收集 settings
  const config = db.query<BackupSettingRow>(
    `SELECT key, value FROM settings`
  );

  return {
    keys,
    claw_keys,
    sub_keys,
    config,
    adapters: [],  // adapter 列表由呼叫者補充
  };
}

/**
 * 加密備份資料並產生 BackupFile
 *
 * 流程：
 * 1. JSON 序列化資料
 * 2. PBKDF2(password, salt, 100K) → AES-256 key
 * 3. AES-256-GCM 加密
 * 4. 回傳 BackupFile 結構
 */
export function encryptBackup(data: BackupData, password: string): BackupFile {
  // 序列化
  const plaintext = JSON.stringify(data);

  // 產生鹽值和 IV
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  // PBKDF2 派生 AES key
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  // AES-256-GCM 加密
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    created_at: new Date().toISOString(),
    engine_version: getEngineVersion(),
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    auth_tag: authTag.toString('hex'),
    encrypted_data: encrypted.toString('base64'),
  };
}

/**
 * 匯出備份到檔案
 */
export function exportBackupToFile(backupFile: BackupFile, filePath: string): void {
  const json = JSON.stringify(backupFile, null, 2);
  writeFileSync(filePath, json, 'utf8');
}

/**
 * 一站式匯出：收集資料 → 加密 → 回傳 BackupFile
 */
export function exportBackup(db: ClawDatabase, password: string): BackupFile {
  const data = collectBackupData(db);
  return encryptBackup(data, password);
}

// ===== 備份匯入 =====

/**
 * 解密備份檔案
 *
 * 流程：
 * 1. 驗證 BackupFile 結構
 * 2. PBKDF2(password, salt) → AES-256 key
 * 3. AES-256-GCM 解密
 * 4. JSON 反序列化 → BackupData
 */
export function decryptBackup(backupFile: BackupFile, password: string): BackupData {
  // 驗證基本結構
  validateBackupFileStructure(backupFile);

  // 還原 hex/base64 為 Buffer
  const salt = Buffer.from(backupFile.salt, 'hex');
  const iv = Buffer.from(backupFile.iv, 'hex');
  const authTag = Buffer.from(backupFile.auth_tag, 'hex');
  const encryptedData = Buffer.from(backupFile.encrypted_data, 'base64');

  // PBKDF2 派生 AES key
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  // AES-256-GCM 解密
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ]);
  } catch {
    throw new Error('備份解密失敗：密碼錯誤或檔案已損壞');
  }

  // JSON 反序列化
  const plaintext = decrypted.toString('utf8');
  let data: BackupData;
  try {
    data = JSON.parse(plaintext) as BackupData;
  } catch {
    throw new Error('備份資料格式錯誤：JSON 解析失敗');
  }

  // 驗證資料完整性
  validateBackupData(data);

  return data;
}

/**
 * 從檔案讀取並解密備份
 */
export function importBackupFromFile(filePath: string, password: string): BackupData {
  // 安全規則：路徑穿越防護 — 只允許 ~/.clawapi/backups/ 和 /tmp/ 目錄
  const resolved = resolve(filePath);
  const homeBackupDir = resolve(homedir(), '.clawapi', 'backups');
  const tmpDir = resolve('/tmp');
  const relHome = relative(homeBackupDir, resolved);
  const relTmp = relative(tmpDir, resolved);
  const isInHomeBackup = !relHome.startsWith('..') && resolve(homeBackupDir, relHome) === resolved;
  const isInTmp = !relTmp.startsWith('..') && resolve(tmpDir, relTmp) === resolved;
  if (!isInHomeBackup && !isInTmp) {
    throw new Error(`路徑受限：備份檔案只允許位於 ${homeBackupDir} 或 /tmp/ 目錄`);
  }

  // 安全規則：先檢查檔案大小，防止大檔 DoS
  const fileSize = statSync(resolved).size;
  if (fileSize > BACKUP_MAX_SIZE_BYTES) {
    throw new Error(`備份檔案過大：${fileSize} bytes（上限 ${BACKUP_MAX_SIZE_BYTES} bytes）`);
  }
  const json = readFileSync(resolved, 'utf8');
  let backupFile: BackupFile;
  try {
    backupFile = JSON.parse(json) as BackupFile;
  } catch {
    throw new Error('備份檔案格式錯誤：JSON 解析失敗');
  }
  return decryptBackup(backupFile, password);
}

/**
 * 將備份資料匯入資料庫
 *
 * @param mode 'merge' = 合併（跳過已存在的），'overwrite' = 覆蓋（清空後匯入）
 */
export function importBackupToDb(
  db: ClawDatabase,
  data: BackupData,
  mode: ImportMode = 'merge'
): { imported: { keys: number; claw_keys: number; sub_keys: number; config: number } } {
  const result = { keys: 0, claw_keys: 0, sub_keys: 0, config: 0 };

  db.transaction(() => {
    if (mode === 'overwrite') {
      // 覆蓋模式：先清空
      db.run('DELETE FROM keys');
      db.run('DELETE FROM claw_keys');
      db.run('DELETE FROM sub_keys');
      db.run('DELETE FROM settings');
    }

    // 匯入 keys
    for (const row of data.keys) {
      try {
        const keyBuf = Buffer.from(row.key_encrypted, 'base64');
        db.run(
          `INSERT INTO keys (service_id, key_encrypted, pool_type, label, status, priority, pinned, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.service_id, keyBuf, row.pool_type, row.label, row.status, row.priority, row.pinned, row.created_at]
        );
        result.keys++;
      } catch {
        // merge 模式下跳過重複
        if (mode === 'overwrite') throw new Error(`匯入 key 失敗：${row.service_id}`);
      }
    }

    // 匯入 claw_keys
    for (const row of data.claw_keys) {
      try {
        const keyBuf = Buffer.from(row.key_encrypted, 'base64');
        db.run(
          `INSERT INTO claw_keys (service_id, key_encrypted, model_id, is_active, daily_limit, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [row.service_id, keyBuf, row.model_id, row.is_active, row.daily_limit, row.created_at]
        );
        result.claw_keys++;
      } catch {
        if (mode === 'overwrite') throw new Error(`匯入 claw_key 失敗：${row.service_id}`);
      }
    }

    // 匯入 sub_keys
    for (const row of data.sub_keys) {
      try {
        db.run(
          `INSERT INTO sub_keys (token, label, daily_limit, allowed_services, allowed_models,
                                  rate_limit_per_hour, is_active, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.token, row.label, row.daily_limit, row.allowed_services, row.allowed_models,
           row.rate_limit_per_hour, row.is_active, row.expires_at, row.created_at]
        );
        result.sub_keys++;
      } catch {
        if (mode === 'overwrite') throw new Error(`匯入 sub_key 失敗：${row.token}`);
      }
    }

    // 匯入 settings
    for (const row of data.config) {
      try {
        db.run(
          `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
          [row.key, row.value]
        );
        result.config++;
      } catch {
        // settings 使用 REPLACE，不應該失敗
      }
    }
  });

  return { imported: result };
}

/**
 * 一站式匯入：解密 → 匯入 DB
 */
export function importBackup(
  db: ClawDatabase,
  backupFile: BackupFile,
  password: string,
  mode: ImportMode = 'merge'
): { imported: { keys: number; claw_keys: number; sub_keys: number; config: number } } {
  const data = decryptBackup(backupFile, password);
  return importBackupToDb(db, data, mode);
}

// ===== 驗證函式 =====

/**
 * 驗證 BackupFile 結構完整性
 */
export function validateBackupFileStructure(backupFile: BackupFile): void {
  if (!backupFile || typeof backupFile !== 'object') {
    throw new Error('備份檔案格式錯誤：不是有效的物件');
  }
  if (backupFile.version !== 1) {
    throw new Error(`備份檔案版本不支援：${backupFile.version}，目前僅支援版本 1`);
  }
  if (!backupFile.salt || typeof backupFile.salt !== 'string') {
    throw new Error('備份檔案格式錯誤：缺少 salt');
  }
  if (!backupFile.iv || typeof backupFile.iv !== 'string') {
    throw new Error('備份檔案格式錯誤：缺少 iv');
  }
  if (!backupFile.auth_tag || typeof backupFile.auth_tag !== 'string') {
    throw new Error('備份檔案格式錯誤：缺少 auth_tag');
  }
  if (!backupFile.encrypted_data || typeof backupFile.encrypted_data !== 'string') {
    throw new Error('備份檔案格式錯誤：缺少 encrypted_data');
  }
}

/**
 * 驗證 BackupData 資料完整性
 */
export function validateBackupData(data: BackupData): void {
  if (!data || typeof data !== 'object') {
    throw new Error('備份資料格式錯誤：不是有效的物件');
  }
  if (!Array.isArray(data.keys)) {
    throw new Error('備份資料格式錯誤：keys 應為陣列');
  }
  if (!Array.isArray(data.claw_keys)) {
    throw new Error('備份資料格式錯誤：claw_keys 應為陣列');
  }
  if (!Array.isArray(data.sub_keys)) {
    throw new Error('備份資料格式錯誤：sub_keys 應為陣列');
  }
  if (!Array.isArray(data.config)) {
    throw new Error('備份資料格式錯誤：config 應為陣列');
  }
}

// ===== 雲端備份（VPS 端 API 客戶端） =====

/** 雲端備份客戶端選項 */
export interface CloudBackupOptions {
  /** VPS 端 base URL */
  baseUrl: string;
  /** 裝置 token */
  deviceToken: string;
  /** Google 認證 token */
  googleToken: string;
}

/**
 * 雲端備份客戶端
 * 與 VPS 端的 /v1/backup 端點互動
 */
export class CloudBackupClient {
  constructor(private options: CloudBackupOptions) {}

  /**
   * 上傳備份到雲端
   * PUT /v1/backup
   */
  async upload(backupFile: BackupFile): Promise<BackupUploadResponse> {
    const body = JSON.stringify(backupFile);
    const checksum = this.computeChecksum(body);

    const response = await fetch(`${this.options.baseUrl}/v1/backup`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.options.deviceToken}`,
        'X-Backup-Version': String(backupFile.version),
        'X-Backup-Checksum': checksum,
        'X-Google-Token': this.options.googleToken,
      } satisfies Record<string, string>,
      body,
    });

    if (!response.ok) {
      throw new Error(`雲端備份上傳失敗：HTTP ${response.status}`);
    }

    return await response.json() as BackupUploadResponse;
  }

  /**
   * 從雲端下載備份
   * GET /v1/backup
   */
  async download(): Promise<BackupFile> {
    const response = await fetch(`${this.options.baseUrl}/v1/backup`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.options.deviceToken}`,
        'X-Google-Token': this.options.googleToken,
      },
    });

    if (!response.ok) {
      throw new Error(`雲端備份下載失敗：HTTP ${response.status}`);
    }

    return await response.json() as BackupFile;
  }

  /**
   * 刪除雲端備份
   * DELETE /v1/backup
   */
  async delete(): Promise<BackupDeleteResponse> {
    const response = await fetch(`${this.options.baseUrl}/v1/backup`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.options.deviceToken}`,
        'X-Google-Token': this.options.googleToken,
      },
    });

    if (!response.ok) {
      throw new Error(`雲端備份刪除失敗：HTTP ${response.status}`);
    }

    return await response.json() as BackupDeleteResponse;
  }

  /**
   * 計算 checksum（SHA-256 hex）
   */
  private computeChecksum(data: string): string {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return createHash('sha256').update(data).digest('hex');
  }
}
