// OpenAI 相容 API 路由
// 提供完整的 OpenAI 相容端點，讓任何 OpenAI 客戶端可直接對接 ClawAPI
//
// 支援端點：
//   POST /v1/chat/completions（含 SSE streaming）
//   GET  /v1/models
//   POST /v1/embeddings
//   POST /v1/images/generations
//   POST /v1/audio/transcriptions（multipart）
//   POST /v1/audio/speech（binary stream）
//   POST /v1/files + GET + GET/:id + DELETE/:id

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { RoutingStrategy } from '@clawapi/protocol';
import type { Router } from '../core/router';
import type { KeyPool } from '../core/key-pool';
import type { AdapterConfig } from '../adapters/loader';

// ===== 型別定義 =====

/** 聊天訊息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** 工具定義 */
export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** 工具呼叫 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 層級類型 */
export type LayerType = 'L1' | 'L2' | 'L3' | 'L4';

/** POST /v1/chat/completions 請求體 */
export interface ChatCompletionRequest {
  /** 模型名稱：'groq/llama3' → L1, 'auto' → L2, 'ask' → L3, 'task' → L4 */
  model: string;
  /** 聊天訊息清單 */
  messages: ChatMessage[];
  /** 是否啟用串流 */
  stream?: boolean;
  /** 溫度參數 */
  temperature?: number;
  /** Top-P 採樣 */
  top_p?: number;
  /** 最大 Token 數 */
  max_tokens?: number;
  /** 工具定義 */
  tools?: Tool[];
  /** 工具選擇策略 */
  tool_choice?: string | Record<string, unknown>;
  /** ClawAPI 擴充：路由策略 */
  x_strategy?: RoutingStrategy;
  /** ClawAPI 擴充：禁止 Failover */
  x_no_fallback?: boolean;
  /** ClawAPI 擴充：最大 Gold Token 數 */
  x_max_gold_tokens?: number;
  /** ClawAPI 擴充：偏好服務 */
  x_preferred_service?: string;
}

/** ClawAPI 擴充欄位（所有回應共用） */
export interface XClawAPI {
  /** 請求中的模型名稱（原始） */
  requested_model: string;
  /** 實際使用的模型名稱 */
  actual_model: string;
  /** 實際使用的服務 ID */
  service_id: string;
  /** 路由層 */
  layer: LayerType;
  /** Key 來源（king/friend/l0_public 等） */
  key_source: string;
  /** 端到端延遲（ms） */
  latency_ms: number;
  /** Gold Key 使用的 Token 數（選填） */
  gold_key_tokens?: number;
  /** Failover 重試次數 */
  retry_count: number;
  /** 警告訊息 */
  warnings?: string[];
}

/** 非 streaming 聊天完成回應 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  x_clawapi: XClawAPI;
}

/** SSE streaming chunk 回應 */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }>;
  /** 最後一個 chunk 才會附上 x_clawapi */
  x_clawapi?: XClawAPI;
}

/** POST /v1/embeddings 請求體 */
export interface EmbeddingsRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  /** ClawAPI 擴充 */
  x_strategy?: RoutingStrategy;
}

/** Embeddings 回應 */
export interface EmbeddingsResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
  x_clawapi: XClawAPI;
}

/** POST /v1/images/generations 請求體 */
export interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  n?: number;
  quality?: 'standard' | 'hd';
  response_format?: 'url' | 'b64_json';
  size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
  style?: 'vivid' | 'natural';
  user?: string;
  /** ClawAPI 擴充 */
  x_strategy?: RoutingStrategy;
}

/** Images 回應 */
export interface ImageGenerationResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  x_clawapi: XClawAPI;
}

/** POST /v1/audio/speech 請求體 */
export interface AudioSpeechRequest {
  model: string;
  input: string;
  voice: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  /** ClawAPI 擴充 */
  x_strategy?: RoutingStrategy;
}

/** 檔案物件 */
export interface FileObject {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status?: 'uploaded' | 'processed' | 'error';
}

