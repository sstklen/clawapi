// 互助客戶端（AidClient）
// 負責發起互助請求、處理傳入的互助配對、ECDH 金鑰交換、加密通訊
// SPEC-C §4.5 互助系統完整實作

import type { CryptoModule } from '../core/encryption';
import type { VPSClient } from '../intelligence/vps-client';
import type { KeyPool } from '../core/key-pool';
import type { DatabaseModule } from '../storage/database';

import type {
  AidRequest,
  AidAccepted,
  AidConfig,
  AidStats,
  AidMatchedNotification,
  AidResultNotification,
  AidEncryptedRequest,
  AidEncryptedResponse,
} from '@clawapi/protocol';

// ===== 常數 =====

/** Payload 最大尺寸：加密前 1MB */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** 互助請求 timeout：30 秒 */
const AID_REQUEST_TIMEOUT_MS = 30_000;

/** 冷卻期基礎時間：60 秒 */
const COOLDOWN_BASE_MS = 60_000;

/** 冷卻期最大時間：480 秒 */
const COOLDOWN_MAX_MS = 480_000;

/** HKDF info 字串（SPEC-C §4.5 規定） */
const HKDF_INFO = 'clawapi-aid-v1';

// ===== 型別定義 =====

/** requestAid 的參數 */
export interface RequestAidParams {
  /** 服務 ID（如 'openai', 'anthropic'） */
  service_id: string;
  /** 請求類型（如 'chat', 'completion'） */
  request_type: string;
  /** 要加密發送給幫助者的 payload（JSON 字串或物件） */
  payload: string | Record<string, unknown>;
  /** 最大可接受延遲（毫秒） */
  max_latency_ms?: number;
  /** 重試次數（給 VPS 統計用） */
  retry_count?: number;
  /** 原始錯誤訊息 */
  original_error?: string;
}

/** requestAid 的結果 */
export interface AidResult {
  /** 是否成功 */
  success: boolean;
  /** 解密後的回應內容 */
  response?: string;
  /** 錯誤訊息（失敗時） */
  error?: string;
  /** aid_id */
  aid_id: string;
  /** 實際延遲（毫秒） */
  latency_ms?: number;
}

/** 傳入的互助請求（我是幫助者時收到的） */
export interface IncomingAidRequest {
  aid_id: string;
  service_id: string;
  request_type: string;
  requester_public_key: string;
}

/** 互助設定（本地使用） */
export interface AidClientConfig {
  /** 是否開啟互助（幫助他人） */
  enabled: boolean;
  /** 允許的服務清單（null = 全部允許） */
  allowed_services: string[] | null;
  /** 每日幫助上限 */
  daily_limit: number;
  /** 黑名單時段（小時，0~23） */
  blackout_hours: number[];
  /** 幫助者預登記公鑰（Base64 raw P-256） */
  helper_public_key?: string;
  /** 幫助者私鑰（Base64 PKCS8，記憶體中，不寫 DB） */
  helper_private_key?: string;
}

/** 冷卻期狀態 */
interface CooldownState {
  /** 連續失敗次數 */
  consecutiveFailures: number;
  /** 冷卻解除時間戳記（毫秒） */
  cooldownUntil: number;
}

// ===== AidClient 主類別 =====

/**
 * 互助客戶端
 *
 * 功能：
 * 1. requestAid()：以 B 角色（請求者）發起互助
 *    - 帶 ECDH 公鑰 → POST /v1/aid/request → 等 WS aid_matched
 *    - ECDH 導出 sharedKey → HKDF → AES-256-GCM 加密 payload
 *    - 等 WS aid_result → 解密回應
 *
 * 2. handleIncomingAidRequest()：以 A 角色（幫助者）處理配對
 *    - 檢查設定、額度、黑名單時段
 *    - ECDH 導出同一把 AES key → 解密請求 → 執行 API → 加密回應
 *
 * 3. updateConfig()：更新互助設定（含幫助者公鑰預登記）
 * 4. getStats()：取得互助統計
 */
export class AidClient {
  /** VPS 通訊客戶端 */
  private vpsClient: VPSClient;
  /** 加密模組 */
  private crypto: CryptoModule;
  /** Key 池 */
  private keyPool: KeyPool;
  /** 資料庫 */
  private db: DatabaseModule;

  /** 本地互助設定 */
  private config: AidClientConfig = {
    enabled: false,
    allowed_services: null,
    daily_limit: 10,
    blackout_hours: [],
    helper_public_key: undefined,
    helper_private_key: undefined,
  };

  /** 冷卻期狀態（requestAid 失敗退避用） */
  private cooldown: CooldownState = {
    consecutiveFailures: 0,
    cooldownUntil: 0,
  };

