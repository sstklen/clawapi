// MCP Tool: ask — AI 管家（L3）
// 透過引擎 Router 的 L3 Concierge 層處理

import type { Router } from '../../core/router';

// ===== 型別定義 =====

/** ask tool 的輸入參數 */
export interface AskToolInput {
  /** 問題（必填） */
  question: string;
}

/** ask tool 的 JSON Schema */
export const askToolSchema = {
  name: 'ask',
  description: 'AI 管家：理解自然語言問題，自動拆解步驟並整合回答',
  inputSchema: {
    type: 'object' as const,
    properties: {
      question: { type: 'string', description: '你的問題' },
    },
    required: ['question'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 ask tool
 * 透過 Router 的 L3 AI 管家層處理
 */
export async function executeAskTool(
  input: AskToolInput,
  router: Router
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const result = await router.routeRequest({
    model: 'ask',  // 'ask' 會觸發 L3 層
    params: {
      messages: [
        { role: 'user', content: input.question },
      ],
    },
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `AI 管家回答失敗：${result.error ?? '未知錯誤'}`,
      }],
    };
  }

  const text = typeof result.data === 'string'
    ? result.data
    : JSON.stringify(result.data, null, 2);

  return {
    content: [{
      type: 'text',
      text,
    }],
  };
}
