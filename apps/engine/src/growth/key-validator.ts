import type { AdapterConfig } from '../adapters/loader';
import type { KeyValidationResult } from './types';

/**
 * 驗證指定服務的 API Key 是否可用
 */
export async function validateKey(
  serviceId: string,
  keyValue: string,
  adapters: Map<string, AdapterConfig>
): Promise<KeyValidationResult> {
  const adapter = adapters.get(serviceId);
  if (!adapter) {
    return {
      valid: false,
      service_id: serviceId,
      error: '不支援的服務',
    };
  }

  const endpoint = adapter.endpoints['models'] ?? adapter.endpoints['chat'];
  if (!endpoint) {
    return {
      valid: false,
      service_id: serviceId,
      error: '服務未提供可驗證端點',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = new URL(endpoint.path, adapter.base_url);
    const headers = new Headers(endpoint.headers ?? {});

    if (adapter.auth.type === 'bearer') {
      headers.set('Authorization', `Bearer ${keyValue}`);
    } else if (adapter.auth.type === 'header') {
      const headerName = adapter.auth.header_name ?? 'x-api-key';
      headers.set(headerName, keyValue);
    } else if (adapter.auth.type === 'query_param') {
      const paramName = adapter.auth.query_param_name ?? 'api_key';
      url.searchParams.set(paramName, keyValue);
    }

    const method = endpoint.method;
    const reqInit: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (method !== 'GET') {
      reqInit.body = JSON.stringify({ model: 'health-check', messages: [] });
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
    }

    const res = await fetch(url, reqInit);
    if (res.status === 200) {
      let modelsAvailable: string[] | undefined;
      if (endpoint === adapter.endpoints['models']) {
        try {
          const body = await res.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
          if (Array.isArray(body.data)) {
            modelsAvailable = body.data
              .map(item => item.id)
              .filter((id): id is string => typeof id === 'string' && id.length > 0);
          } else if (Array.isArray(body.models)) {
            modelsAvailable = body.models
              .map(item => item.name)
              .filter((name): name is string => typeof name === 'string' && name.length > 0);
          }
        } catch {
          // models 解析失敗不影響有效性
        }
      }

      return {
        valid: true,
        service_id: serviceId,
        models_available: modelsAvailable,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        valid: false,
        service_id: serviceId,
        error: `認證失敗（HTTP ${res.status}）`,
      };
    }

    if (res.status === 429) {
      return {
        valid: true,
        service_id: serviceId,
        error: '目前遇到限速（HTTP 429），但 Key 仍視為有效',
      };
    }

    // 嘗試讀取 response body 以取得更精確的錯誤訊息
    // 某些服務（如 Gemini）對無效 Key 回 400 而非 401
    // 也可能回 400 + RATE_LIMIT_EXCEEDED（而不是 429）
    let bodyMessage = '';
    let isAuthError = false;
    let isRateLimit = false;
    try {
      const body = await res.json() as {
        error?: { message?: string; reason?: string; details?: Array<{ reason?: string }> };
        message?: string;
      };
      // 提取錯誤訊息
      bodyMessage = body.error?.message ?? body.message ?? '';
      // 偵測是否為認證類錯誤（Gemini 回 400 + API_KEY_INVALID）
      const reason = body.error?.reason ?? '';
      const detailReasons = body.error?.details?.map(d => d.reason).join(',') ?? '';
      const allReasons = `${reason},${detailReasons}`.toLowerCase();

      // 先檢查是否為 rate limit（某些服務回 400 而非 429）
      if (
        allReasons.includes('rate_limit_exceeded') ||
        allReasons.includes('resource_exhausted') ||
        bodyMessage.toLowerCase().includes('rate limit') ||
        bodyMessage.toLowerCase().includes('quota exceeded') ||
        bodyMessage.toLowerCase().includes('too many requests')
      ) {
        isRateLimit = true;
      } else if (
        allReasons.includes('api_key_invalid') ||
        allReasons.includes('unauthorized') ||
        bodyMessage.toLowerCase().includes('api key not valid') ||
        bodyMessage.toLowerCase().includes('invalid api key') ||
        bodyMessage.toLowerCase().includes('invalid authentication')
      ) {
        isAuthError = true;
      }
    } catch {
      // body 解析失敗不影響判斷
    }

    // Rate limit（非 429 的限速）視為 Key 有效但暫時不可用
    if (isRateLimit) {
      return {
        valid: true,
        service_id: serviceId,
        error: `目前遇到限速（HTTP ${res.status}），但 Key 仍視為有效`,
      };
    }

    if (isAuthError) {
      return {
        valid: false,
        service_id: serviceId,
        error: `認證失敗（HTTP ${res.status}）：API Key 無效`,
      };
    }

    return {
      valid: false,
      service_id: serviceId,
      error: bodyMessage
        ? `驗證失敗（HTTP ${res.status}）：${bodyMessage}`
        : `驗證失敗（HTTP ${res.status}）`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        valid: false,
        service_id: serviceId,
        error: '驗證逾時（5 秒）',
      };
    }

    return {
      valid: false,
      service_id: serviceId,
      error: `驗證請求失敗：${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