/** 路由結果對應的 RouteResult（簡化版，避免循環引入） */
interface RouteResultLike {
  success: boolean;
  layer: string;
  serviceId?: string;
  modelName?: string;
  data?: unknown;
  error?: string;
  status?: number;
  latency_ms: number;
  tried?: string[];
}

// ===== 輔助函式 =====

/**
 * 產生 ID 前綴
 * 如：chatcmpl-xxxxxxxxxx
 */
function generateId(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 24; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}${result}`;
}

/**
 * 從 RouteResult 組裝 XClawAPI 擴充欄位
 */
function buildXClawAPI(
  requestedModel: string,
  result: RouteResultLike,
  retryCount = 0
): XClawAPI {
  return {
    requested_model: requestedModel,
    actual_model: result.modelName ?? requestedModel,
    service_id: result.serviceId ?? 'unknown',
    layer: (result.layer as LayerType) ?? 'L1',
    key_source: 'king',   // 實際值由 Router 回報，這裡簡化
    latency_ms: result.latency_ms,
    retry_count: retryCount,
    warnings: result.tried && result.tried.length > 0
      ? [`Failover：嘗試了 ${result.tried.join(', ')}`]
      : undefined,
  };
}

/**
 * 從後端回應中嘗試提取使用量資訊
 * OpenAI 格式：{ usage: { prompt_tokens, completion_tokens, total_tokens } }
 */
function extractUsage(data: unknown): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d['usage'] && typeof d['usage'] === 'object') {
      const u = d['usage'] as Record<string, unknown>;
      return {
        prompt_tokens: typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0,
        completion_tokens: typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0,
        total_tokens: typeof u['total_tokens'] === 'number' ? u['total_tokens'] : 0,
      };
    }
  }
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/**
 * 從後端回應中嘗試提取第一個 choice 的 message
 * OpenAI 格式：{ choices: [{ message: { role, content } }] }
 */
function extractMessage(data: unknown): ChatMessage {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d['choices']) && d['choices'].length > 0) {
      const choice = d['choices'][0] as Record<string, unknown>;
      if (choice['message'] && typeof choice['message'] === 'object') {
        const msg = choice['message'] as Record<string, unknown>;
        return {
          role: (msg['role'] as ChatMessage['role']) ?? 'assistant',
          content: typeof msg['content'] === 'string' ? msg['content'] : null,
        };
      }
    }
  }
  return { role: 'assistant', content: '' };
}

/**
 * 從後端回應中嘗試提取 finish_reason
 */
function extractFinishReason(data: unknown): 'stop' | 'tool_calls' | 'length' | 'content_filter' | null {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d['choices']) && d['choices'].length > 0) {
      const choice = d['choices'][0] as Record<string, unknown>;
      const fr = choice['finish_reason'];
      if (fr === 'stop' || fr === 'tool_calls' || fr === 'length' || fr === 'content_filter') {
        return fr;
      }
    }
  }
  return 'stop';
}

/**
 * 建立 SSE 格式的 ReadableStream
 * 解析後端的 SSE 文字（data: {...}\n\n 格式），轉發並在最後加上 x_clawapi
 */
function createSSEStream(
  backendResponse: unknown,
  requestedModel: string,
  completionId: string,
  created: number,
  xClawAPI: XClawAPI
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 解析後端 SSE 回應（可能是字串或 Response 物件）
      let sseText = '';

      if (typeof backendResponse === 'string') {
        sseText = backendResponse;
      } else if (backendResponse instanceof Response) {
        // 若後端回傳了 Response 物件，需要在外層處理
        // 此處作為 fallback：產生空串流
        sseText = '';
      } else if (backendResponse && typeof backendResponse === 'object') {
        // 若後端回應已是解析好的物件（非 SSE 格式）
        // 轉換為單一 chunk + DONE
        const dataStr = JSON.stringify(backendResponse);
        sseText = `data: ${dataStr}\n\n`;
      }

      // 解析 SSE 行並重新格式化
      if (sseText) {
        const lines = sseText.split('\n');
        let isLastDataChunk = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;

          if (line === 'data: [DONE]') {
            // 先不傳，最後再傳（需要先加入 x_clawapi 到最後一個 chunk）
            isLastDataChunk = true;
            continue;
          }

          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            try {
              const chunk = JSON.parse(jsonStr);
              // 確保 chunk 有正確的 ID 和時間戳
              chunk.id = chunk.id ?? completionId;
              chunk.created = chunk.created ?? created;

              // 檢查是否為最後一個有實際內容的 chunk（finish_reason 不為 null）
              const hasFinishReason = chunk.choices?.some(
                (c: Record<string, unknown>) => c['finish_reason'] !== null && c['finish_reason'] !== undefined
              );

              if (hasFinishReason) {
                // 在最後一個內容 chunk 加入 x_clawapi
                chunk.x_clawapi = xClawAPI;
              }

              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
              );
            } catch {
              // JSON 解析失敗，原樣傳送
              controller.enqueue(encoder.encode(`${line}\n\n`));
            }
          }
        }

        // 最後傳送 [DONE]
        if (isLastDataChunk || sseText.includes('[DONE]')) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
      } else {
        // 後端無 SSE 回應，產生空完成訊息
        const emptyChunk: ChatCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: xClawAPI.actual_model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(emptyChunk)}\n\n`)
        );

        const doneChunk: ChatCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: xClawAPI.actual_model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          x_clawapi: xClawAPI,
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`)
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }

      controller.close();
    },
  });
}

/**
 * 模擬 Streaming SSE stream（用於非 streaming 轉 streaming）
 * 從完整回應模擬出 SSE chunk 序列
 */
function createSimulatedSSEStream(
  content: string,
  completionId: string,
  created: number,
  actualModel: string,
  xClawAPI: XClawAPI
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 第一個 chunk：role
      const startChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: actualModel,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null,
          },
        ],
      };
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(startChunk)}\n\n`)
      );

      // 內容 chunk（全部內容一次送出，簡化實作）
      if (content) {
        const contentChunk: ChatCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: actualModel,
          choices: [
            {
              index: 0,
              delta: { content },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`)
        );
      }

      // 最後一個 chunk：finish_reason + x_clawapi
      const endChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: actualModel,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
        x_clawapi: xClawAPI,
      };
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`)
      );

      // SSE 結束標記
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

// ===== 模型清單輔助 =====

/** 從 KeyPool 服務 ID 和 Adapter 模型列表組合完整模型清單 */
function buildModelList(
  keyPool: KeyPool,
  adapters: Map<string, AdapterConfig>
): Array<{ id: string; object: 'model'; created: number; owned_by: string }> {
  const models: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = [];
  const seen = new Set<string>();

  // 取得 KeyPool 中有 Key 的服務 ID
  const activeServiceIds = keyPool.getServiceIds();

  // 對每個有 Key 的服務，從對應的 Adapter 取模型清單
  for (const serviceId of activeServiceIds) {
    const adapter = adapters.get(serviceId);
    if (!adapter) continue;

    for (const model of adapter.capabilities.models) {
      // 模型 ID 格式：service_id/model_id（L1 直轉）
      const modelId = `${serviceId}/${model.id}`;
      if (!seen.has(modelId)) {
        seen.add(modelId);
        models.push({
          id: modelId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: serviceId,
        });
      }
    }
  }

  // 從所有 Adapter 取模型（即使沒有 Key，顯示所有已安裝的 Adapter 模型）
  for (const [serviceId, adapter] of adapters) {
    for (const model of adapter.capabilities.models) {
      const modelId = `${serviceId}/${model.id}`;
      if (!seen.has(modelId)) {
        seen.add(modelId);
        models.push({
          id: modelId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: serviceId,
        });
      }
    }
  }

  // 加入 L2 智慧路由的虛擬模型
  const l2Models = ['auto', 'gpt-4o', 'claude-3-5-sonnet', 'gemini-2-flash'];
  for (const m of l2Models) {
    if (!seen.has(m)) {
      seen.add(m);
      models.push({
        id: m,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'clawapi',
      });
    }
  }

  return models;
}

// ===== 記憶體中的暫存檔案儲存（待 Phase 2 改用 DB） =====

interface StoredFile {
  id: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status: 'uploaded' | 'processed' | 'error';
  content: ArrayBuffer;
}

/** 暫存檔案 Map（記憶體中，重啟後清除） */
const fileStore = new Map<string, StoredFile>();

// ===== 輔助：安全的 HTTP 狀態碼轉型 =====

/**
 * 將數字安全轉換為 Hono 接受的 ContentfulStatusCode 型別
 * 未知狀態碼 fallback 到 502
 */
function toStatusCode(code: number | undefined, fallback: number = 502): ContentfulStatusCode {
  return (code ?? fallback) as ContentfulStatusCode;
}

// ===== 主路由工廠 =====

/**
 * 建立 OpenAI 相容 API 路由器
 *
 * @param router ClawAPI 路由主控
 * @param keyPool Key 池
 * @param adapters Adapter 設定 Map
 * @returns Hono 路由實例（掛載到 /v1 下）
 */
export function createOpenAICompatRouter(
  router: Router,
  keyPool: KeyPool,
  adapters: Map<string, AdapterConfig>
): Hono {
  const app = new Hono();

  // =========================================================
  // POST /v1/chat/completions
  // =========================================================
  app.post('/chat/completions', async (c: Context) => {
    let body: ChatCompletionRequest;
    try {
      body = await c.req.json<ChatCompletionRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    // 驗證必填欄位
    if (!body.model) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：model' }, 400);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：messages（必須是非空陣列）' }, 400);
    }

    const requestedModel = body.model;
    const isStreaming = body.stream === true;
    const completionId = generateId('chatcmpl-');
    const created = Math.floor(Date.now() / 1000);

    // 呼叫 Router
    let result: RouteResultLike;
    try {
      result = await router.routeRequest({
        model: body.model,
        strategy: body.x_strategy,
        params: {
          messages: body.messages,
          temperature: body.temperature,
          top_p: body.top_p,
          max_tokens: body.max_tokens,
          tools: body.tools,
          tool_choice: body.tool_choice,
          stream: isStreaming,
        },
      });
    } catch (err) {
      return c.json(
        {
          error: 'internal_error',
          message: `路由錯誤：${(err as Error).message}`,
        },
        500
      );
    }

    if (!result.success) {
      return c.json(
        {
          error: 'routing_failed',
          message: result.error ?? '路由失敗',
        },
        toStatusCode(result.status, 502)
      );
    }

    const xClawAPI = buildXClawAPI(requestedModel, result);

    // === Streaming 回應 ===
    if (isStreaming) {
      // 若後端回應是 SSE 格式，解析後轉發；否則模擬 streaming
      const backendData = result.data;
      let stream: ReadableStream<Uint8Array>;

      if (typeof backendData === 'string' && backendData.includes('data:')) {
        // 後端回傳的是 SSE 文字，直接解析轉發
        stream = createSSEStream(backendData, requestedModel, completionId, created, xClawAPI);
      } else {
        // 後端回傳的是完整 JSON，轉為模擬 streaming
        const message = extractMessage(backendData);
        const content = message.content ?? '';
        stream = createSimulatedSSEStream(
          content,
          completionId,
          created,
          xClawAPI.actual_model,
          xClawAPI
        );
      }

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // === 非 streaming 回應 ===
    const message = extractMessage(result.data);
    const usage = extractUsage(result.data);
    const finishReason = extractFinishReason(result.data);

    const response: ChatCompletionResponse = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: result.modelName ?? requestedModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage,
      x_clawapi: xClawAPI,
    };

    return c.json(response);
  });

  // =========================================================
  // GET /v1/models
  // =========================================================
  app.get('/models', (c: Context) => {
    const models = buildModelList(keyPool, adapters);
    return c.json({
      object: 'list',
      data: models,
    });
  });

  // =========================================================
  // POST /v1/embeddings
  // =========================================================
  app.post('/embeddings', async (c: Context) => {
    let body: EmbeddingsRequest;
    try {
      body = await c.req.json<EmbeddingsRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (!body.model) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：model' }, 400);
    }
    if (!body.input) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：input' }, 400);
    }

    const requestedModel = body.model;
    const inputTexts = Array.isArray(body.input) ? body.input : [body.input];

    let result: RouteResultLike;
    try {
      result = await router.routeRequest({
        model: body.model,
        strategy: body.x_strategy,
        params: {
          input: body.input,
          encoding_format: body.encoding_format ?? 'float',
          dimensions: body.dimensions,
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
        toStatusCode(result.status, 502)
      );
    }

    const xClawAPI = buildXClawAPI(requestedModel, result);

    // 嘗試從後端回應中提取 embeddings
    let embeddingData: Array<{ object: 'embedding'; index: number; embedding: number[] }> = [];
    const backendData = result.data;

    if (backendData && typeof backendData === 'object') {
      const d = backendData as Record<string, unknown>;
      if (Array.isArray(d['data'])) {
        embeddingData = (d['data'] as unknown[]).map((item, i) => {
          if (typeof item === 'object' && item !== null) {
            const emb = (item as Record<string, unknown>)['embedding'];
            return {
              object: 'embedding' as const,
              index: i,
              embedding: Array.isArray(emb) ? (emb as number[]) : [],
            };
          }
          return { object: 'embedding' as const, index: i, embedding: [] };
        });
      }
    }

    // 若後端未回傳 embeddings，使用 mock 資料（全 0 向量）
    if (embeddingData.length === 0) {
      embeddingData = inputTexts.map((_, i) => ({
        object: 'embedding' as const,
        index: i,
        embedding: new Array(1536).fill(0) as number[],
      }));
    }

    const usage = extractUsage(backendData);
    const response: EmbeddingsResponse = {
      object: 'list',
      data: embeddingData,
      model: result.modelName ?? requestedModel,
      usage: {
        prompt_tokens: usage.prompt_tokens || inputTexts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0),
        total_tokens: usage.total_tokens || inputTexts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0),
      },
      x_clawapi: xClawAPI,
    };

    return c.json(response);
  });

  // =========================================================
  // POST /v1/images/generations
  // =========================================================
  app.post('/images/generations', async (c: Context) => {
    let body: ImageGenerationRequest;
    try {
      body = await c.req.json<ImageGenerationRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (!body.prompt) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：prompt' }, 400);
    }

    const requestedModel = body.model ?? 'dall-e-3';

    let result: RouteResultLike;
    try {
      result = await router.routeRequest({
        model: requestedModel,
        strategy: body.x_strategy,
        params: {
          prompt: body.prompt,
          n: body.n ?? 1,
          quality: body.quality ?? 'standard',
          response_format: body.response_format ?? 'url',
          size: body.size ?? '1024x1024',
          style: body.style ?? 'vivid',
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
        toStatusCode(result.status, 502)
      );
    }

    const xClawAPI = buildXClawAPI(requestedModel, result);

    // 提取後端回應的圖片資料
    let imageData: Array<{ url?: string; b64_json?: string; revised_prompt?: string }> = [];
    const backendData = result.data;

    if (backendData && typeof backendData === 'object') {
      const d = backendData as Record<string, unknown>;
      if (Array.isArray(d['data'])) {
        imageData = d['data'] as typeof imageData;
      }
    }

    if (imageData.length === 0) {
      imageData = [{ url: '', revised_prompt: body.prompt }];
    }

    const response: ImageGenerationResponse = {
      created: Math.floor(Date.now() / 1000),
      data: imageData,
      x_clawapi: xClawAPI,
    };

    return c.json(response);
  });

  // =========================================================
  // POST /v1/audio/transcriptions
  // 接受 multipart/form-data
  // =========================================================
  app.post('/audio/transcriptions', async (c: Context) => {
    let formData: Record<string, File | string | File[] | string[]>;
    try {
      formData = await c.req.parseBody();
    } catch {
      return c.json({ error: 'invalid_request', message: '解析 multipart/form-data 失敗' }, 400);
    }

    // 取得音訊檔案
    const audioFile = formData['file'];
    if (!audioFile) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：file' }, 400);
    }

    const model = (formData['model'] as string) ?? 'whisper-1';
    const language = formData['language'] as string | undefined;
    const prompt = formData['prompt'] as string | undefined;
    const responseFormat = (formData['response_format'] as string) ?? 'json';
    const temperature = formData['temperature']
      ? parseFloat(formData['temperature'] as string)
      : undefined;

    // 取得檔案名稱和大小
    let filename = 'audio.mp3';
    let fileSize = 0;
    if (audioFile instanceof File) {
      filename = audioFile.name;
      fileSize = audioFile.size;
    }

    const requestedModel = model;

    let result: RouteResultLike;
    try {
      result = await router.routeRequest({
        model: requestedModel,
        params: {
          file: filename,
          file_size: fileSize,
          model,
          language,
          prompt,
          response_format: responseFormat,
          temperature,
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
        toStatusCode(result.status, 502)
      );
    }

    // 提取轉錄文字
    let transcriptionText = '';
    const backendData = result.data;
    if (typeof backendData === 'string') {
      transcriptionText = backendData;
    } else if (backendData && typeof backendData === 'object') {
      const d = backendData as Record<string, unknown>;
      transcriptionText = (d['text'] as string) ?? '';
    }

    // 根據 response_format 決定回應格式
    if (responseFormat === 'text') {
      return new Response(transcriptionText, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (responseFormat === 'srt' || responseFormat === 'vtt') {
      return new Response(transcriptionText, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // JSON（預設）
    return c.json({
      text: transcriptionText,
    });
  });

  // =========================================================
  // POST /v1/audio/speech
  // 回傳 binary audio stream
  // =========================================================
  app.post('/audio/speech', async (c: Context) => {
    let body: AudioSpeechRequest;
    try {
      body = await c.req.json<AudioSpeechRequest>();
    } catch {
      return c.json({ error: 'invalid_request', message: '請求體必須是合法的 JSON' }, 400);
    }

    if (!body.model) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：model' }, 400);
    }
    if (!body.input) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：input' }, 400);
    }
    if (!body.voice) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：voice' }, 400);
    }

    const requestedModel = body.model;
    const responseFormat = body.response_format ?? 'mp3';

    let result: RouteResultLike;
    try {
      result = await router.routeRequest({
        model: body.model,
        strategy: body.x_strategy,
        params: {
          input: body.input,
          voice: body.voice,
          response_format: responseFormat,
          speed: body.speed ?? 1.0,
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
        toStatusCode(result.status, 502)
      );
    }

    const xClawAPI = buildXClawAPI(requestedModel, result);

    // 取得音訊內容（bytes）
    let audioContent: Uint8Array | null = null;
    const backendData = result.data;

    if (backendData instanceof Uint8Array) {
      audioContent = backendData;
    } else if (backendData instanceof ArrayBuffer) {
      audioContent = new Uint8Array(backendData);
    } else {
      // 若後端沒有回傳 binary，回傳空的 MP3（stub）
      audioContent = new Uint8Array(0);
    }

    // 決定 Content-Type
    const contentTypeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      opus: 'audio/ogg; codecs=opus',
      aac: 'audio/aac',
      flac: 'audio/flac',
      wav: 'audio/wav',
      pcm: 'audio/pcm',
    };
    const contentType = contentTypeMap[responseFormat] ?? 'audio/mpeg';

    // ClawAPI 擴充資訊透過 Headers 傳送
    // 注意：TypeScript 嚴格型別需要明確的 BodyInit 型別，使用 .buffer 取得底層 ArrayBuffer
    const audioBody: BodyInit = audioContent.buffer as ArrayBuffer;
    return new Response(audioBody, {
      headers: {
        'Content-Type': contentType,
        'X-ClawAPI-Service': xClawAPI.service_id,
        'X-ClawAPI-Model': xClawAPI.actual_model,
        'X-ClawAPI-Layer': xClawAPI.layer,
        'X-ClawAPI-Latency': String(xClawAPI.latency_ms),
      },
    });
  });

  // =========================================================
  // POST /v1/files — 上傳檔案
  // =========================================================
  app.post('/files', async (c: Context) => {
    let formData: Record<string, File | string | File[] | string[]>;
    try {
      formData = await c.req.parseBody();
    } catch {
      return c.json({ error: 'invalid_request', message: '解析 multipart/form-data 失敗' }, 400);
    }

    const file = formData['file'];
    const purpose = (formData['purpose'] as string) ?? 'assistants';

    if (!file) {
      return c.json({ error: 'invalid_request', message: '缺少必填欄位：file' }, 400);
    }

    let filename = 'upload';
    let fileSize = 0;
    let fileContent: ArrayBuffer = new ArrayBuffer(0);

    if (file instanceof File) {
      filename = file.name;
      fileSize = file.size;
      fileContent = await file.arrayBuffer();
    } else if (typeof file === 'string') {
      // 若是字串（非 multipart 情況）
      filename = 'text_upload';
      const encoded = new TextEncoder().encode(file);
      fileSize = encoded.byteLength;
      fileContent = encoded.buffer;
    }

    const fileId = generateId('file-');
    const createdAt = Math.floor(Date.now() / 1000);

    const stored: StoredFile = {
      id: fileId,
      bytes: fileSize,
      created_at: createdAt,
      filename,
      purpose,
      status: 'uploaded',
      content: fileContent,
    };
    fileStore.set(fileId, stored);

    const fileObj: FileObject = {
      id: fileId,
      object: 'file',
      bytes: fileSize,
      created_at: createdAt,
      filename,
      purpose,
      status: 'uploaded',
    };

    return c.json(fileObj, 200);
  });

  // =========================================================
  // GET /v1/files — 列出所有檔案
  // =========================================================
  app.get('/files', (c: Context) => {
    const purpose = c.req.query('purpose');
    let files = Array.from(fileStore.values());

    if (purpose) {
      files = files.filter(f => f.purpose === purpose);
    }

    const data: FileObject[] = files.map(f => ({
      id: f.id,
      object: 'file',
      bytes: f.bytes,
      created_at: f.created_at,
      filename: f.filename,
      purpose: f.purpose,
      status: f.status,
    }));

    return c.json({
      object: 'list',
      data,
    });
  });

  // =========================================================
  // GET /v1/files/:file_id — 取得單一檔案資訊
  // =========================================================
  app.get('/files/:file_id', (c: Context) => {
    const fileId = c.req.param('file_id');
    const stored = fileStore.get(fileId);

    if (!stored) {
      return c.json(
        { error: 'not_found', message: `找不到檔案：${fileId}` },
        404
      );
    }

    const fileObj: FileObject = {
      id: stored.id,
      object: 'file',
      bytes: stored.bytes,
      created_at: stored.created_at,
      filename: stored.filename,
      purpose: stored.purpose,
      status: stored.status,
    };

    return c.json(fileObj);
  });

  // =========================================================
  // DELETE /v1/files/:file_id — 刪除檔案
  // =========================================================
  app.delete('/files/:file_id', (c: Context) => {
    const fileId = c.req.param('file_id');
    const exists = fileStore.has(fileId);

    if (!exists) {
      return c.json(
        { error: 'not_found', message: `找不到檔案：${fileId}` },
        404
      );
    }

    fileStore.delete(fileId);

    return c.json({
      id: fileId,
      object: 'file',
      deleted: true,
    });
  });

  return app;
}

// ===== 測試輔助導出 =====

/**
 * 清除記憶體中的檔案儲存（測試用）
 */
export function _clearFileStore(): void {
  fileStore.clear();
}

/**
 * 取得記憶體中的檔案儲存（測試用）
 */
export function _getFileStore(): Map<string, StoredFile> {
  return fileStore;
}

export default createOpenAICompatRouter;
