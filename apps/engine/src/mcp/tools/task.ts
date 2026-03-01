// MCP Tool: task — 任務引擎（L4）
// 透過引擎 Router 的 L4 TaskEngine 層處理

import type { Router } from '../../core/router';

// ===== 型別定義 =====

/** task tool 的輸入參數 */
export interface TaskToolInput {
  /** 任務描述（必填） */
  task: string;
  /** 最多步驟數 */
  max_steps?: number;
  /** Gold Key token 預算上限 */
  max_gold_tokens?: number;
}

/** task tool 的 JSON Schema */
export const taskToolSchema = {
  name: 'task',
  description: '任務引擎：處理複雜多步驟任務，支援 DAG 並行執行和斷點續作',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string', description: '任務描述' },
      max_steps: { type: 'number', description: '最多步驟數（預設 10）' },
      max_gold_tokens: { type: 'number', description: 'Gold Key token 預算上限' },
    },
    required: ['task'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 task tool
 * 透過 Router 的 L4 任務引擎層處理
 */
export async function executeTaskTool(
  input: TaskToolInput,
  router: Router
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const params: Record<string, unknown> = {
    messages: [
      { role: 'user', content: input.task },
    ],
  };
  if (input.max_steps !== undefined) params['max_steps'] = input.max_steps;
  if (input.max_gold_tokens !== undefined) params['max_gold_tokens'] = input.max_gold_tokens;

  const result = await router.routeRequest({
    model: 'task',  // 'task' 會觸發 L4 層
    params,
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `任務執行失敗：${result.error ?? '未知錯誤'}`,
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
