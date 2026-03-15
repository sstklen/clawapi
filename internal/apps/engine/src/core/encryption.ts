// Crypto 模組
// 負責 Master Key 管理、AES-256-GCM 加解密、ECDH、互助加密、備份加密、Key 遮罩

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  createHash,
  createHmac,
} from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

// ===== 常數 =====

/** AES-256-GCM：IV 長度 12 bytes */
const IV_LENGTH = 12;
/** AES-256-GCM：AuthTag 長度 16 bytes */
const AUTH_TAG_LENGTH = 16;
/** Master Key 長度 32 bytes（256 bits） */
const MASTER_KEY_LENGTH = 32;
/** 備份加密 PBKDF2 迭代次數 */
const PBKDF2_ITERATIONS = 100_000;
/** PBKDF2 鹽值長度 */
const PBKDF2_SALT_LENGTH = 16;

// ===== 型別定義 =====

export interface ECDHKeyPair {
  /** Base64 編碼的公鑰 */
  publicKey: string;
  /** Base64 編碼的私鑰 */
  privateKey: string;
}

// ===== Crypto 模組類別 =====

export class CryptoModule {
  /** 記憶體中的 Master Key */
  private masterKey: Uint8Array | null = null;
  /** Master Key 檔案路徑 */
  private masterKeyPath: string;

  constructor(dataDir?: string) {
    const baseDir = dataDir ?? join(homedir(), '.clawapi');
    this.masterKeyPath = join(baseDir, 'master.key');
  }

  // ===== Master Key 管理 =====

  /**
   * 初始化 Master Key
   * 首次啟動：產生隨機 32 bytes → 存入 ~/.clawapi/master.key（權限 0600）
   * 後續啟動：讀取現有 master.key
   */
  async initMasterKey(dataDir?: string): Promise<void> {
    // 若有額外傳入路徑，更新 masterKeyPath
    if (dataDir) {
      this.masterKeyPath = join(dataDir, 'master.key');
    }

    // 確保目錄存在
    const dir = join(this.masterKeyPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(this.masterKeyPath)) {
      // 讀取現有 master.key
      const buf = readFileSync(this.masterKeyPath);
      if (buf.length !== MASTER_KEY_LENGTH) {
        throw new Error(`master.key 長度錯誤：期望 ${MASTER_KEY_LENGTH} bytes，實際 ${buf.length} bytes`);
      }
      this.masterKey = new Uint8Array(buf);
    } else {
      // 首次啟動：產生隨機 32 bytes
      const key = randomBytes(MASTER_KEY_LENGTH);
      writeFileSync(this.masterKeyPath, key, { mode: 0o600 });
      // 確保權限正確（某些系統可能需要明確設定）
      try {
        chmodSync(this.masterKeyPath, 0o600);
      } catch {
        // 非 POSIX 系統忽略
      }
      this.masterKey = new Uint8Array(key);
    }
  }

  /**
   * 從記憶體取 Master Key（不重複讀檔）
   */
  getMasterKey(): Uint8Array {
    if (!this.masterKey) {
      throw new Error('Master Key 尚未初始化，請先呼叫 initMasterKey()');
    }
    return this.masterKey;
  }

  // ===== AES-256-GCM 加解密 =====

  /**
   * 用 Master Key 加密
   * 回傳格式：[IV(12 bytes) | AuthTag(16 bytes) | CipherText]
   */
  encrypt(plaintext: string): Uint8Array {
    const key = this.getMasterKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // 組合：IV + AuthTag + CipherText
    const result = Buffer.concat([iv, authTag, encrypted]);
    return new Uint8Array(result);
  }

  /**
   * 用 Master Key 解密
   * 輸入格式：[IV(12 bytes) | AuthTag(16 bytes) | CipherText]
   */
  decrypt(ciphertext: Uint8Array): string {
    const key = this.getMasterKey();
    const buf = Buffer.from(ciphertext);

    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('密文長度不足');
    }

    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  // ===== ECDH P-256 =====

  /**
   * 產生 ECDH P-256 金鑰對
   * 回傳 Base64 編碼的公鑰和私鑰
   */
  async generateECDHKeyPair(): Promise<ECDHKeyPair> {
    const keyPair = await webcrypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true, // 可匯出
      ['deriveKey', 'deriveBits']
    );