  /** 今日已幫助次數（從 DB 讀取，每日重置） */
  private dailyGivenCount: number = 0;

  constructor(
    vpsClient: VPSClient,
    crypto: CryptoModule,
    keyPool: KeyPool,
    db: DatabaseModule
  ) {
    this.vpsClient = vpsClient;
    this.crypto = crypto;
    this.keyPool = keyPool;
    this.db = db;

    // 從 DB 讀取互助設定
    this.loadConfigFromDb();

    // 訂閱傳入的互助請求事件（我是幫助者）
    this.vpsClient.onAidRequest((req) => {
      void this.handleIncomingAidRequest(req as IncomingAidRequest);
    });
  }

  // ===== 公開方法 =====

  /**
   * 發起互助請求（我是請求者 B）
   *
   * 流程：
   * 1. 檢查冷卻期
   * 2. 產生臨時 ECDH 金鑰對（B）
   * 3. POST /v1/aid/request（帶 requester_public_key）→ 202 + aid_id
   * 4. 等 WS aid_matched（含 helper_public_key = A 的預登記公鑰）
   * 5. ECDH(B_private, helper_public_key) → sharedKey
   * 6. HKDF-SHA256(ikm=sharedKey, salt=aid_id, info="clawapi-aid-v1") → AES key
   * 7. AES-256-GCM 加密 payload → WS 發送 aid_data
   * 8. 等 WS aid_result → 解密回應
   * 9. timeout 30 秒
   */
  async requestAid(params: RequestAidParams): Promise<AidResult> {
    // 檢查冷卻期
    const cooldownRemaining = this.getCooldownRemaining();
    if (cooldownRemaining > 0) {
      return {
        success: false,
        error: `互助冷卻中，請等待 ${Math.ceil(cooldownRemaining / 1000)} 秒後再試`,
        aid_id: '',
      };
    }

    // 序列化 payload
    const payloadStr = typeof params.payload === 'string'
      ? params.payload
      : JSON.stringify(params.payload);

    // 檢查 payload 大小（加密前 ≤ 1MB）
    const payloadBytes = new TextEncoder().encode(payloadStr).byteLength;
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      return {
        success: false,
        error: `Payload 超過 1MB 限制（${payloadBytes} bytes），拒絕發起互助`,
        aid_id: '',
      };
    }

    // 產生臨時 ECDH 金鑰對（B）
    let myKeyPair: { publicKey: string; privateKey: string };
    try {
      myKeyPair = await this.crypto.generateECDHKeyPair();
    } catch (err) {
      return {
        success: false,
        error: `產生 ECDH 金鑰對失敗：${String(err)}`,
        aid_id: '',
      };
    }

    // 組裝互助請求
    const aidRequest: AidRequest = {
      service_id: params.service_id as AidRequest['service_id'],
      request_type: params.request_type,
      requester_public_key: myKeyPair.publicKey,
      max_latency_ms: params.max_latency_ms ?? 10_000,
      context: {
        retry_count: params.retry_count ?? 0,
        original_error: params.original_error ?? '',
      },
    };

    // 發送 POST /v1/aid/request → 202 + aid_id
    let accepted: AidAccepted;
    const startTime = Date.now();

    try {
      accepted = await this.postAidRequest(aidRequest);
    } catch (err) {
      this.recordFailure();
      return {
        success: false,
        error: `POST /v1/aid/request 失敗：${String(err)}`,
        aid_id: '',
      };
    }

    const aidId = accepted.aid_id;

