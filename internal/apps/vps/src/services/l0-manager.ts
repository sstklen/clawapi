// L0 公共 Key 管理服務
// 負責 L0 Key 的加解密、捐贈、用量追蹤、健康監控
// 所有 Key 密文存 DB，明文永不落 log

import type { VPSDatabase } from '../storage/database';
import type { VPSKeyManager } from '../core/ecdh';

// Bun 全域 Web Crypto API（避免 node:crypto 型別衝突）
const webCrypto = globalThis.crypto;

// 確保 Uint8Array 的 buffer 是 ArrayBuffer（非 SharedArrayBuffer）
// Web Crypto API 要求 BufferSource 的底層必須是 ArrayBuffer
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

// L0 Key 在 DB 中的原始型別
export interface L0KeyRecord {
  id: string;
  service_id: string;
  key_value_encrypted: Uint8Array | null;
  key_hash: string | null;
  encryption_key_id: string | null;
  status: 'active' | 'degraded' | 'dead';
  daily_quota: number | null;
  daily_used: number;
  daily_reset_at: string | null;
  donated_by_device_id: string | null;
  donated_by_display: string | null;
  is_anonymous_donation: number;
  last_health_check: string | null;
  created_at: string;
  updated_at: string;
}

// L0 裝置每日用量記錄
export interface L0DeviceUsageRecord {
  device_id: string;
  service_id: string;
  date: string;
  used_count: number;
  daily_limit: number;
}

// AES-256-GCM 加密結果（存 DB 用）
export interface EncryptedL0Key {
  ciphertext: Uint8Array;  // 密文
  iv: Uint8Array;          // 12 bytes 隨機向量
  tag: Uint8Array;         // 16 bytes 驗證標籤
}

// 捐贈請求 body
export interface DonateBody {
  service_id: string;
  encrypted_key: string;      // Base64 密文（客戶端用 VPS 公鑰 ECIES 加密）
  ephemeral_public_key: string; // Base64 臨時公鑰（SPKI 格式）
  iv: string;                 // Base64 AES-GCM IV（客戶端用）
  tag: string;                // Base64 AES-GCM tag（客戶端用）
  display_name?: string;
  anonymous?: boolean;
}

// 用量回報條目
export interface UsageEntry {
  l0_key_id: string;
  service_id: string;
  timestamp: string;
  tokens_used?: number;
  success: boolean;
}

// 捐贈結果
export interface DonateResult {
  accepted: boolean;
  l0_key_id: string;
  message: string;
  validation: {
    key_valid: boolean;
    service_confirmed: string;
    estimated_daily_quota: number;
  };
}

// 健康監控結果
export interface HealthCheckResult {
  checked: number;   // 檢查了幾個 key
  updated: number;   // 狀態有變更的數量
  warnings: number;  // 額度警告數量
}

// Key 下發用的加密包（給客戶端）
export interface L0KeyDownloadPackage {
  id: string;
  service_id: string;
  key_encrypted: string | null;     // Base64（用 L0 master key 加密後再給客戶端）
  encryption_method: 'aes-256-gcm' | null;
  encryption_key_id: string | null;
  status: 'active' | 'degraded' | 'dead';
  daily_quota_per_device: number | null;
  total_daily_quota: number | null;
  total_daily_used: number | null;
  donated_by: string | null;
  updated_at: string;
}

// 每日捐贈次數限制（每裝置每天最多 5 次）
const DONATE_RATE_LIMIT_PER_DAY = 5;

// 活躍裝置判定：最近 7 天有 last_seen_at
const ACTIVE_DEVICE_DAYS = 7;

// 額度警告門檻（80%）
const QUOTA_WARNING_THRESHOLD = 0.8;

// 健康監控間隔（5 分鐘，毫秒）
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ===== Mock 驗證函式（日後替換為真實 API 呼叫）=====

// 模擬驗證 API Key 有效性
// 真實版本要呼叫對應服務的驗證端點
async function validateApiKey(
  _serviceId: string,
  _plainKey: string,
): Promise<{ valid: boolean; estimatedDailyQuota: number }> {
  // MVP：假設所有 key 都有效，每日 1000 配額
  return { valid: true, estimatedDailyQuota: 1000 };
}

