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

    // 轉換訊息格式（Gemini/Anthropic 需要不同格式）
    const preparedParams = this.prepareParams(adapter, params);

    // 構建 URL（用 preparedParams 確保模板中的 model 等已正確）
    const url = this.buildUrl(adapter, endpointName, preparedParams, key);

    // 構建 Headers
    const headers = this.buildHeaders(adapter, endpoint.headers ?? {}, key);

    // 構建 Body
    let bodyStr: string | undefined;
    if (endpoint.body && endpoint.method !== 'GET') {
      const rendered = this.renderTemplateObject(endpoint.body, preparedParams);
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

    // 其他客戶端錯誤（400, 404, 405, 409, 413, 422 等）
    if (status >= 400) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        try { errorBody = await response.text(); } catch { errorBody = null; }
      }
      // 提取錯誤訊息
      let errorMsg = `客戶端錯誤（${status}）`;
      if (errorBody && typeof errorBody === 'object') {
        const eb = errorBody as Record<string, unknown>;
        // 嘗試各種 API 的錯誤格式
        const errField = eb['error'];
        const msg = eb['message']
          ?? (typeof errField === 'object' && errField !== null ? (errField as Record<string, unknown>)['message'] : undefined)
          ?? (typeof errField === 'string' ? errField : undefined);
        if (typeof msg === 'string') errorMsg = `${status}: ${msg}`;
      }
      return {
        success: false,
        status,
        error: errorMsg,
        data: errorBody,
        latency_ms: latency,
      };
    }

    // 成功（2xx / 3xx），解析回應
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
    // 渲染 path 中的模板（如 Gemini 的 /v1beta/models/{{ model }}:generateContent）
    const renderedPath = this.renderTemplate(endpoint.path, params);
    const path = renderedPath.startsWith('/') ? renderedPath : `/${renderedPath}`;

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

  // ===== 訊息格式轉換 =====

  /**
   * 根據 Adapter 類型轉換請求參數
   *
   * OpenAI 格式（輸入標準）：
   *   messages: [{ role: "system"|"user"|"assistant", content: "..." }]
   *
   * Gemini 格式：
   *   messages → contents: [{ role: "user"|"model", parts: [{ text: "..." }] }]
   *   system messages → system_instruction: { parts: [{ text: "..." }] }
   *
   * Anthropic 格式：
   *   system messages → system: "..."（獨立欄位）
   *   其他 messages 保持原樣
   */
  prepareParams(
    adapter: AdapterConfig,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const messages = params['messages'] as Array<{ role: string; content: string | null }> | undefined;
    if (!messages || !Array.isArray(messages)) return params;

    const adapterId = adapter.adapter.id;

    switch (adapterId) {
      case 'gemini': {
        const newParams = { ...params };
        // 轉換訊息為 Gemini 格式：role "assistant" → "model"，content → parts[].text
        newParams['messages'] = messages
          .filter(m => m.role !== 'system')
          .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content || '' }],
          }));
        // 提取 system 訊息到 systemInstruction
        const systemMsgs = messages.filter(m => m.role === 'system');
        if (systemMsgs.length > 0) {
          newParams['system_instruction'] = {
            parts: [{ text: systemMsgs.map(m => m.content || '').join('\n') }],
          };
        }
        return newParams;
      }

      case 'anthropic': {
        const newParams = { ...params };
        // 過濾掉 system 訊息（Anthropic 需要獨立的 system 欄位）
        newParams['messages'] = messages.filter(m => m.role !== 'system');
        // 提取 system 訊息
        const systemMsgs = messages.filter(m => m.role === 'system');
        if (systemMsgs.length > 0) {
          newParams['system'] = systemMsgs.map(m => m.content || '').join('\n');
        }
        return newParams;
      }

      default:
        // OpenAI 相容（groq, openai, deepseek, cerebras, sambanova, qwen, openrouter, ollama）
        // 不需要轉換
        return params;
    }
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
   *
   * 重要修正：「純模板」（整個值只有一個 {{ param }}）保留原始型別
   * - "{{ messages }}" → 直接使用陣列（不會變成 JSON 字串）
   * - "{{ temperature | default: 0.7 }}" → 保留數字型別
   * - "Bearer {{ token }}" → 混合模板，結果為字串（原有行為）
   */
  renderTemplateObject(
    obj: Record<string, unknown>,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // 純模板正則：整個值就是一個 {{ param }} 或 {{ param | default: value }}
    const pureTemplateRegex = /^\{\{\s*([\w.]+)(?:\s*\|\s*default:\s*([^}]+))?\s*\}\}$/;

    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        const pureMatch = val.match(pureTemplateRegex);
        if (pureMatch) {
          // 純模板：保留原始型別
          const paramKey = pureMatch[1]!;
          const defaultStr = pureMatch[2];
          const rawValue = this.getNestedValue(params, paramKey);

          if (rawValue !== undefined && rawValue !== null) {
            result[key] = rawValue;
          } else if (defaultStr !== undefined) {
            // 嘗試解析 default 為原始型別（數字、布林、null）
            const trimmed = defaultStr.trim();
            try {
              result[key] = JSON.parse(trimmed);
            } catch {
              result[key] = trimmed;
            }
          }
          // 若無值也無 default → 不加入 result（省略該欄位）
        } else {
          // 混合模板或靜態字串：結果為字串
          const rendered = this.renderTemplate(val, params);
          // 如果渲染後仍含未替換模板且不是靜態文字，跳過
          if (rendered !== val || !val.includes('{{')) {
            result[key] = rendered;
          }
        }
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
