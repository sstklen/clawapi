// ClawAPI 簡化 API 路由
// 提供比 OpenAI 格式更簡單的呼叫介面，適合快速整合
//
// 支援端點：
//   POST /api/llm         簡化版 LLM 呼叫
//   POST /api/search      簡化版搜尋
//   POST /api/translate   簡化版翻譯
//   POST /api/ask         L3 AI 管家入口
//   POST /api/task        L4 任務引擎入口

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Router } from '../core/router';

// ===== 型別定義 =====

/** POST /api/llm 請求體 */
export interface LlmRequest {
  /** 提示文字（必填） */
  prompt: string;
  /** 模型名稱（'auto' 讓系統自動選擇，或指定 'groq/llama3' 直轉） */
  model?: string;
  /** 額外選項 */
  options?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
  };
}

/** POST /api/llm 回應體 */
export interface LlmResponse {
  /** 回傳文字 */
  text: string;
  /** 實際使用的模型（含服務前綴，如 'groq/llama3'） */
  model: string;
  /** Token 用量 */
  tokens: number;
  /** 端到端延遲（ms） */
  latency_ms: number;
}

/** POST /api/search 請求體 */
export interface SearchRequest {
  /** 搜尋關鍵字（必填） */
  query: string;
  /** 語言（如 'zh-TW', 'en'） */
  lang?: string;
  /** 最多回傳幾筆結果 */
  limit?: number;
}

/** 單筆搜尋結果 */
export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** POST /api/search 回應體 */
export interface SearchResponse {
  /** 搜尋結果清單 */
  results: SearchResult[];
  /** 使用的搜尋來源 */
  source: string;
  /** 端到端延遲（ms） */
  latency_ms: number;
}

/** POST /api/translate 請求體 */
export interface TranslateRequest {
  /** 原始文字（必填） */
  text: string;
  /** 來源語言（如 'en'，不填讓系統自動偵測） */
  from?: string;
  /** 目標語言（如 'zh-TW'，必填） */
  to: string;
}

/** POST /api/translate 回應體 */
export interface TranslateResponse {
  /** 翻譯後的文字 */
  translated: string;
  /** 使用的翻譯服務 */
  source: string;
  /** 端到端延遲（ms） */
  latency_ms: number;
}

/** POST /api/ask 請求體 */
export interface AskRequest {
  /** 問題或指令（必填） */
  message: string;
  /** 對話歷史（選填） */
  history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

/** POST /api/ask 回應體 */
export interface AskResponse {
  /** AI 回應文字 */
  answer: string;
  /** 端到端延遲（ms） */
  latency_ms: number;
}

/** POST /api/task 請求體 */
export interface TaskRequest {
  /** 任務描述（必填） */
  task: string;
  /** 任務參數（選填） */
  params?: Record<string, unknown>;
}

/** POST /api/task 回應體 */
export interface TaskResponse {
  /** 任務結果 */
  result: string;
  /** 端到端延遲（ms） */
  latency_ms: number;
}

// ===== 輔助函式 =====

/**
 * 從 Router 回應中提取文字內容
 * 嘗試解析 OpenAI 格式的 choices[0].message.content
 */
function extractTextFromRouteData(data: unknown): string {
  if (typeof data === 'string') return data;

  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;

    // OpenAI 格式：choices[0].message.content
    if (Array.isArray(d['choices']) && d['choices'].length > 0) {
      const choice = d['choices'][0] as Record<string, unknown>;
      const msg = choice['message'] as Record<string, unknown> | undefined;
      if (msg && typeof msg['content'] === 'string') {
        return msg['content'];
      }
    }

    // 直接的 text 或 content 欄位
    if (typeof d['text'] === 'string') return d['text'];
    if (typeof d['content'] === 'string') return d['content'];
    if (typeof d['answer'] === 'string') return d['answer'];
    if (typeof d['result'] === 'string') return d['result'];
  }

  return '';
}

/**
 * 從 Router 回應中提取 Token 用量
 */
function extractTokensFromRouteData(data: unknown): number {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d['usage'] && typeof d['usage'] === 'object') {
      const u = d['usage'] as Record<string, unknown>;
      if (typeof u['total_tokens'] === 'number') return u['total_tokens'];
      if (typeof u['completion_tokens'] === 'number') {
        const inputTokens = typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0;
        return inputTokens + u['completion_tokens'];
      }
    }
  }
  return 0;
}

