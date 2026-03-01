// VPS HTTP 客戶端
// 負責與 VPS 的 HTTPS 通訊，帶認證 headers、自動重試、錯誤分類

import type {
  DeviceRegistrationResponse,
  TelemetryFeedback,
  TelemetryBatch,
  L0KeysResponse,
  L0UsageEntry,
  L0DonateRequest,
  AidRequest,
  AidAccepted,
  AidConfig,
  AidStats,
  VersionCheckResponse,
  AdapterUpdatesResponse,
  AdapterListResponse,
  APIError,
} from '@clawapi/protocol';

// ===== 本地型別 =====

/** 裝置註冊參數（從 auth.ts DeviceRegistration 衍生，locale/timezone 改為可選） */
export interface RegisterDeviceParams {
  device_id: string;
  device_fingerprint: string;
  client_version: string;
  os: string;
  arch: string;
  locale?: string;
  timezone?: string;
}

/** HTTP 請求選項 */
export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** 重試次數，預設 3 */
  retries?: number;
  /** 每次重試延遲（毫秒），預設 1000，每次 ×2 */
  retryDelayMs?: number;
}

/** HTTP 回應包裝 */
export interface RequestResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/** VPSHttpClient 建構設定 */
export interface VPSHttpClientConfig {
  baseUrl: string;
  clientVersion: string;
}

/** 429 Rate Limit 錯誤 */
export class RateLimitError extends Error {
  readonly status = 429;
  readonly retryAfter: number | null;

  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter ?? null;
  }
}

/** 認證失敗錯誤（401） */
export class AuthError extends Error {
  readonly status = 401;
  readonly apiError: APIError | null;

  constructor(message: string, apiError?: APIError) {
    super(message);
    this.name = 'AuthError';
    this.apiError = apiError ?? null;
  }
}

/** 伺服器不可用錯誤（503） */
export class ServiceUnavailableError extends Error {
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

/** 一般 HTTP 錯誤 */
export class HttpError extends Error {
  readonly status: number;
  readonly apiError: APIError | null;

  constructor(status: number, message: string, apiError?: APIError) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.apiError = apiError ?? null;
  }
}

// ===== 主要客戶端類別 =====

/**
 * VPSHttpClient：HTTPS 請求客戶端
 *
 * 功能：
 * - 自動附加認證 headers（X-Device-Id, X-Device-Token, X-Client-Version）
 * - 自動重試（503 和網路錯誤）：1s → 2s → 4s
 * - 429 → 不重試，拋出 RateLimitError（含 retry_after）
 * - 401 → 不重試，拋出 AuthError
 */
export class VPSHttpClient {
  private baseUrl: string;
  private deviceId: string | null = null;
  private deviceToken: string | null = null;
  private clientVersion: string;

  constructor(config: VPSHttpClientConfig) {
    // 移除尾端斜線，統一格式
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.clientVersion = config.clientVersion;
  }

  /**
   * 設定裝置認證憑證
   * 設定後所有請求都會帶上 X-Device-Id 和 X-Device-Token headers
   */
  setCredentials(deviceId: string, deviceToken: string): void {
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
  }

  /**
   * 通用 HTTP 請求方法
   *
   * 重試策略：
   * - 503 或網路錯誤 → 重試（最多 retries 次，延遲 retryDelayMs, ×2, ×4 ...）
   * - 429 → 不重試，拋出 RateLimitError
   * - 401 → 不重試，拋出 AuthError
   * - 其他 4xx/5xx → 不重試，拋出 HttpError
   */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<RequestResponse<T>> {
    const { body, headers: extraHeaders, retries = 3, retryDelayMs = 1000 } = options;

    const url = `${this.baseUrl}${path}`;

    // 組合認證 headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Client-Version': this.clientVersion,
      ...extraHeaders,
    };

    if (this.deviceId) {
      headers['X-Device-Id'] = this.deviceId;
    }
    if (this.deviceToken) {
      headers['X-Device-Token'] = this.deviceToken;
    }

    let lastError: Error | null = null;
    let currentDelay = retryDelayMs;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await globalThis.fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        // 429 Rate Limit → 不重試
        if (response.status === 429) {
          let apiError: APIError | undefined;
          let retryAfter: number | undefined;
          try {
            apiError = await response.json() as APIError;
            retryAfter = apiError.retry_after;
          } catch {
            // 解析失敗，繼續丟錯
          }
          throw new RateLimitError(
            `請求被限速（429）`,
            retryAfter
          );
        }

