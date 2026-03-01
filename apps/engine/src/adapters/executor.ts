// Adapter 執行器模組
// 負責根據 AdapterConfig 執行實際的 API 呼叫
// 包含模板替換、Header 構建、回應解析

import type { AdapterConfig } from './loader';
import type { KeyPool, DecryptedKey } from '../core/key-pool';

// ===== 型別定義 =====

/** Adapter API 呼叫回應 */
export interface AdapterResponse {
  /** 是否成功 */
  success: boolean;
  /** HTTP 狀態碼 */
  status: number;
  /** 回應資料 */
  data?: unknown;
  /** 錯誤訊息（失敗時） */
  error?: string;
  /** 延遲時間（ms） */
  latency_ms: number;
}

// ===== AdapterExecutor 主類別 =====

/**
 * Adapter 執行器
 * 根據 AdapterConfig 和 DecryptedKey 執行 API 呼叫
 * 成功/失敗後自動更新 KeyPool 健康狀態
 */
export class AdapterExecutor {
  constructor(private keyPool: KeyPool) {}

  /**
   * 執行 API 呼叫
   *
   * 流程：
   * 1. 取 endpoint 定義
   * 2. 構建 URL = base_url + endpoint.path
   * 3. 構建 headers（含 auth）
   * 4. 構建 body（模板替換）
   * 5. fetch()
   * 6. 解析回應（json/sse/text）
   * 7. 根據狀態碼更新 KeyPool 健康狀態
   */
  async execute(
    adapter: AdapterConfig,
    endpointName: string,
    params: Record<string, unknown>,
    key: DecryptedKey
  ): Promise<AdapterResponse> {
    const startTime = Date.now();

    // 取得 endpoint 定義
    const endpoint = adapter.endpoints[endpointName];
    if (!endpoint) {
      return {
        success: false,
        status: 0,
        error: `Endpoint "${endpointName}" 在 Adapter "${adapter.adapter.id}" 中不存在`,
        latency_ms: Date.now() - startTime,
      };
    }

    // 構建 URL
    const url = this.buildUrl(adapter, endpointName, params, key);

    // 構建 Headers
    const headers = this.buildHeaders(adapter, endpoint.headers ?? {}, key);

    // 構建 Body
    let bodyStr: string | undefined;
    if (endpoint.body && endpoint.method !== 'GET') {
      const rendered = this.renderTemplateObject(endpoint.body, params);
      bodyStr = JSON.stringify(rendered);
      headers['Content-Type'] = 'application/json';
    }

    // 執行 fetch
    let response: Response;
    try {
      response = await fetch(url, {
        method: endpoint.method,
        headers,
        body: bodyStr,
      });
    } catch (err) {
      // 網路錯誤
      await this.keyPool.reportError(key.id);
      return {
        success: false,
        status: 0,
        error: `網路錯誤：${(err as Error).message}`,
        latency_ms: Date.now() - startTime,
      };
    }

    const latency = Date.now() - startTime;
    const status = response.status;

    // 處理認證錯誤
    if (status === 401 || status === 403) {
      await this.keyPool.reportAuthError(key.id);
      return {
        success: false,
        status,
        error: `認證失敗（${status}）`,
        latency_ms: latency,
      };
    }

    // 處理速率限制
    if (status === 429) {
      await this.keyPool.reportRateLimit(key.id);
      return {
        success: false,
        status,
        error: '速率限制（429 Too Many Requests）',
        latency_ms: latency,
      };
    }

    // 其他錯誤（5xx）
    if (status >= 500) {
      await this.keyPool.reportError(key.id);
      return {
        success: false,
        status,
        error: `伺服器錯誤（${status}）`,
        latency_ms: latency,
      };
    }

    // 成功，解析回應
    const responseType = endpoint.response_type ?? 'json';
    let data: unknown;

    try {
      if (responseType === 'json') {
        data = await response.json();
      } else if (responseType === 'sse') {
        // SSE：回傳原始文字，讓上層處理
        data = await response.text();
      } else {
        data = await response.text();
      }
    } catch (err) {
      // 解析失敗也算成功（HTTP 狀態碼 OK）
      data = null;
    }

    // 回報成功，更新 KeyPool
    await this.keyPool.reportSuccess(key.id);

    return {
      success: true,
      status,
      data,
      latency_ms: latency,
    };
  }

  // ===== URL 構建 =====

  /**
   * 構建完整的請求 URL
   * - bearer/header：直接附加 path
   * - query_param：在 URL 末尾附加 API Key 參數
   */
  buildUrl(
    adapter: AdapterConfig,
    endpointName: string,
    params: Record<string, unknown>,
    key: DecryptedKey
  ): string {
    const endpoint = adapter.endpoints[endpointName]!;
    const baseUrl = adapter.base_url.replace(/\/$/, '');
    const path = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`;

    let url = `${baseUrl}${path}`;

    // query_param 類型：把 API Key 附加到 URL
    if (adapter.auth.type === 'query_param') {
      const paramName = adapter.auth.query_param_name ?? 'key';
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${paramName}=${encodeURIComponent(key.key_value)}`;
    }

    return url;
  }

  // ===== Header 構建 =====

  /**
   * 構建請求 Headers
   * 根據 auth.type 加入認證 Header
   */
  buildHeaders(
    adapter: AdapterConfig,
    extraHeaders: Record<string, string>,
    key: DecryptedKey
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'ClawAPI/0.1',
      ...extraHeaders,
    };

    switch (adapter.auth.type) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${key.key_value}`;
        break;
      case 'header': {
        const headerName = adapter.auth.header_name ?? 'x-api-key';
        headers[headerName] = key.key_value;
        break;
      }
      case 'query_param':
        // Key 已附加到 URL，不需要 Header
        break;
      case 'none':
        // 不需要認證
        break;
    }

    return headers;
  }

  // ===== 模板替換 =====

  /**
   * 渲染模板字串
   * 支援：
   * - {{ model }} → params.model
   * - {{ messages }} → JSON.stringify(params.messages)
   * - {{ temperature | default: 0.7 }} → params.temperature ?? 0.7
   */
  renderTemplate(template: string, params: Record<string, unknown>): string {
    return template.replace(/\{\{\s*([\w.]+)(?:\s*\|\s*default:\s*([^}]+))?\s*\}\}/g, (_, key, defaultVal) => {
      const value = this.getNestedValue(params, key);

      if (value !== undefined && value !== null) {
        // 如果值是物件或陣列，序列化成 JSON
        if (typeof value === 'object') {
          return JSON.stringify(value);
        }
        return String(value);
      }

      // 使用 default 值
      if (defaultVal !== undefined) {
        return defaultVal.trim();
      }

      // 沒有值也沒有 default，保留原始模板
      return _;
    });
  }

  /**
   * 遞迴渲染物件中的所有字串模板
   */
  renderTemplateObject(
    obj: Record<string, unknown>,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        result[key] = this.renderTemplate(val, params);
      } else if (Array.isArray(val)) {
        result[key] = val.map(item =>
          typeof item === 'object' && item !== null
            ? this.renderTemplateObject(item as Record<string, unknown>, params)
            : typeof item === 'string'
            ? this.renderTemplate(item, params)
            : item
        );
      } else if (val && typeof val === 'object') {
        result[key] = this.renderTemplateObject(val as Record<string, unknown>, params);
      } else {
        result[key] = val;
      }
    }

    return result;
  }

  // ===== 輔助方法 =====

  /**
   * 取得巢狀物件的值
   * 支援點記法：'messages.0.content'
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }
}