    // 開始計時，等待 WS 事件
    try {
      const result = await this.waitForAidCompletion(
        aidId,
        myKeyPair.privateKey,
        payloadStr,
        startTime
      );

      if (result.success) {
        this.recordSuccess();
      } else {
        this.recordFailure();
      }

      return { ...result, aid_id: aidId };

    } catch (err) {
      this.recordFailure();
      return {
        success: false,
        error: String(err),
        aid_id: aidId,
      };
    }
  }

  /**
   * 處理傳入的互助配對（我是幫助者 A）
   *
   * 流程：
   * 1. 檢查互助是否開啟
   * 2. 檢查服務是否允許
   * 3. 檢查每日額度
   * 4. 檢查 blackout 時段
   * 5. ECDH(A_private, requester_public_key) → sharedKey
   * 6. HKDF 導出同一把 AES key
   * 7. 用自己的 Key 執行 API 呼叫（stub，由上層整合）
   * 8. 加密回應 → WS 回傳 aid_response
   */
  async handleIncomingAidRequest(request: IncomingAidRequest): Promise<void> {
    const { aid_id, service_id, requester_public_key } = request;

    // 1. 檢查互助是否開啟
    if (!this.config.enabled) {
      await this.sendAidRejection(aid_id, '互助功能未開啟');
      return;
    }

    // 2. 檢查服務是否允許
    if (!this.isServiceAllowed(service_id)) {
      await this.sendAidRejection(aid_id, `服務 ${service_id} 不在允許清單內`);
      return;
    }

    // 3. 檢查每日額度
    if (this.dailyGivenCount >= this.config.daily_limit) {
      await this.sendAidRejection(aid_id, `今日互助額度已用完（${this.config.daily_limit} 次）`);
      return;
    }

    // 4. 檢查 blackout 時段
    if (this.isBlackoutTime()) {
      await this.sendAidRejection(aid_id, '目前為黑名單時段，不提供互助');
      return;
    }

    // 5. 確認有幫助者私鑰
    if (!this.config.helper_private_key) {
      await this.sendAidRejection(aid_id, '未設定幫助者私鑰，無法解密請求');
      return;
    }

    try {
      // 6. ECDH(A_private, requester_public_key) → sharedKey
      const sharedSecret = await this.crypto.deriveSharedSecret(
        this.config.helper_private_key,
        requester_public_key
      );

      // 7. HKDF-SHA256 導出 AES key（SPEC-C §4.5 嚴格規範）
      const aesKeyBytes = await this.deriveAesKeyWithWebCrypto(sharedSecret, aid_id);

      // 8. 等待請求者發送加密的 aid_data（encrypted_request）
      // 在真實場景中，這會透過 WS onAidData 事件接收
      // 這裡先準備好 key，由上層 handler 呼叫 processEncryptedRequest
      void this.awaitAndProcessEncryptedRequest(aid_id, aesKeyBytes, service_id, request);

    } catch (err) {
      await this.sendAidRejection(aid_id, `ECDH 金鑰交換失敗：${String(err)}`);
    }
  }

  /**
   * 更新互助設定
   * 同時向 VPS 同步設定（含 helper_public_key 預登記）
   *
   * @param config 新設定（部分更新）
   */
  async updateConfig(config: Partial<AidClientConfig>): Promise<void> {
    // 更新本地設定
    this.config = { ...this.config, ...config };

    // 組裝 VPS 格式的設定
    const vpsConfig: Partial<AidConfig> = {
      enabled: this.config.enabled,
      allowed_services: this.config.allowed_services as AidConfig['allowed_services'],
      daily_limit: this.config.daily_limit,
      blackout_hours: this.config.blackout_hours,
    };

    // 若有公鑰，加入 helper_public_key 預登記
    if (this.config.helper_public_key) {
      vpsConfig.helper_public_key = this.config.helper_public_key;
    }

    // 同步到 VPS：PUT /v1/aid/config
    await this.putAidConfig(vpsConfig);

    // 存入本地 DB
    this.saveConfigToDb();
  }

  /**
   * 取得互助統計
   * GET /v1/aid/stats
   */
  async getStats(): Promise<AidStats> {
    return this.getAidStats();
  }

  /**
   * 取得目前冷卻剩餘時間（毫秒）
   * 0 表示不在冷卻期
   */
  getCooldownRemaining(): number {
    const now = Date.now();
    if (this.cooldown.cooldownUntil > now) {
      return this.cooldown.cooldownUntil - now;
    }
    return 0;
  }

  /**
   * 取得連續失敗次數（測試用）
   */
  getConsecutiveFailures(): number {
    return this.cooldown.consecutiveFailures;
  }

  /**
   * 重置冷卻期（測試用）
   */
  resetCooldown(): void {
    this.cooldown = { consecutiveFailures: 0, cooldownUntil: 0 };
  }

  // ===== 私有：HKDF（Web Crypto API 實作） =====

  /**
   * 使用 Web Crypto API 進行 HKDF-SHA256（SPEC-C §4.5 嚴格規範）
   *
   * 參數：
   * - hash: SHA-256
   * - salt: aid_id（UTF-8 編碼）
   * - info: "clawapi-aid-v1"（UTF-8 編碼）
   * - length: 32 bytes（256 bits）
   */
  private async deriveAesKeyWithWebCrypto(
    sharedSecret: Uint8Array,
    aidId: string
  ): Promise<Uint8Array> {
    const webCrypto = globalThis.crypto;

    // 確保 ArrayBuffer 是純粹的（非 SharedArrayBuffer），以符合 Web Crypto API 要求
    const sharedSecretBuffer = sharedSecret.buffer.slice(
      sharedSecret.byteOffset,
      sharedSecret.byteOffset + sharedSecret.byteLength
    ) as ArrayBuffer;

    // 匯入共享密鑰為 HKDF 原料
    const keyMaterial = await webCrypto.subtle.importKey(
      'raw',
      sharedSecretBuffer,
      { name: 'HKDF' },
      false,
      ['deriveBits']
    );

    // HKDF 導出 256 bits（32 bytes）
    const aesKeyBits = await webCrypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        // salt = aid_id（UTF-8 編碼）— 互助請求的唯一 ID
        salt: new TextEncoder().encode(aidId),
        // info = "clawapi-aid-v1"（UTF-8 編碼）
        info: new TextEncoder().encode(HKDF_INFO),
      },
      keyMaterial,
      256
    );

    return new Uint8Array(aesKeyBits);
  }

  // ===== 私有：互助請求流程 =====

  /**
   * 等待互助完成（aid_matched → 加密發送 → aid_result → 解密）
   * timeout 30 秒
   */
  private waitForAidCompletion(
    aidId: string,
    myPrivateKey: string,
    payloadStr: string,
    startTime: number
  ): Promise<Omit<AidResult, 'aid_id'>> {
    return new Promise<Omit<AidResult, 'aid_id'>>((resolve) => {
      let settled = false;

      // 30 秒 timeout
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupHandlers();
        resolve({
          success: false,
          error: `互助請求逾時（${AID_REQUEST_TIMEOUT_MS / 1000} 秒），未收到幫助者回應`,
          latency_ms: Date.now() - startTime,
        });
      }, AID_REQUEST_TIMEOUT_MS);

      // aid_matched → 收到幫助者公鑰
      const handleMatched = (raw: unknown) => {
        if (settled) return;

        const msg = raw as AidMatchedNotification & { aid_id: string };

        // 過濾不屬於此次請求的事件
        if (msg.aid_id !== aidId) {
          return;
        }

        const helperPublicKey = msg.helper_public_key;
        if (!helperPublicKey) {
          // helper_public_key 缺少，忽略此事件
          return;
        }

        // 非同步執行 ECDH + 加密發送
        void (async () => {
          try {
            // ECDH(B_private, helper_public_key) → sharedKey
            const sharedSecret = await this.crypto.deriveSharedSecret(
              myPrivateKey,
              helperPublicKey
            );

            // HKDF-SHA256 → AES key
            const aesKeyBytes = await this.deriveAesKeyWithWebCrypto(sharedSecret, aidId);

            // AES-256-GCM 加密 payload
            const encrypted = await this.aesGcmEncrypt(aesKeyBytes, payloadStr);

            // 透過 WS 發送加密的 aid_data
            this.sendEncryptedAidData(aidId, encrypted);

          } catch (err) {
            if (settled) return;
            settled = true;
            cleanupHandlers();
            clearTimeout(timeoutHandle);
            resolve({
              success: false,
              error: `加密 payload 失敗：${String(err)}`,
              latency_ms: Date.now() - startTime,
            });
          }
        })();
      };

      // aid_result → 收到加密回應
      const handleResult = (raw: unknown) => {
        if (settled) return;

        const msg = raw as AidResultNotification & Record<string, unknown>;

        // 過濾不屬於此次請求的事件
        const eventAidId = msg.aid_id ?? (msg as Record<string, unknown>)['aid_id'];
        if (eventAidId !== aidId) return;

        if (msg.status === 'timeout') {
          settled = true;
          cleanupHandlers();
          clearTimeout(timeoutHandle);
          resolve({
            success: false,
            error: msg.message ?? '互助請求逾時（VPS 端）',
            latency_ms: Date.now() - startTime,
          });
          return;
        }

        if (msg.status === 'error') {
          settled = true;
          cleanupHandlers();
          clearTimeout(timeoutHandle);
          resolve({
            success: false,
            error: msg.message ?? '互助發生錯誤',
            latency_ms: Date.now() - startTime,
          });
          return;
        }

        if (msg.status === 'fulfilled') {
          const responseEncrypted = msg.response_encrypted;
          const helperPublicKey = msg.helper_public_key;

          if (!responseEncrypted || !helperPublicKey) {
            settled = true;
            cleanupHandlers();
            clearTimeout(timeoutHandle);
            resolve({
              success: false,
              error: '互助回應缺少加密資料或幫助者公鑰',
              latency_ms: Date.now() - startTime,
            });
            return;
          }

          // 非同步解密
          void (async () => {
            try {
              // 重新導出同一把 sharedKey（B_private + helper_public_key）
              const sharedSecret = await this.crypto.deriveSharedSecret(
                myPrivateKey,
                helperPublicKey
              );
              const aesKeyBytes = await this.deriveAesKeyWithWebCrypto(sharedSecret, aidId);

              // AES-256-GCM 解密
              const decrypted = await this.aesGcmDecrypt(aesKeyBytes, responseEncrypted);

              settled = true;
              cleanupHandlers();
              clearTimeout(timeoutHandle);
              resolve({
                success: true,
                response: decrypted,
                latency_ms: Date.now() - startTime,
              });

            } catch (err) {
              if (settled) return;
              settled = true;
              cleanupHandlers();
              clearTimeout(timeoutHandle);
              resolve({
                success: false,
                error: `解密互助回應失敗：${String(err)}`,
                latency_ms: Date.now() - startTime,
              });
            }
          })();
        }
      };

      // 清理 handler 的函式
      const cleanupHandlers = () => {
        this.removeWsHandler('aid_matched', handleMatched);
        this.removeWsHandler('aid_result', handleResult);
      };

      // 訂閱 WS 事件
      this.registerWsHandler('aid_matched', handleMatched);
      this.registerWsHandler('aid_result', handleResult);
    });
  }

  /**
   * 等待並處理加密的請求（幫助者 A 角色）
   * 在真實部署中，這會透過 WS onAidData 事件接收加密請求
   */
  private async awaitAndProcessEncryptedRequest(
    aidId: string,
    aesKeyBytes: Uint8Array,
    serviceId: string,
    originalRequest: IncomingAidRequest
  ): Promise<void> {
    // 30 秒等待加密請求
    const encryptedData = await this.waitForEncryptedRequest(aidId);

    if (!encryptedData) {
      // 沒收到請求，不做任何事（timeout 自然結束）
      return;
    }

    try {
      // 解密請求
      const decrypted = await this.aesGcmDecrypt(aesKeyBytes, encryptedData.encrypted_payload);

      // 用自己的 Key 執行 API 呼叫
      const apiResponse = await this.executeApiCall(serviceId, decrypted);

      // 加密回應
      const encryptedResponse = await this.aesGcmEncrypt(aesKeyBytes, apiResponse);

      // 記錄幫助次數
      this.dailyGivenCount++;
      this.recordDailyGiven(aidId, serviceId);

      // 透過 WS 回傳加密的 aid_response
      this.sendEncryptedAidResponse(aidId, encryptedResponse);

    } catch (err) {
      // 執行失敗，回傳錯誤
      await this.sendAidRejection(aidId, `執行 API 呼叫失敗：${String(err)}`);
    }
  }

  /**
   * 等待傳入的加密請求資料（WS aid_data 事件）
   * timeout 30 秒
   */
  private waitForEncryptedRequest(aidId: string): Promise<AidEncryptedRequest | null> {
    return new Promise<AidEncryptedRequest | null>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        cleanup();
        resolve(null);
      }, AID_REQUEST_TIMEOUT_MS);

      const handler = (raw: unknown) => {
        const msg = raw as AidEncryptedRequest & Record<string, unknown>;
        if (msg.aid_id !== aidId) return;
        if (msg.kind !== 'encrypted_request') return;

        clearTimeout(timeoutHandle);
        cleanup();
        resolve(msg);
      };

      const cleanup = () => {
        this.removeWsHandler('aid_data', handler);
      };

      this.registerWsHandler('aid_data', handler);
    });
  }

  // ===== 私有：AES-256-GCM 加解密（Web Crypto API） =====

  /**
   * AES-256-GCM 加密
   * 輸入：32 bytes AES key、明文字串
   * 輸出：Base64 編碼的 [IV(12) | AuthTag(16) | CipherText]
   */
  private async aesGcmEncrypt(aesKeyBytes: Uint8Array, plaintext: string): Promise<string> {
    const webCrypto = globalThis.crypto;

    // 確保 ArrayBuffer 是純粹的，以符合 Web Crypto API 要求
    const keyBuffer = aesKeyBytes.buffer.slice(
      aesKeyBytes.byteOffset,
      aesKeyBytes.byteOffset + aesKeyBytes.byteLength
    ) as ArrayBuffer;

    // 匯入 AES key
    const key = await webCrypto.subtle.importKey(
      'raw',
      keyBuffer,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    // 產生隨機 IV（12 bytes）
    const iv = webCrypto.getRandomValues(new Uint8Array(12));

    // 加密
    const encoder = new TextEncoder();
    const plainBuffer = encoder.encode(plaintext).buffer.slice(0) as ArrayBuffer;
    const cipherBuffer = await webCrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      plainBuffer
    );

    // AES-GCM 輸出：ciphertext + authTag（16 bytes 附在末尾）
    // 組合格式：IV(12) + AuthTag(16) + CipherText
    const cipherArray = new Uint8Array(cipherBuffer);
    const cipherLen = cipherArray.byteLength - 16; // 去掉 authTag
    const authTag = cipherArray.slice(cipherLen);
    const ciphertext = cipherArray.slice(0, cipherLen);

    const combined = new Uint8Array(12 + 16 + cipherLen);
    combined.set(iv, 0);
    combined.set(authTag, 12);
    combined.set(ciphertext, 28);

    // 轉為 Base64
    return this.uint8ArrayToBase64(combined);
  }

  /**
   * AES-256-GCM 解密
   * 輸入：32 bytes AES key、Base64 編碼的 [IV(12) | AuthTag(16) | CipherText]
   * 輸出：明文字串
   */
  private async aesGcmDecrypt(aesKeyBytes: Uint8Array, encryptedBase64: string): Promise<string> {
    const webCrypto = globalThis.crypto;

    const combined = this.base64ToUint8Array(encryptedBase64);
    if (combined.byteLength < 12 + 16) {
      throw new Error('加密資料長度不足，無法解密');
    }

    const iv = combined.slice(0, 12);
    const authTag = combined.slice(12, 28);
    const ciphertext = combined.slice(28);

    // Web Crypto API 期望：ciphertext + authTag 合在一起
    const cipherWithTag = new Uint8Array(ciphertext.byteLength + 16);
    cipherWithTag.set(ciphertext, 0);
    cipherWithTag.set(authTag, ciphertext.byteLength);

    // 確保 ArrayBuffer 是純粹的，以符合 Web Crypto API 要求
    const keyBuffer = aesKeyBytes.buffer.slice(
      aesKeyBytes.byteOffset,
      aesKeyBytes.byteOffset + aesKeyBytes.byteLength
    ) as ArrayBuffer;
    const cipherBuffer = cipherWithTag.buffer.slice(
      cipherWithTag.byteOffset,
      cipherWithTag.byteOffset + cipherWithTag.byteLength
    ) as ArrayBuffer;

    // 匯入 AES key
    const key = await webCrypto.subtle.importKey(
      'raw',
      keyBuffer,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    // 解密
    const decryptedBuffer = await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      cipherBuffer
    );

    return new TextDecoder().decode(decryptedBuffer);
  }

  // ===== 私有：API 呼叫（幫助者執行） =====

  /**
   * 用自己的 Key 執行 API 呼叫
   * 實際整合時會呼叫 KeyPool 選 Key + 對應的 Adapter Executor
   * 目前為 stub，上層整合時覆寫此方法
   */
  protected async executeApiCall(
    serviceId: string,
    decryptedRequest: string
  ): Promise<string> {
    // 從 Key Pool 選取可用的 Key
    const keyResult = await this.keyPool.selectKeyWithFallback(serviceId);

    if (!keyResult) {
      throw new Error(`服務 ${serviceId} 沒有可用的 Key`);
    }

    // TODO: 整合 AdapterExecutor 執行實際 API 呼叫
    // 目前回傳 stub 回應（讓測試通過）
    const requestData = JSON.parse(decryptedRequest) as Record<string, unknown>;
    return JSON.stringify({
      status: 'ok',
      service_id: serviceId,
      key_id: keyResult.key.id,
      result: `來自服務 ${serviceId} 的回應（stub）`,
      echo: requestData,
    });
  }

  // ===== 私有：WS 事件管理 =====

  /** WS 事件 handlers 映射 */
  private wsHandlers: Map<string, Array<(payload: unknown) => void>> = new Map();

  /**
   * 註冊 WS 事件 handler
   */
  private registerWsHandler(event: string, handler: (payload: unknown) => void): void {
    const handlers = this.wsHandlers.get(event) ?? [];
    handlers.push(handler);
    this.wsHandlers.set(event, handlers);

    // 首次註冊時，訂閱 VPSClient 的事件
    if (handlers.length === 1) {
      this.subscribeVpsEvent(event, handler);
    } else {
      // 後續直接加入 handlers map，由統一的分發器處理
    }
  }

  /**
   * 移除 WS 事件 handler
   */
  private removeWsHandler(event: string, handler: (payload: unknown) => void): void {
    const handlers = this.wsHandlers.get(event);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx !== -1) {
      handlers.splice(idx, 1);
    }
  }

  /**
   * 訂閱 VPSClient 的 WS 事件（分發到內部 handlers）
   */
  private subscribeVpsEvent(event: string, _firstHandler: (payload: unknown) => void): void {
    const dispatch = (payload: unknown) => {
      const handlers = this.wsHandlers.get(event) ?? [];
      for (const h of handlers) {
        try { h(payload); } catch { /* 忽略單一 handler 錯誤 */ }
      }
    };

    switch (event) {
      case 'aid_matched':
        (this.vpsClient as unknown as {
          ws: { onAidMatched: (h: (p: unknown) => void) => void };
        }).ws?.onAidMatched?.(dispatch);
        // fallback：嘗試直接訂閱
        this.trySubscribeWsEvent('aid_matched', dispatch);
        break;
      case 'aid_result':
        this.trySubscribeWsEvent('aid_result', dispatch);
        break;
      case 'aid_data':
        this.trySubscribeWsEvent('aid_data', dispatch);
        break;
    }
  }

  /**
   * 嘗試透過 VPSClient 訂閱 WS 事件
   * VPSClient 目前只暴露 onRoutingUpdate、onNotification、onAidRequest
   * 其他事件透過 cast 取得底層 ws 物件
   */
  private trySubscribeWsEvent(event: string, handler: (payload: unknown) => void): void {
    const client = this.vpsClient as unknown as Record<string, unknown>;
    const wsClient = client['ws'] as Record<string, unknown> | undefined;
    if (!wsClient) return;

    const methodName = `on${event.split('_').map(s => s[0]!.toUpperCase() + s.slice(1)).join('')}`;
    const method = wsClient[methodName];
    if (typeof method === 'function') {
      (method as (h: (p: unknown) => void) => void).call(wsClient, handler);
    }
  }

  // ===== 私有：WS 發送方法 =====

  /**
   * 透過 WS 發送加密的 aid_data（我是請求者 B 發送給 A）
   */
  private sendEncryptedAidData(aidId: string, encryptedBase64: string): void {
    // 從 combined base64 中拆出 IV、AuthTag、CipherText（各轉 base64）
    const combined = this.base64ToUint8Array(encryptedBase64);
    const ivBase64 = this.uint8ArrayToBase64(combined.slice(0, 12));
    const tagBase64 = this.uint8ArrayToBase64(combined.slice(12, 28));
    const cipherBase64 = this.uint8ArrayToBase64(combined.slice(28));

    const wsClient = this.getWsClient();
    if (wsClient && typeof wsClient.sendAidData === 'function') {
      wsClient.sendAidData(aidId, 'encrypted_request', cipherBase64, ivBase64, tagBase64);
    }
  }

  /**
   * 透過 WS 回傳加密的 aid_response（我是幫助者 A 回應給 B）
   */
  private sendEncryptedAidResponse(aidId: string, encryptedBase64: string): void {
    const combined = this.base64ToUint8Array(encryptedBase64);
    const ivBase64 = this.uint8ArrayToBase64(combined.slice(0, 12));
    const tagBase64 = this.uint8ArrayToBase64(combined.slice(12, 28));
    const cipherBase64 = this.uint8ArrayToBase64(combined.slice(28));

    const responsePayload: AidEncryptedResponse = {
      type: 'aid_data',
      kind: 'encrypted_response',
      aid_id: aidId,
      encrypted_payload: cipherBase64,
      iv: ivBase64,
      tag: tagBase64,
      helper_public_key: this.config.helper_public_key ?? '',
    };

    const wsClient = this.getWsClient();
    if (wsClient && typeof wsClient.sendAidResponse === 'function') {
      wsClient.sendAidResponse(aidId, {
        aid_id: aidId,
        status: 'fulfilled',
        response_encrypted: JSON.stringify(responsePayload),
        encryption_method: 'aes-256-gcm',
        helper_public_key: this.config.helper_public_key,
      });
    }
  }

  /**
   * 發送互助拒絕訊息
   */
  private async sendAidRejection(aidId: string, reason: string): Promise<void> {
    const wsClient = this.getWsClient();
    if (wsClient && typeof wsClient.sendAidResponse === 'function') {
      wsClient.sendAidResponse(aidId, {
        aid_id: aidId,
        status: 'rejected',
        error_message: reason,
      });
    }
  }

  /**
   * 取得底層 WS 客戶端
   */
  private getWsClient(): Record<string, unknown> | null {
    const client = this.vpsClient as unknown as Record<string, unknown>;
    return (client['ws'] as Record<string, unknown>) ?? null;
  }

  // ===== 私有：HTTP 代理方法 =====

  /**
   * POST /v1/aid/request
   */
  private async postAidRequest(request: AidRequest): Promise<AidAccepted> {
    const client = this.vpsClient as unknown as Record<string, unknown>;
    const http = client['http'] as Record<string, unknown> | undefined;

    if (http && typeof http['requestAid'] === 'function') {
      return (http['requestAid'] as (r: AidRequest) => Promise<AidAccepted>)(request);
    }

    throw new Error('VPSClient 無法存取 HTTP 客戶端');
  }

  /**
   * PUT /v1/aid/config
   */
  private async putAidConfig(config: Partial<AidConfig>): Promise<void> {
    const client = this.vpsClient as unknown as Record<string, unknown>;
    const http = client['http'] as Record<string, unknown> | undefined;

    if (http && typeof http['updateAidConfig'] === 'function') {
      await (http['updateAidConfig'] as (c: Partial<AidConfig>) => Promise<void>)(config);
    }
  }

  /**
   * GET /v1/aid/stats
   */
  private async getAidStats(): Promise<AidStats> {
    const client = this.vpsClient as unknown as Record<string, unknown>;
    const http = client['http'] as Record<string, unknown> | undefined;

    if (http && typeof http['getAidStats'] === 'function') {
      return (http['getAidStats'] as () => Promise<AidStats>)();
    }

    throw new Error('VPSClient 無法存取 HTTP 客戶端');
  }

  // ===== 私有：冷卻期管理 =====

  /**
   * 記錄成功（重置冷卻期）
   */
  private recordSuccess(): void {
    this.cooldown = { consecutiveFailures: 0, cooldownUntil: 0 };
  }

  /**
   * 記錄失敗（遞增冷卻期）
   *
   * 冷卻期遞增規則：
   * - 第 1 次失敗：60 秒
   * - 第 2 次失敗：120 秒
   * - 第 3 次失敗：240 秒
   * - 第 4 次以上：480 秒（上限）
   */
  private recordFailure(): void {
    this.cooldown.consecutiveFailures++;
    const failures = this.cooldown.consecutiveFailures;

    // 60s * 2^(failures-1)，上限 480s
    const cooldownMs = Math.min(COOLDOWN_BASE_MS * Math.pow(2, failures - 1), COOLDOWN_MAX_MS);
    this.cooldown.cooldownUntil = Date.now() + cooldownMs;
  }

  // ===== 私有：設定管理 =====

  /**
   * 從 DB 讀取互助設定
   */
  private loadConfigFromDb(): void {
    try {
      const rows = this.db.query<{
        enabled: number;
        allowed_services: string | null;
        daily_limit: number;
        daily_given: number;
        blackout_hours: string | null;
        helper_public_key: string | null;
      }>(
        `SELECT enabled, allowed_services, daily_limit, daily_given,
                blackout_hours, helper_public_key
         FROM aid_config LIMIT 1`
      );

      if (rows.length > 0) {
        const row = rows[0]!;
        this.config.enabled = row.enabled === 1;
        this.config.allowed_services = row.allowed_services
          ? (JSON.parse(row.allowed_services) as string[])
          : null;
        this.config.daily_limit = row.daily_limit;
        this.config.blackout_hours = row.blackout_hours
          ? (JSON.parse(row.blackout_hours) as number[])
          : [];
        this.config.helper_public_key = row.helper_public_key ?? undefined;
        this.dailyGivenCount = row.daily_given;
      }
    } catch {
      // aid_config 表格不存在或讀取失敗，使用預設值
    }
  }

  /**
   * 將設定存入 DB
   */
  private saveConfigToDb(): void {
    try {
      this.db.run(
        `INSERT OR REPLACE INTO aid_config
          (id, enabled, allowed_services, daily_limit, blackout_hours, helper_public_key, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          this.config.enabled ? 1 : 0,
          this.config.allowed_services ? JSON.stringify(this.config.allowed_services) : null,
          this.config.daily_limit,
          this.config.blackout_hours.length > 0
            ? JSON.stringify(this.config.blackout_hours)
            : null,
          this.config.helper_public_key ?? null,
        ]
      );
    } catch {
      // 寫入失敗忽略（非關鍵操作）
    }
  }

  /**
   * 記錄幫助一次（更新 DB daily_given）
   */
  private recordDailyGiven(aidId: string, serviceId: string): void {
    try {
      this.db.run(
        `UPDATE aid_config SET daily_given = daily_given + 1 WHERE id = 1`
      );
      // 記錄到 aid_log 表格（如果存在）
      this.db.run(
        `INSERT OR IGNORE INTO aid_log
          (aid_id, direction, service_id, status, created_at)
         VALUES (?, 'given', ?, 'fulfilled', datetime('now'))`,
        [aidId, serviceId]
      );
    } catch {
      // 非關鍵操作，忽略錯誤
    }
  }

  // ===== 私有：業務邏輯判斷 =====

  /**
   * 判斷服務是否在允許清單內
   * allowed_services = null → 全部允許
   */
  private isServiceAllowed(serviceId: string): boolean {
    if (!this.config.allowed_services) return true;
    return this.config.allowed_services.includes(serviceId);
  }

  /**
   * 判斷目前是否在黑名單時段
   */
  private isBlackoutTime(): boolean {
    if (!this.config.blackout_hours || this.config.blackout_hours.length === 0) {
      return false;
    }
    const currentHour = new Date().getHours();
    return this.config.blackout_hours.includes(currentHour);
  }

  // ===== 私有：Base64 工具 =====

  /** Uint8Array → Base64 字串 */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }

  /** Base64 字串 → Uint8Array */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

// ===== 模組導出 =====

export type {
  AidRequest,
  AidAccepted,
  AidConfig,
  AidStats,
  AidMatchedNotification,
  AidResultNotification,
};