        // 401 認證失敗 → 不重試
        if (response.status === 401) {
          let apiError: APIError | undefined;
          try {
            apiError = await response.json() as APIError;
          } catch {
            // 解析失敗，繼續丟錯
          }
          throw new AuthError(
            `認證失敗（401）：${apiError?.message ?? '未知錯誤'}`,
            apiError
          );
        }

        // 503 → 可以重試
        if (response.status === 503) {
          const err = new ServiceUnavailableError(`VPS 暫時不可用（503）`);
          lastError = err;

          if (attempt < retries) {
            await this.sleep(currentDelay);
            currentDelay *= 2;
            continue;
          }
          throw err;
        }

        // 其他非 2xx 錯誤
        if (!response.ok) {
          let apiError: APIError | undefined;
          try {
            apiError = await response.json() as APIError;
          } catch {
            // 解析失敗，繼續丟錯
          }
          throw new HttpError(
            response.status,
            `HTTP 錯誤 ${response.status}：${apiError?.message ?? response.statusText}`,
            apiError
          );
        }

        // 成功
        let data: T;
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/msgpack') || contentType.includes('application/octet-stream')) {
          // 二進位資料
          data = await response.arrayBuffer() as T;
        } else if (response.status === 204 || response.headers.get('content-length') === '0') {
          // 無回應體
          data = undefined as T;
        } else {
          try {
            data = await response.json() as T;
          } catch {
            data = undefined as T;
          }
        }

        return { data, status: response.status, headers: response.headers };

      } catch (err) {
        // 如果是 RateLimitError 或 AuthError，直接往上拋（不重試）
        if (err instanceof RateLimitError || err instanceof AuthError) {
          throw err;
        }

        // 如果是 HttpError（非 503），直接往上拋
        if (err instanceof HttpError) {
          throw err;
        }

        // ServiceUnavailableError 或網路錯誤 → 重試
        if (err instanceof ServiceUnavailableError) {
          // 已在上方處理重試邏輯
          throw err;
        }

        // 網路錯誤（fetch 失敗）→ 重試
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < retries) {
          await this.sleep(currentDelay);
          currentDelay *= 2;
          continue;
        }

        throw lastError;
      }
    }

    // 理論上不會到這裡
    throw lastError ?? new Error('請求失敗');
  }

  // ===== 裝置管理 =====

  /**
   * 注冊裝置
   * POST /v1/devices/register
   */
  async registerDevice(params: RegisterDeviceParams): Promise<DeviceRegistrationResponse> {
    const { data } = await this.request<DeviceRegistrationResponse>(
      'POST',
      '/v1/devices/register',
      { body: params, retries: 3 }
    );
    return data;
  }

  /**
   * 刷新裝置 Token
   * POST /v1/devices/refresh
   */
  async refreshToken(): Promise<{ device_token: string; expires_at: string }> {
    const { data } = await this.request<{ device_token: string; expires_at: string }>(
      'POST',
      '/v1/devices/refresh',
      { retries: 3 }
    );
    return data;
  }

  /**
   * 重置裝置（清除裝置資料）
   * POST /v1/devices/reset
   */
  async resetDevice(): Promise<void> {
    await this.request<void>('POST', '/v1/devices/reset', { retries: 1 });
  }

  // ===== 遙測 =====

  /**
   * 上傳遙測批次資料
   * POST /v1/telemetry/batch
   * Content-Type: application/msgpack
   */
  async uploadTelemetry(batchPayload: Uint8Array): Promise<void> {
    await this.request<void>('POST', '/v1/telemetry/batch', {
      body: batchPayload,
      headers: { 'Content-Type': 'application/msgpack' },
      retries: 3,
    });
  }

  /**
   * 提交使用者回饋
   * POST /v1/telemetry/feedback
   */
  async submitFeedback(feedback: TelemetryFeedback): Promise<void> {
    await this.request<void>('POST', '/v1/telemetry/feedback', {
      body: feedback,
      retries: 2,
    });
  }

  /**
   * 查詢配額使用量
   * GET /v1/telemetry/quota
   */
  async getQuota(): Promise<{ daily_limit: number; daily_used: number }> {
    const { data } = await this.request<{ daily_limit: number; daily_used: number }>(
      'GET',
      '/v1/telemetry/quota',
      { retries: 2 }
    );
    return data;
  }

  // ===== L0 =====

  /**
   * 取得 L0 公共 Key 清單
   * GET /v1/l0/keys?since=...
   */
  async getL0Keys(since?: string): Promise<L0KeysResponse> {
    const path = since ? `/v1/l0/keys?since=${encodeURIComponent(since)}` : '/v1/l0/keys';
    const { data } = await this.request<L0KeysResponse>('GET', path, { retries: 3 });
    return data;
  }

  /**
   * 上報 L0 使用紀錄
   * POST /v1/l0/usage
   */
  async reportL0Usage(entries: L0UsageEntry[]): Promise<void> {
    await this.request<void>('POST', '/v1/l0/usage', {
      body: { entries },
      retries: 3,
    });
  }

  /**
   * 捐獻 L0 Key
   * POST /v1/l0/donate
   */
  async donateL0Key(params: L0DonateRequest): Promise<void> {
    await this.request<void>('POST', '/v1/l0/donate', {
      body: params,
      retries: 1,
    });
  }

  // ===== 互助 =====

  /**
   * 發起互助請求
   * POST /v1/aid/request
   */
  async requestAid(params: AidRequest): Promise<AidAccepted> {
    const { data } = await this.request<AidAccepted>('POST', '/v1/aid/request', {
      body: params,
      retries: 2,
    });
    return data;
  }

  /**
   * 更新互助設定
   * PUT /v1/aid/config
   */
  async updateAidConfig(config: Partial<AidConfig>): Promise<void> {
    await this.request<void>('PUT', '/v1/aid/config', {
      body: config,
      retries: 2,
    });
  }

  /**
   * 取得互助設定
   * GET /v1/aid/config
   */
  async getAidConfig(): Promise<AidConfig> {
    const { data } = await this.request<AidConfig>('GET', '/v1/aid/config', { retries: 2 });
    return data;
  }

  /**
   * 取得互助統計
   * GET /v1/aid/stats
   */
  async getAidStats(): Promise<AidStats> {
    const { data } = await this.request<AidStats>('GET', '/v1/aid/stats', { retries: 2 });
    return data;
  }

  // ===== 版本 + Adapter =====

  /**
   * 檢查客戶端版本
   * GET /v1/version/check
   */
  async checkVersion(): Promise<VersionCheckResponse> {
    const { data } = await this.request<VersionCheckResponse>(
      'GET',
      '/v1/version/check',
      { retries: 2 }
    );
    return data;
  }

  /**
   * 檢查 Adapter 更新
   * GET /v1/adapters/updates?installed=a,b,c
   */
  async checkAdapterUpdates(installed: string[]): Promise<AdapterUpdatesResponse> {
    const query = installed.length > 0
      ? `?installed=${encodeURIComponent(installed.join(','))}`
      : '';
    const { data } = await this.request<AdapterUpdatesResponse>(
      'GET',
      `/v1/adapters/updates${query}`,
      { retries: 2 }
    );
    return data;
  }

  /**
   * 取得官方 Adapter 清單
   * GET /v1/adapters/official
   */
  async getOfficialAdapters(): Promise<AdapterListResponse> {
    const { data } = await this.request<AdapterListResponse>(
      'GET',
      '/v1/adapters/official',
      { retries: 2 }
    );
    return data;
  }

  // ===== 備份（v1.1+ stub）=====

  /**
   * 上傳備份
   * PUT /v1/backup
   * （v1.1+ 功能，目前為 stub）
   */
  async uploadBackup(data: Uint8Array, checksum: string): Promise<void> {
    await this.request<void>('PUT', '/v1/backup', {
      body: data,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Backup-Checksum': checksum,
      },
      retries: 2,
    });
  }

  /**
   * 下載備份
   * GET /v1/backup
   * （v1.1+ 功能，目前為 stub）
   */
  async downloadBackup(): Promise<Uint8Array> {
    const { data } = await this.request<ArrayBuffer>('GET', '/v1/backup', { retries: 2 });
    return new Uint8Array(data as ArrayBuffer);
  }

  /**
   * 刪除備份
   * DELETE /v1/backup
   * （v1.1+ 功能，目前為 stub）
   */
  async deleteBackup(): Promise<void> {
    await this.request<void>('DELETE', '/v1/backup', { retries: 1 });
  }

  /**
   * 綁定 Google 帳號
   * POST /v1/auth/google
   * （v1.1+ 功能，目前為 stub）
   */
  async bindGoogle(idToken: string, nickname?: string): Promise<void> {
    await this.request<void>('POST', '/v1/auth/google', {
      body: { google_id_token: idToken, requested_nickname: nickname },
      retries: 2,
    });
  }

  // ===== 私有輔助方法 =====

  /** 等待指定毫秒數 */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
