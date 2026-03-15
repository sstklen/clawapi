// Sub-Key 驗證中繼服務
// 負責 Sub-Key 的驗證流程：快取查詢 → 發行者查詢 → WS 問詢 → 結果快取
// 依據 SPEC-C §5 實作，Sub-Key 由裝置（發行者）自己驗證，VPS 只是中繼

import { ErrorCode } from '@clawapi/protocol';
import type { VPSDatabase } from '../storage/database';
import type { WebSocketManager } from '../ws/manager';

// Bun 全域 Web Crypto API
const webCrypto = globalThis.crypto;

// ===== 型別定義 =====

// Sub-Key 驗證結果
export interface SubKeyValidateResult {
  valid: boolean;
  permissions?: string[];  // 允許的操作列表（由發行者定義）
}

// 驗證錯誤結果
export interface SubKeyValidateError {
  errorCode: ErrorCode;
  message: string;
}

// 快取條目
interface CacheEntry {
  response: SubKeyValidateResult;
  timestamp: number;  // 快取時間（毫秒）
}

// 等待中的驗證請求
interface PendingRequest {
  resolve: (result: SubKeyValidateResult) => void;
  reject: (error: SubKeyValidateError) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// WS 驗證請求的 payload
interface SubKeyValidatePayload {
  request_id: string;
  sub_key: string;
  service_id: string;
}

// 發行者回應的 payload
export interface SubKeyResultPayload {
  request_id: string;
  valid: boolean;
  permissions?: string[];
  error?: string;
}

// ===== SubKeyValidator 主類別 =====

export class SubKeyValidator {
  private db: VPSDatabase;
  private wsManager: WebSocketManager;

  // 驗證結果快取：key = subkey_{sha256(token)}_{serviceId}
  // 快取 5 分鐘（300 秒）
  private cache: Map<string, CacheEntry> = new Map();

  // 等待中的驗證請求：requestId → PendingRequest
  private pendingRequests: Map<string, PendingRequest> = new Map();

  // 快取有效期（5 分鐘）
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  // 發行者回應超時（10 秒）
  private readonly VALIDATE_TIMEOUT_MS = 10_000;

  constructor(db: VPSDatabase, wsManager: WebSocketManager) {
    this.db = db;
    this.wsManager = wsManager;
  }

  // ===== 核心功能：驗證 Sub-Key =====
  // 完整流程：快取 → 推斷發行者 → 查 DB → 確認在線 → WS 問詢 → 等回應 → 快取
  async validate(
    subKeyToken: string,
    serviceId: string,
  ): Promise<SubKeyValidateResult> {
    // ===== Step 1: 查快取（5 分鐘內直接回傳）=====
    const cacheKey = await this._buildCacheKey(subKeyToken, serviceId);
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      // 快取命中，直接回傳
      return cached.response;
    }

    // ===== Step 2: 從 token 格式推斷發行者 =====
    // Sub-Key 格式：sk_live_{device_id_hash}_{random}
    // device_id_hash 是 device_id 的前綴部分（8 字元 hex）
    const issuerId = this._extractIssuerId(subKeyToken);

    if (!issuerId) {
      throw {
        errorCode: ErrorCode.SUBKEY_INVALID,
        message: 'Sub-Key 格式錯誤，無法識別發行者',
      } as SubKeyValidateError;
    }

    // ===== Step 3: 查 DB 找到完整的 device_id =====
    const issuerDevice = this._findIssuerDevice(issuerId);

    if (!issuerDevice) {
      throw {
        errorCode: ErrorCode.SUBKEY_INVALID,
        message: '找不到 Sub-Key 的發行者裝置',
      } as SubKeyValidateError;
    }

    // ===== Step 4: 檢查發行者是否在線 =====
    const connection = this.wsManager.getConnection(issuerDevice);

    if (!connection) {
      throw {
        errorCode: ErrorCode.SUBKEY_ISSUER_OFFLINE,
        message: 'Sub-Key 發行者目前離線，無法驗證',
      } as SubKeyValidateError;
    }

    // ===== Step 5: 透過 WS 問發行者驗證 =====
    const requestId = crypto.randomUUID();

    const validatePayload: SubKeyValidatePayload = {
      request_id: requestId,
      sub_key: subKeyToken,
      service_id: serviceId,
    };

    // 傳送驗證請求給發行者
    const sent = this.wsManager.sendToDevice(issuerDevice, {
      type: 'subkey_validate',
      channel: 'routing',
      id: requestId,
      payload: validatePayload,
      server_time: new Date().toISOString(),
    });

