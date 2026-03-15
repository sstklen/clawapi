// VPS ECDH 金鑰對管理模組
// 使用 Web Crypto API (P-256)
// 私鑰只存記憶體，VPS 重啟後重新產生
// 使用 globalThis.crypto（Bun 內建全域 Web Crypto API），避免 node:crypto 型別衝突

import type { VPSDatabase } from '../storage/database';

// Bun 提供全域 crypto，這裡明確取用確保 TypeScript 識別
const webCrypto = globalThis.crypto;

// 金鑰記錄型別（對應 vps_key_history 資料表）
interface KeyRecord {
  key_id: string;
  public_key: string;
  created_at: string;
  retired_at: string | null;
  is_current: number;
}

// 記憶體中的私鑰儲存
interface InMemoryKey {
  keyId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  createdAt: Date;
}

// 金鑰輪換周期（30 天）
const KEY_ROTATION_DAYS = 30;
// 舊金鑰保留期（7 天後刪除）
const KEY_RETENTION_DAYS = 7;

export class VPSKeyManager {
  private db: VPSDatabase;
  // 記憶體中的金鑰池：keyId → 金鑰對
  private keyStore: Map<string, InMemoryKey> = new Map();
  // 當前金鑰 ID
  private currentKeyId: string | null = null;

  constructor(db: VPSDatabase) {
    this.db = db;
  }

  // 初始化：確保有當前金鑰對
  // - 查 vps_key_history 表 is_current=1
  // - 沒有 → 產生新的
  // - 有且未過期 → 產生新的記憶體金鑰對（公鑰已知，私鑰重新產生）
  async init(): Promise<void> {
    const currentRecords = this.db.query<KeyRecord>(
      'SELECT * FROM vps_key_history WHERE is_current = 1 ORDER BY created_at DESC LIMIT 1',
    );

    if (currentRecords.length === 0) {
      // 沒有任何金鑰，產生全新的
      await this.generateKeyPair();
    } else {
      // 有現有金鑰，但私鑰不在記憶體中（VPS 重啟後）
      // 需要產生新的金鑰對，更新 DB 中的公鑰
      await this.generateKeyPair();
    }
  }

  // 產生新金鑰對
  // - ECDH P-256
  // - keyId = 'vps_key_v' + version_number
  // - 舊 key: is_current = 0, retired_at = now
  // - 新 key: is_current = 1
  // - 公鑰以 Base64 存入 DB
  // - 私鑰以 CryptoKey 存入記憶體（不落 DB）
  async generateKeyPair(): Promise<{ keyId: string; publicKey: string }> {
    // 計算下一個版本號
    const versionRecords = this.db.query<{ max_version: number | null }>(
      `SELECT MAX(CAST(SUBSTR(key_id, 10) AS INTEGER)) as max_version
       FROM vps_key_history
       WHERE key_id LIKE 'vps_key_v%'`,
    );
    const maxVersion = versionRecords[0]?.max_version ?? 0;
    const newVersion = maxVersion + 1;
    const keyId = `vps_key_v${newVersion}`;

    // 產生 ECDH P-256 金鑰對
    const keyPair = await webCrypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits'],
    );

    // 匯出公鑰為 Base64（SubjectPublicKeyInfo 格式）
    const publicKeyBuffer = await webCrypto.subtle.exportKey('spki', keyPair.publicKey);
    const publicKeyBase64 = Buffer.from(publicKeyBuffer).toString('base64');

    // 退役舊的當前金鑰
    this.db.run(
      `UPDATE vps_key_history
       SET is_current = 0, retired_at = datetime('now')
       WHERE is_current = 1`,
    );

    // 寫入新金鑰到 DB（只存公鑰）
    this.db.run(
      `INSERT INTO vps_key_history (key_id, public_key, is_current)
       VALUES (?, ?, 1)`,
      [keyId, publicKeyBase64],
    );

    // 存入記憶體
    const memKey: InMemoryKey = {
      keyId,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      createdAt: new Date(),
    };
    this.keyStore.set(keyId, memKey);
    this.currentKeyId = keyId;