// 模擬測試 Key 連線狀態
// 真實版本要對服務發一個最小 API 請求
async function testKey(
  _serviceId: string,
  _plainKey: string,
): Promise<'active' | 'degraded' | 'dead'> {
  // MVP：假設 key 都正常
  return 'active';
}

// ===== L0Manager 主類別 =====

export class L0Manager {
  private db: VPSDatabase;
  private ecdhManager: VPSKeyManager;

  // L0 Master Key（AES-256-GCM，32 bytes 隨機，只存記憶體）
  // VPS 重啟後重新產生，已存 DB 的密文就無法再解（需重新捐贈）
  // 未來可改成 KMS 或 HSM
  private masterKey: CryptoKey | null = null;

  // 健康監控定時器
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: VPSDatabase, ecdhManager: VPSKeyManager) {
    this.db = db;
    this.ecdhManager = ecdhManager;
  }

  // 初始化：產生 L0 Master Key
  async init(): Promise<void> {
    // 產生 32 bytes 隨機 master key
    const rawKey = new Uint8Array(32);
    webCrypto.getRandomValues(rawKey);

    // 匯入為 AES-256-GCM CryptoKey
    this.masterKey = await webCrypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,            // 不可匯出（只在記憶體）
      ['encrypt', 'decrypt'],
    );
  }

  // 啟動健康監控定時器（每 5 分鐘自動執行一次）
  startHealthCheck(): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(async () => {
      await this.checkHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  // 停止健康監控
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ===== 公開 API =====

  // 取得 L0 Key 列表
  // since: ISO 8601 時間字串，只回傳 updated_at > since 的
  // 無 since → 回全部 active/degraded key
  // 有 since 但無新 key → 回 null（handler 轉 304）
  getKeys(since?: string): L0KeyRecord[] | null {
    let records: L0KeyRecord[];

    if (since) {
      // 只取 updated_at > since 的
      records = this.db.query<L0KeyRecord>(
        `SELECT * FROM l0_keys
         WHERE updated_at > ?
           AND status IN ('active', 'degraded')
         ORDER BY updated_at ASC`,
        [since],
      );

      // 沒有新的 → 回 null，讓 handler 轉 304
      if (records.length === 0) return null;
    } else {
      // 全部 active/degraded key
      records = this.db.query<L0KeyRecord>(
        `SELECT * FROM l0_keys
         WHERE status IN ('active', 'degraded')
         ORDER BY created_at ASC`,
      );
    }

    return records;
  }

  // 計算指定裝置的每日限額
  // 公式：Math.max(5, Math.min(100, Math.floor(daily_quota / active_devices)))
  // active_devices = 最近 7 天有 last_seen_at 的設備數（至少 1）
  getDeviceLimits(deviceId: string): Record<string, number> {
    // 取所有 active key 及其 daily_quota
    const keys = this.db.query<{ id: string; service_id: string; daily_quota: number | null }>(
      `SELECT id, service_id, daily_quota FROM l0_keys
       WHERE status IN ('active', 'degraded')`,
    );

    if (keys.length === 0) return {};

    // 計算活躍裝置數
    const activeDevicesResult = this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM devices
       WHERE last_seen_at > datetime('now', '-${ACTIVE_DEVICE_DAYS} days')
         AND status = 'active'`,
    );
    const activeDevices = Math.max(1, activeDevicesResult[0]?.count ?? 1);

    // 依 service_id 聚合計算（每個 service 可能有多個 key，取最大 quota）
    const serviceQuotaMap = new Map<string, number>();
    for (const key of keys) {
      if (key.daily_quota === null) continue;
      const quota = Math.max(5, Math.min(100, Math.floor(key.daily_quota / activeDevices)));
      const existing = serviceQuotaMap.get(key.service_id) ?? 0;
      serviceQuotaMap.set(key.service_id, Math.max(existing, quota));
    }

    // 組裝結果（用量在 handler 層另外查，這裡只回限額）
    const result: Record<string, number> = {};
    for (const [serviceId, limit] of serviceQuotaMap.entries()) {
      result[serviceId] = limit;
    }

    return result;
  }

  // 捐贈 Key 流程
  // 1. ECIES 解密：ECDH + HKDF + AES-256-GCM
  // 2. 驗 Key 有效性
  // 3. 去重（SHA-256 hash）
  // 4. AES-256-GCM 加密存 DB
  // 回傳 DonateResult 或拋出帶 errorCode 的 Error
  async handleDonate(deviceId: string, body: DonateBody): Promise<DonateResult> {
    const {
      service_id,
      encrypted_key,
      ephemeral_public_key,
      iv: clientIvBase64,
      tag: clientTagBase64,
      display_name,
      anonymous,
    } = body;

    // ===== 速率限制：每裝置每天最多 5 次捐贈 =====
    const today = new Date().toISOString().slice(0, 10);
    const donateCountResult = this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM l0_keys
       WHERE donated_by_device_id = ?
         AND date(created_at) = ?`,
      [deviceId, today],
    );
    const todayDonateCount = donateCountResult[0]?.count ?? 0;

    if (todayDonateCount >= DONATE_RATE_LIMIT_PER_DAY) {
      const err = new Error('捐贈次數已達今日上限');
      (err as Error & { errorCode: string }).errorCode = 'L0_DONATE_RATE_LIMITED';
      throw err;
    }

    // ===== ECIES 解密 =====
    // 步驟：ECDH(vps_private, ephemeral_public) → shared_secret
    //       → HKDF-SHA256 → AES key → AES-256-GCM 解密
    let plainKey: string;
    try {
      plainKey = await this.eciesDecrypt(
        ephemeral_public_key,
        encrypted_key,
        clientIvBase64,
        clientTagBase64,
      );
    } catch {
      const err = new Error('ECIES 解密失敗，請確認加密參數正確');
      (err as Error & { errorCode: string }).errorCode = 'L0_DONATE_INVALID_KEY';
      throw err;
    }

    // ===== 驗 Key 有效性 =====
    const validation = await validateApiKey(service_id, plainKey);
    if (!validation.valid) {
      const err = new Error('API Key 驗證失敗，此 Key 無效');
      (err as Error & { errorCode: string }).errorCode = 'L0_DONATE_INVALID_KEY';
      throw err;
    }

    // ===== 去重：對 plainKey 做 SHA-256 =====
    const keyHashBuffer = await webCrypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(plainKey),
    );
    const keyHash = Buffer.from(keyHashBuffer).toString('hex');

    // 查 DB 是否已有相同 hash
    const existing = this.db.query<{ id: string }>(
      'SELECT id FROM l0_keys WHERE key_hash = ?',
      [keyHash],
    );
    if (existing.length > 0) {
      const err = new Error('此 Key 已存在，不重複捐贈');
      (err as Error & { errorCode: string }).errorCode = 'L0_DONATE_DUPLICATE';
      throw err;
    }

    // ===== 用 L0 Master Key 加密存 DB =====
    const { ciphertext, iv, tag } = await this.encryptL0Key(plainKey);

    // BLOB 格式：IV(12 bytes) || ciphertext || tag(16 bytes)
    // 一次組裝正確格式，避免雙重寫入
    const fullBlob = new Uint8Array(iv.length + ciphertext.length + tag.length);
    fullBlob.set(iv, 0);
    fullBlob.set(ciphertext, iv.length);
    fullBlob.set(tag, iv.length + ciphertext.length);

    // 產生唯一 ID
    const l0KeyId = `l0_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // 決定顯示名稱
    const displayName = anonymous
      ? null
      : (display_name ?? `device_${deviceId.slice(-8)}`);

    // 一次寫入 DB（正確的 BLOB 格式）
    this.db.run(
      `INSERT INTO l0_keys (
        id, service_id, key_value_encrypted, key_hash,
        encryption_key_id, status, daily_quota, daily_used,
        daily_reset_at, donated_by_device_id, donated_by_display,
        is_anonymous_donation, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        'l0_master_v1', 'active', ?, 0,
        date('now', '+1 day'), ?, ?,
        ?, datetime('now'), datetime('now')
      )`,
      [
        l0KeyId,
        service_id,
        fullBlob,
        keyHash,
        validation.estimatedDailyQuota,
        deviceId,
        displayName,
        anonymous ? 1 : 0,
      ],
    );

    return {
      accepted: true,
      l0_key_id: l0KeyId,
      message: '感謝捐贈！您的 Key 已加入公共池',
      validation: {
        key_valid: true,
        service_confirmed: service_id,
        estimated_daily_quota: validation.estimatedDailyQuota,
      },
    };
  }

  // 用量回報：更新 l0_device_usage 表 + l0_keys.daily_used
  async reportUsage(deviceId: string, entries: UsageEntry[]): Promise<{ updated: number }> {
    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;

    for (const entry of entries) {
      // 更新裝置每日用量（UPSERT）
      const defaultLimit = 10; // 預設限額（應由 getDeviceLimits 取得，這裡用預設值）
      this.db.run(
        `INSERT INTO l0_device_usage (device_id, service_id, date, used_count, daily_limit)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (device_id, service_id, date)
         DO UPDATE SET used_count = used_count + 1`,
        [deviceId, entry.service_id, today, defaultLimit],
      );

      // 更新 l0_keys.daily_used（只計算成功的）
      if (entry.success) {
        this.db.run(
          `UPDATE l0_keys
           SET daily_used = daily_used + 1,
               updated_at = datetime('now')
           WHERE id = ?`,
          [entry.l0_key_id],
        );
      }

      updated++;
    }

    return { updated };
  }

  // 健康監控（每 5 分鐘）
  // - 跳過 key_value_encrypted IS NULL 的 key（無法測試）
  // - Mock testKey → 更新 status
  // - 額度 > 80% → 記 warning log
  async checkHealth(): Promise<HealthCheckResult> {
    const result: HealthCheckResult = { checked: 0, updated: 0, warnings: 0 };

    // 取所有需要檢查的 key（非 dead，有密文）
    const keys = this.db.query<L0KeyRecord>(
      `SELECT * FROM l0_keys
       WHERE key_value_encrypted IS NOT NULL
         AND status != 'dead'`,
    );

    for (const key of keys) {
      result.checked++;

      // 解密取 plainKey（用 master key）
      let plainKey: string;
      try {
        const blob = key.key_value_encrypted!;
        const blobBytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob as unknown as ArrayBuffer);
        const iv = blobBytes.slice(0, 12);
        const body = blobBytes.slice(12, blobBytes.length - 16);
        const tag = blobBytes.slice(blobBytes.length - 16);
        plainKey = await this.decryptL0Key(body, iv, tag);
      } catch {
        // 解密失敗（master key 已換，key 無法使用）→ 標記 dead
        this.db.run(
          `UPDATE l0_keys SET status = 'dead', updated_at = datetime('now') WHERE id = ?`,
          [key.id],
        );
        result.updated++;
        continue;
      }

      // 測試 key 狀態
      const newStatus = await testKey(key.service_id, plainKey);

      // 更新 last_health_check 和 status（如有變化）
      if (newStatus !== key.status) {
        this.db.run(
          `UPDATE l0_keys
           SET status = ?, last_health_check = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
          [newStatus, key.id],
        );
        result.updated++;
      } else {
        this.db.run(
          `UPDATE l0_keys SET last_health_check = datetime('now') WHERE id = ?`,
          [key.id],
        );
      }

      // 額度警告：daily_used / daily_quota > 80%
      if (
        key.daily_quota !== null &&
        key.daily_quota > 0 &&
        key.daily_used / key.daily_quota > QUOTA_WARNING_THRESHOLD
      ) {
        console.warn(
          `[L0 警告] key ${key.id} (${key.service_id}) 額度已用 ${key.daily_used}/${key.daily_quota}（> 80%）`,
        );
        result.warnings++;
      }
    }

    return result;
  }

  // ===== 加解密工具 =====

  // AES-256-GCM 加密（用 L0 Master Key）
  // 回傳：{ ciphertext, iv(12 bytes), tag(16 bytes) }
  async encryptL0Key(plainKey: string): Promise<EncryptedL0Key> {
    if (!this.masterKey) {
      throw new Error('L0Manager 尚未初始化，請先呼叫 init()');
    }

    // 產生隨機 12 bytes IV
    const iv = new Uint8Array(12);
    webCrypto.getRandomValues(iv);

    const plainBytes = new TextEncoder().encode(plainKey);

    // AES-256-GCM 加密（AES-GCM 的 tag 會 concat 在密文末尾）
    const encryptedBuffer = await webCrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      this.masterKey,
      plainBytes,
    );

    // Web Crypto API：AES-GCM 的輸出 = ciphertext || tag（tag 在最後 16 bytes）
    const encryptedBytes = new Uint8Array(encryptedBuffer);
    const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
    const tag = encryptedBytes.slice(encryptedBytes.length - 16);

    return { ciphertext, iv, tag };
  }

  // AES-256-GCM 解密（用 L0 Master Key）
  // encrypted: 密文（不含 tag）
  // iv: 12 bytes IV
  // tag: 16 bytes 驗證標籤
  async decryptL0Key(encrypted: Uint8Array, iv: Uint8Array, tag: Uint8Array): Promise<string> {
    if (!this.masterKey) {
      throw new Error('L0Manager 尚未初始化，請先呼叫 init()');
    }

    // 重新組合：Web Crypto API 期望 ciphertext || tag
    const combined = new Uint8Array(encrypted.length + tag.length);
    combined.set(encrypted, 0);
    combined.set(tag, encrypted.length);

    const decryptedBuffer = await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: 128 },
      this.masterKey,
      toArrayBuffer(combined),
    );

    return new TextDecoder().decode(decryptedBuffer);
  }

  // 為下發準備加密包（給客戶端的資料格式）
  // 注意：根據 SPEC-C §4.3，key 密文用 L0 master key 的 Base64 下發
  // 客戶端無法直接解密（需要 VPS 配合），MVP 版本直接帶密文
  prepareForDownload(record: L0KeyRecord): L0KeyDownloadPackage {
    // 從 BLOB 取 IV + 密文 + tag，重新 Base64 編碼給客戶端
    let keyEncrypted: string | null = null;
    if (record.key_value_encrypted) {
      const blobBytes = record.key_value_encrypted instanceof Uint8Array
        ? record.key_value_encrypted
        : new Uint8Array(record.key_value_encrypted as unknown as ArrayBuffer);
      keyEncrypted = Buffer.from(blobBytes).toString('base64');
    }

    return {
      id: record.id,
      service_id: record.service_id,
      key_encrypted: keyEncrypted,
      encryption_method: keyEncrypted ? 'aes-256-gcm' : null,
      encryption_key_id: record.encryption_key_id,
      status: record.status,
      daily_quota_per_device: null, // 由 getDeviceLimits 計算後填入
      total_daily_quota: record.daily_quota,
      total_daily_used: record.daily_used,
      donated_by: record.is_anonymous_donation ? null : (record.donated_by_display ?? null),
      updated_at: record.updated_at,
    };
  }

  // ===== 私有工具 =====

  // ECIES 解密
  // 流程：ECDH(vps_private, ephemeral_public) → shared_secret
  //       → HKDF-SHA256(salt="clawapi-l0-donate", info="clawapi-l0-v1", length=32)
  //       → AES-256-GCM 解密
  private async eciesDecrypt(
    ephemeralPublicKeyBase64: string,
    encryptedKeyBase64: string,
    ivBase64: string,
    tagBase64: string,
  ): Promise<string> {
    // 1. ECDH：VPS 私鑰 × 客戶端臨時公鑰 → shared_secret
    const sharedSecret = await this.ecdhManager.deriveSharedSecret(ephemeralPublicKeyBase64);

    // 2. HKDF-SHA256：shared_secret → 32 bytes AES key
    const keyMaterial = await webCrypto.subtle.importKey(
      'raw',
      toArrayBuffer(sharedSecret),
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

    // 3. 匯入 AES key
    const aesKey = await webCrypto.subtle.importKey(
      'raw',
      aesKeyBits,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );

    // 4. AES-256-GCM 解密（重組 ciphertext || tag）
    const iv = Buffer.from(ivBase64, 'base64');
    const encryptedBytes = Buffer.from(encryptedKeyBase64, 'base64');
    const tag = Buffer.from(tagBase64, 'base64');

    const combined = new Uint8Array(encryptedBytes.length + tag.length);
    combined.set(encryptedBytes, 0);
    combined.set(tag, encryptedBytes.length);

    const decryptedBuffer = await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      combined,
    );

    return new TextDecoder().decode(decryptedBuffer);
  }
}