    if (!sent) {
      // 傳送失敗（連線剛斷開）
      throw {
        errorCode: ErrorCode.SUBKEY_ISSUER_OFFLINE,
        message: 'Sub-Key 發行者連線已斷開',
      } as SubKeyValidateError;
    }

    // ===== Step 6: 等待發行者回應（最多 10 秒）=====
    const result = await this._waitForResult(requestId);

    // ===== Step 7: 快取結果 5 分鐘 =====
    this.cache.set(cacheKey, {
      response: result,
      timestamp: Date.now(),
    });

    return result;
  }

  // ===== 接收發行者的驗證回應 =====
  // 由 WS manager 的 subkey_validate_response handler 呼叫
  handleSubKeyResult(requestId: string, result: SubKeyResultPayload): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      // 已超時或無此請求，忽略
      return;
    }

    // 清除超時計時器
    clearTimeout(pending.timeoutHandle);
    this.pendingRequests.delete(requestId);

    if (result.error) {
      // 發行者明確拒絕
      pending.resolve({ valid: false });
    } else {
      // 發行者回傳驗證結果
      pending.resolve({
        valid: result.valid,
        permissions: result.permissions,
      });
    }
  }

  // ===== 快取管理 =====

  // 手動清除指定 token 的快取（發行者撤銷 key 時使用）
  invalidateCache(subKeyToken: string, serviceId: string): void {
    // 注意：這個方法是同步的，無法直接計算 SHA-256
    // 改用 prefix 匹配（serviceId 是純文字，可以做部分匹配）
    const prefix = `subkey_`;
    const suffix = `_${serviceId}`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this.cache.delete(key);
      }
    }
    void subKeyToken; // 參數保留供日後實作精確匹配
  }

  // 清除所有快取（測試用）
  clearCache(): void {
    this.cache.clear();
  }

  // 取得快取大小（測試用）
  getCacheSize(): number {
    return this.cache.size;
  }

  // ===== 私有工具方法 =====

  // 建立快取 key：subkey_{sha256(token)}_{serviceId}
  private async _buildCacheKey(token: string, serviceId: string): Promise<string> {
    const hashBuffer = await webCrypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(token),
    );
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `subkey_${hashHex}_${serviceId}`;
  }

  // 從 Sub-Key token 提取發行者 ID（前綴部分）
  // 格式：sk_live_{device_id_hash}_{random}
  // device_id_hash = device_id 的前 8 字元（去掉 clw_ 前綴後取前 8 個 hex）
  private _extractIssuerId(token: string): string | null {
    // 驗證前綴
    if (!token.startsWith('sk_live_')) return null;

    // 解析 token 結構
    const rest = token.slice('sk_live_'.length);
    const parts = rest.split('_');

    // 需要至少兩段（device_id_hash + random）
    if (parts.length < 2) return null;

    // 第一段是 device_id_hash（8 字元 hex）
    const deviceIdHash = parts[0];
    if (!/^[0-9a-f]{8}$/.test(deviceIdHash ?? '')) return null;

    return deviceIdHash ?? null;
  }

  // 從 DB 根據 device_id_hash 找到完整的 device_id
  // device_id 格式：clw_{32 hex} → hash 取 device_id 去掉 clw_ 後的前 8 字元
  private _findIssuerDevice(deviceIdHash: string): string | null {
    // 查詢 device_id 的前綴（clw_ + deviceIdHash）
    const results = this.db.query<{ device_id: string }>(
      `SELECT device_id FROM devices
       WHERE device_id LIKE 'clw_' || ? || '%'
         AND status = 'active'
       LIMIT 1`,
      [deviceIdHash],
    );

    return results[0]?.device_id ?? null;
  }

  // 等待發行者回應（Promise + 超時）
  private _waitForResult(requestId: string): Promise<SubKeyValidateResult> {
    return new Promise<SubKeyValidateResult>((resolve, reject) => {
      // 超時計時器
      const timeoutHandle = setTimeout(() => {
        // 超時：從等待列表移除，拒絕 Promise
        this.pendingRequests.delete(requestId);
        reject({
          errorCode: ErrorCode.SUBKEY_ISSUER_OFFLINE,
          message: `Sub-Key 驗證超時（${this.VALIDATE_TIMEOUT_MS / 1000} 秒），發行者未回應`,
        } as SubKeyValidateError);
      }, this.VALIDATE_TIMEOUT_MS);

      // 登記等待中的請求
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutHandle,
      });
    });
  }
}