    const publicKeyBuf = await webcrypto.subtle.exportKey('raw', keyPair.publicKey);
    const privateKeyBuf = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    return {
      publicKey: Buffer.from(publicKeyBuf).toString('base64'),
      privateKey: Buffer.from(privateKeyBuf).toString('base64'),
    };
  }

  /**
   * ECDH 導出共享密鑰
   * 輸入：我方私鑰（Base64 PKCS8）、對方公鑰（Base64 raw）
   * 輸出：32 bytes 共享密鑰
   */
  async deriveSharedSecret(
    myPrivateKey: string,
    theirPublicKey: string
  ): Promise<Uint8Array> {
    const privateKeyBuf = Buffer.from(myPrivateKey, 'base64');
    const publicKeyBuf = Buffer.from(theirPublicKey, 'base64');

    const privateKey = await webcrypto.subtle.importKey(
      'pkcs8',
      privateKeyBuf,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    );

    const publicKey = await webcrypto.subtle.importKey(
      'raw',
      publicKeyBuf,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const bits = await webcrypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256 // 32 bytes
    );

    return new Uint8Array(bits);
  }

  // ===== 互助加密 =====

  /**
   * 互助加密
   * 流程：
   * 1. ECDH(myPrivateKey, recipientPublicKey) → sharedSecret
   * 2. HKDF(sharedSecret, salt=aid_id, info="clawapi-aid-v1") → aesKey（32 bytes）
   * 3. AES-256-GCM(aesKey, randomIV) 加密 data
   * 4. 回傳 Base64(IV(12) + AuthTag(16) + CipherText)
   */
  /**
   * 互助加密（SPEC-A §6 介面）
   * 此方法需要內部取得當前 ECDH 私鑰（從 DB），
   * 將在 AidManager 模組整合時實作。
   * 目前請使用 encryptForAidWithKey() 並明確傳入私鑰。
   */
  async encryptForAid(
    _data: string,
    _recipientPublicKey: string,
    _aid_id: string
  ): Promise<{ encrypted: string }> {
    throw new Error(
      '尚未實作：encryptForAid() 需要 AidManager 整合才能自動取得 ECDH 私鑰。' +
      '請使用 encryptForAidWithKey() 並明確傳入 myPrivateKey。'
    );
  }

  /**
   * 互助加密（完整版，需要傳入我方私鑰）
   */
  async encryptForAidWithKey(
    data: string,
    myPrivateKey: string,
    recipientPublicKey: string,
    aid_id: string
  ): Promise<{ encrypted: string }> {
    const sharedSecret = await this.deriveSharedSecret(myPrivateKey, recipientPublicKey);
    const aesKey = await this.hkdf(sharedSecret, aid_id, 'clawapi-aid-v1', 32);

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const combined = Buffer.concat([iv, authTag, encrypted]);
    return { encrypted: combined.toString('base64') };
  }

  /**
   * 互助解密（完整版，需要傳入我方私鑰）
   * 流程：
   * 1. ECDH(myPrivateKey, senderPublicKey) → sharedSecret
   * 2. HKDF(sharedSecret, salt=aid_id, info="clawapi-aid-v1") → aesKey
   * 3. 從 encryptedData 拆出 IV + AuthTag + CipherText
   * 4. AES-256-GCM 解密 → 回傳明文
   */
  async decryptFromAidWithKey(
    encryptedData: string,
    myPrivateKey: string,
    senderPublicKey: string,
    aid_id: string
  ): Promise<string> {
    const sharedSecret = await this.deriveSharedSecret(myPrivateKey, senderPublicKey);
    const aesKey = await this.hkdf(sharedSecret, aid_id, 'clawapi-aid-v1', 32);

    const combined = Buffer.from(encryptedData, 'base64');
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('互助密文長度不足');
    }

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }

  /**
   * 互助解密（SPEC-A §6 介面）
   * 此方法需要內部取得當前 ECDH 私鑰（從 DB），
   * 將在 AidManager 模組整合時實作。
   * 目前請使用 decryptFromAidWithKey() 並明確傳入私鑰。
   */
  async decryptFromAid(
    _encryptedData: string,
    _senderPublicKey: string,
    _aid_id: string
  ): Promise<string> {
    throw new Error(
      '尚未實作：decryptFromAid() 需要 AidManager 整合才能自動取得 ECDH 私鑰。' +
      '請使用 decryptFromAidWithKey() 並明確傳入 myPrivateKey。'
    );
  }

  // ===== 備份加密 =====

  /**
   * 備份加密
   * PBKDF2(password, randomSalt, 100K iterations, SHA-256) → AES-256-GCM
   * 回傳格式：[Salt(16) | IV(12) | AuthTag(16) | CipherText]
   */
  encryptForBackup(data: string, password: string): Uint8Array {
    const salt = randomBytes(PBKDF2_SALT_LENGTH);
    // 使用同步呼叫（備份操作不頻繁，可接受）
    // Node.js crypto 的 pbkdf2Sync 是同步版本
    const { pbkdf2Sync } = require('node:crypto') as typeof import('node:crypto');
    const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const result = Buffer.concat([salt, iv, authTag, encrypted]);
    return new Uint8Array(result);
  }

  /**
   * 備份解密
   * 輸入格式：[Salt(16) | IV(12) | AuthTag(16) | CipherText]
   */
  decryptFromBackup(encrypted: Uint8Array, password: string): string {
    const buf = Buffer.from(encrypted);
    const minLength = PBKDF2_SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
    if (buf.length < minLength) {
      throw new Error('備份密文長度不足');
    }

    const salt = buf.subarray(0, PBKDF2_SALT_LENGTH);
    const iv = buf.subarray(PBKDF2_SALT_LENGTH, PBKDF2_SALT_LENGTH + IV_LENGTH);
    const authTag = buf.subarray(
      PBKDF2_SALT_LENGTH + IV_LENGTH,
      PBKDF2_SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
    );
    const ciphertext = buf.subarray(PBKDF2_SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

    const { pbkdf2Sync } = require('node:crypto') as typeof import('node:crypto');
    const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }

  // ===== Key 遮罩 =====

  /**
   * Key 遮罩（#150）
   * 例：'gsk_1234567890abcdef' → 'gsk_****cdef'
   * 規則：顯示前 4 + 後 4，中間替換為 ****
   * 注意：前 4 字元可能包含前綴（如 'gsk_'），維持原始前 4 字元
   */
  maskKey(keyValue: string): string {
    if (keyValue.length <= 8) {
      // 太短就全部遮罩
      return '****';
    }
    const prefix = keyValue.slice(0, 4);
    const suffix = keyValue.slice(-4);
    return `${prefix}****${suffix}`;
  }

  // ===== HKDF（輔助方法） =====

  /**
   * HKDF-SHA256
   * salt：字串（會轉成 UTF-8 bytes）
   * info：context 字串
   * length：輸出長度（bytes）
   */
  async hkdf(
    inputKey: Uint8Array,
    salt: string,
    info: string,
    length: number
  ): Promise<Uint8Array> {
    const saltBytes = Buffer.from(salt, 'utf8');
    const infoBytes = Buffer.from(info, 'utf8');

    // HKDF-Extract
    const prk = createHmac('sha256', saltBytes)
      .update(inputKey)
      .digest();

    // HKDF-Expand
    const n = Math.ceil(length / 32); // SHA-256 輸出 32 bytes
    const okm = Buffer.alloc(n * 32);
    let prev = Buffer.alloc(0);

    for (let i = 0; i < n; i++) {
      const hmac = createHmac('sha256', prk);
      hmac.update(prev);
      hmac.update(infoBytes);
      hmac.update(Buffer.from([i + 1]));
      prev = hmac.digest();
      prev.copy(okm, i * 32);
    }

    return new Uint8Array(okm.subarray(0, length));
  }
}

// ===== 模組導出 =====

/** 全域單例 */
let _instance: CryptoModule | null = null;

export function getCrypto(dataDir?: string): CryptoModule {
  if (!_instance) {
    _instance = new CryptoModule(dataDir);
  }
  return _instance;
}

export function createCrypto(dataDir?: string): CryptoModule {
  return new CryptoModule(dataDir);
}

export default getCrypto;