    return { keyId, publicKey: publicKeyBase64 };
  }

  // 取得當前公鑰（keyId + Base64 公鑰）
  getCurrentPublicKey(): { keyId: string; publicKey: string } {
    if (!this.currentKeyId) {
      throw new Error('VPSKeyManager 尚未初始化，請先呼叫 init()');
    }

    // 從 DB 取得公鑰（公鑰是持久化的）
    const records = this.db.query<KeyRecord>(
      'SELECT * FROM vps_key_history WHERE key_id = ?',
      [this.currentKeyId],
    );

    if (records.length === 0) {
      throw new Error(`找不到金鑰記錄：${this.currentKeyId}`);
    }

    return {
      keyId: this.currentKeyId,
      publicKey: records[0].public_key,
    };
  }

  // 取得私鑰（記憶體中）
  getCurrentPrivateKey(): CryptoKey {
    if (!this.currentKeyId) {
      throw new Error('VPSKeyManager 尚未初始化，請先呼叫 init()');
    }

    const memKey = this.keyStore.get(this.currentKeyId);
    if (!memKey) {
      throw new Error(`私鑰不在記憶體中：${this.currentKeyId}，VPS 可能已重啟`);
    }

    return memKey.privateKey;
  }

  // 用指定 keyId 的私鑰做 ECDH，導出共享密鑰
  // 若未指定 keyId 則使用當前金鑰
  async deriveSharedSecret(theirPublicKeyBase64: string, keyId?: string): Promise<Uint8Array> {
    const targetKeyId = keyId ?? this.currentKeyId;
    if (!targetKeyId) {
      throw new Error('VPSKeyManager 尚未初始化，請先呼叫 init()');
    }

    const memKey = this.keyStore.get(targetKeyId);
    if (!memKey) {
      throw new Error(`找不到 keyId 的私鑰：${targetKeyId}，金鑰可能已過期或不在記憶體中`);
    }

    // 匯入對方的公鑰
    const theirPublicKeyBuffer = Buffer.from(theirPublicKeyBase64, 'base64');
    const theirPublicKey = await webCrypto.subtle.importKey(
      'spki',
      theirPublicKeyBuffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );

    // 導出 ECDH 共享位元
    const sharedBits = await webCrypto.subtle.deriveBits(
      { name: 'ECDH', public: theirPublicKey },
      memKey.privateKey,
      256,
    );

    return new Uint8Array(sharedBits);
  }

  // 金鑰輪換（30 天）
  // - 當前 key 存在超過 30 天 → 產生新的
  // - 舊的標記 retired_at 但保留 7 天
  // - 回傳 true 如果有輪換
  async rotateIfNeeded(): Promise<boolean> {
    if (!this.currentKeyId) {
      // 尚未初始化，不輪換
      return false;
    }

    const records = this.db.query<KeyRecord>(
      'SELECT * FROM vps_key_history WHERE key_id = ? AND is_current = 1',
      [this.currentKeyId],
    );

    if (records.length === 0) {
      return false;
    }

    const record = records[0];
    const createdAt = new Date(record.created_at);
    const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceCreation >= KEY_ROTATION_DAYS) {
      // 超過 30 天，觸發輪換
      await this.generateKeyPair();
      return true;
    }

    return false;
  }

  // 清理過期金鑰（retired 超過 7 天的舊 key）
  async cleanupExpired(): Promise<number> {
    const result = this.db.run(
      `DELETE FROM vps_key_history
       WHERE is_current = 0
         AND retired_at IS NOT NULL
         AND datetime(retired_at, '+${KEY_RETENTION_DAYS} days') < datetime('now')`,
    );

    // 同步清理記憶體中的舊金鑰
    for (const [keyId, memKey] of this.keyStore.entries()) {
      if (keyId === this.currentKeyId) continue;
      const daysSinceCreation = (Date.now() - memKey.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceCreation >= KEY_RETENTION_DAYS) {
        this.keyStore.delete(keyId);
      }
    }

    return result.changes;
  }
}
