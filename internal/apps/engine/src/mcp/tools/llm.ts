// MCP Tool: llm — 呼叫 LLM（自動選最佳服務）
// 透過引擎 Router 的 L2 智慧路由或 L1 直轉

import type { Router } from '../../core/router';

// ===== 型別定義 =====

/** llm tool 的輸入參數 */
export interface LlmToolInput {
  /** 提示文字（必填） */
  prompt: string;
  /** 模型名稱（如 'auto', 'groq/llama3', 'gpt-4o'） */
  model?: string;
  /** 路由策略 */
  strategy?: 'fast' | 'smart' | 'cheap';
  /** 系統提示 */
  system?: string;
  /** 最大輸出 token 數 */
  max_tokens?: number;
  /** 溫度 */
  temperature?: number;
}

/** llm tool 的 JSON Schema（提供給 MCP Server 註冊） */
export const llmToolSchema = {
  name: 'llm',
  description: '呼叫 LLM 模型，自動選擇最佳服務進行推理',
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: '提示文字' },
      model: { type: 'string', description: '模型名稱（預設 auto）' },
      strategy: {
        type: 'string',
        enum: ['fast', 'smart', 'cheap'],
        description: '路由策略',
      },
      system: { type: 'string', description: '系統提示' },
      max_tokens: { type: 'number', description: '最大輸出 token 數' },
      temperature: { type: 'number', description: '溫度（0-2）' },
    },
    required: ['prompt'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 llm tool
 * 內部直接呼叫 Router.routeRequest()，不走 HTTP
 */
export async function executeLlmTool(
  input: LlmToolInput,
  router: Router
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const model = input.model ?? 'auto';
  const strategy = input.strategy ?? 'smart';

  // 組裝 messages
  const messages: Array<{ role: string; content: string }> = [];
  if (input.system) {
    messages.push({ role: 'system', content: input.system });
  }
  messages.push({ role: 'user', content: input.prompt });

  // 組裝參數
  const params: Record<string, unknown> = {
    messages,
  };
  if (input.max_tokens !== undefined) params['max_tokens'] = input.max_tokens;
  if (input.temperature !== undefined) params['temperature'] = input.temperature;

  const result = await router.routeRequest({
    model,
    strategy,
    params,
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `LLM 呼叫失敗：${result.error ?? '未知錯誤'}`,
      }],
    };
  }

  // 從回應中提取文字
  const responseText = extractResponseText(result.data);

  return {
    content: [{
      type: 'text',
      text: responseText,
    }],
  };
}

/**
 * 從 Router 回應中提取文字
 */
function extractResponseText(data: unknown): string {
  if (typeof data === 'string') return data;

  // OpenAI 格式回應
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    // choices[0].message.content
    if (Array.isArray(obj['choices'])) {
      const firstChoice = obj['choices'][0] as Record<string, unknown> | undefined;
      if (firstChoice?.['message']) {
        const msg = firstChoice['message'] as Record<string, unknown>;
        if (typeof msg['content'] === 'string') return msg['content'];
      }
    }

    // 直接有 text 欄位
    if (typeof obj['text'] === 'string') return obj['text'];

    // 直接有 content 欄位
    if (typeof obj['content'] === 'string') return obj['content'];
  }

  return JSON.stringify(data);
}