// ===== 主路由工廠 =====

/**
 * 建立 ClawAPI 簡化 API 路由器
 *
 * 這組端點提供比 OpenAI 格式更簡單的介面，
 * 內部透過 Router 的 routeRequest 處理，
 * 輸入輸出格式針對常見使用情境最佳化。
 *
 * @param router ClawAPI 路由主控
 * @returns Hono 路由實例（掛載到 /api 下）
 */
export function createClawAPIRouter(router: Router): Hono {
  const app = new Hono();

  // =========================================================
  // POST /api/llm — 簡化版 LLM 呼叫
  // =========================================================
  app.post('/llm', async (c: Context) => {
    let body: LlmRequest;
    try {
      body = await c.req.json<LlmRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    // 驗證必填欄位
    if (!body.prompt || typeof body.prompt !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：prompt' }, 400);
    }

    // 使用 'auto' 作為預設模型（L2 智慧路由）
    const model = body.model ?? 'auto';

    // 轉換成 Router 格式的 RouteRequest
    let result;
    try {
      result = await router.routeRequest({
        model,
        params: {
          messages: [
            { role: 'user', content: body.prompt },
          ],
          temperature: body.options?.temperature,
          max_tokens: body.options?.max_tokens,
          top_p: body.options?.top_p,
        },
      });
    } catch (err) {
      return c.json(
        { error: 'internal_error', message: `路由錯誤：${(err as Error).message}` },
        500
      );
    }

    if (!result.success) {
      return c.json(
        { error: 'routing_failed', message: result.error ?? '路由失敗' },
        (result.status ?? 502) as 400 | 500 | 502
      );
    }

    // 轉換回應格式：Router 結果 → 簡化 LlmResponse
    const text = extractTextFromRouteData(result.data);
    const tokens = extractTokensFromRouteData(result.data);

    // 組合模型顯示名稱：serviceId/modelName 或 model
    const actualModel = result.serviceId && result.modelName
      ? `${result.serviceId}/${result.modelName}`
      : result.modelName ?? model;

    const response: LlmResponse = {
      text,
      model: actualModel,
      tokens,
      latency_ms: result.latency_ms,
    };

    return c.json(response);
  });

  // =========================================================
  // POST /api/search — 簡化版搜尋
  // =========================================================
  app.post('/search', async (c: Context) => {
    let body: SearchRequest;
    try {
      body = await c.req.json<SearchRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    // 驗證必填欄位
    if (!body.query || typeof body.query !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：query' }, 400);
    }

    // 搜尋走 L2 自動路由，指定 search 相關的服務
    let result;
    try {
      result = await router.routeRequest({
        model: 'auto',
        params: {
          type: 'search',
          query: body.query,
          lang: body.lang ?? 'zh-TW',
          limit: body.limit ?? 5,
          messages: [
            {
              role: 'user',
              content: `搜尋：${body.query}${body.lang ? `（語言：${body.lang}）` : ''}`,
            },
          ],
        },
      });
    } catch (err) {
      return c.json(
        { error: 'internal_error', message: `路由錯誤：${(err as Error).message}` },
        500
      );
    }

    if (!result.success) {
      return c.json(
        { error: 'routing_failed', message: result.error ?? '路由失敗' },
        (result.status ?? 502) as 400 | 500 | 502
      );
    }

    // 從回應中提取搜尋結果
    let results: SearchResult[] = [];
    const backendData = result.data;

    if (backendData && typeof backendData === 'object') {
      const d = backendData as Record<string, unknown>;

      // 嘗試解析 results 陣列
      if (Array.isArray(d['results'])) {
        results = (d['results'] as unknown[]).map(item => {
          if (typeof item === 'object' && item !== null) {
            const r = item as Record<string, unknown>;
            return {
              title: typeof r['title'] === 'string' ? r['title'] : '',
              url: typeof r['url'] === 'string' ? r['url'] : '',
              snippet: typeof r['snippet'] === 'string' ? r['snippet'] : undefined,
            };
          }
          return { title: '', url: '' };
        });
      }
    }

    const response: SearchResponse = {
      results,
      source: result.serviceId ?? 'auto',
      latency_ms: result.latency_ms,
    };

    return c.json(response);
  });

  // =========================================================
  // POST /api/translate — 簡化版翻譯
  // =========================================================
  app.post('/translate', async (c: Context) => {
    let body: TranslateRequest;
    try {
      body = await c.req.json<TranslateRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    // 驗證必填欄位
    if (!body.text || typeof body.text !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：text' }, 400);
    }
    if (!body.to || typeof body.to !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：to（目標語言）' }, 400);
    }

    // 組裝翻譯提示（透過 LLM 翻譯）
    const fromHint = body.from ? `從 ${body.from} 翻譯` : '翻譯';
    const prompt = `請${fromHint}成 ${body.to}，只輸出翻譯結果，不要加任何說明或標點符號之外的額外文字：\n\n${body.text}`;

    let result;
    try {
      result = await router.routeRequest({
        model: 'auto',
        params: {
          type: 'translate',
          from: body.from,
          to: body.to,
          text: body.text,
          messages: [
            { role: 'user', content: prompt },
          ],
        },
      });
    } catch (err) {
      return c.json(
        { error: 'internal_error', message: `路由錯誤：${(err as Error).message}` },
        500
      );
    }

    if (!result.success) {
      return c.json(
        { error: 'routing_failed', message: result.error ?? '路由失敗' },
        (result.status ?? 502) as 400 | 500 | 502
      );
    }

    const translated = extractTextFromRouteData(result.data);

    const response: TranslateResponse = {
      translated,
      source: result.serviceId ?? 'auto',
      latency_ms: result.latency_ms,
    };

    return c.json(response);
  });

  // =========================================================
  // POST /api/ask — L3 AI 管家入口
  // =========================================================
  app.post('/ask', async (c: Context) => {
    let body: AskRequest;
    try {
      body = await c.req.json<AskRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    // 驗證必填欄位
    if (!body.message || typeof body.message !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：message' }, 400);
    }

    // 組裝對話歷史
    const messages: Array<{ role: string; content: string }> = [];

    // 加入歷史訊息
    if (Array.isArray(body.history)) {
      for (const h of body.history) {
        messages.push({ role: h.role, content: h.content });
      }
    }

    // 加入當前訊息
    messages.push({ role: 'user', content: body.message });

    // 使用 model='ask' → Router 判斷走 L3
    let result;
    try {
      result = await router.routeRequest({
        model: 'ask',
        params: { messages },
      });
    } catch (err) {
      return c.json(
        { error: 'internal_error', message: `路由錯誤：${(err as Error).message}` },
        500
      );
    }

    if (!result.success) {
      return c.json(
        { error: 'routing_failed', message: result.error ?? '路由失敗' },
        (result.status ?? 502) as 400 | 500 | 502
      );
    }

    const answer = extractTextFromRouteData(result.data);

    const response: AskResponse = {
      answer,
      latency_ms: result.latency_ms,
    };

    return c.json(response);
  });

  // =========================================================
  // POST /api/task — L4 任務引擎入口
  // =========================================================
  app.post('/task', async (c: Context) => {
    let body: TaskRequest;
    try {
      body = await c.req.json<TaskRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    // 驗證必填欄位
    if (!body.task || typeof body.task !== 'string') {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：task' }, 400);
    }

    // 使用 model='task' → Router 判斷走 L4
    let result;
    try {
      result = await router.routeRequest({
        model: 'task',
        params: {
          task: body.task,
          params: body.params ?? {},
          messages: [
            { role: 'user', content: body.task },
          ],
        },
      });
    } catch (err) {
      // L4 目前為 stub，會拋出明確錯誤
      return c.json(
        { error: 'not_implemented', message: `L4 任務引擎尚未實作：${(err as Error).message}` },
        501
      );
    }

    if (!result.success) {
      return c.json(
        { error: 'routing_failed', message: result.error ?? '路由失敗' },
        (result.status ?? 502) as 400 | 500 | 502
      );
    }

    const taskResult = extractTextFromRouteData(result.data);

    const response: TaskResponse = {
      result: taskResult,
      latency_ms: result.latency_ms,
    };

    return c.json(response);
  });

  return app;
}

export default createClawAPIRouter;
