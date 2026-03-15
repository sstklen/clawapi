// MCP Tool: embeddings — 向量嵌入
// 透過引擎路由呼叫 Embedding Adapter

import type { Router } from '../../core/router';

// ===== 型別定義 =====

/** embeddings tool 的輸入參數 */
export interface EmbeddingsToolInput {
  /** 要嵌入的文字（必填） */
  text: string;
  /** 模型名稱 */
  model?: string;
}

/** embeddings tool 的 JSON Schema */
export const embeddingsToolSchema = {
  name: 'embeddings',
  description: '將文字轉換為向量嵌入（embedding），用於語意搜尋、分類等',
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: '要嵌入的文字' },
      model: { type: 'string', description: '嵌入模型名稱' },
    },
    required: ['text'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 embeddings tool
 */
export async function executeEmbeddingsTool(
  input: EmbeddingsToolInput,
  router: Router
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const model = input.model ?? 'auto';

  const result = await router.routeRequest({
    model,
    params: {
      input: input.text,
      type: 'embeddings',
    },
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `向量嵌入失敗：${result.error ?? '未知錯誤'}`,
      }],
    };
  }

  // 回傳嵌入結果的摘要（完整向量太長）
  const text = formatEmbeddingResult(result.data);

  return {
    content: [{
      type: 'text',
      text,
    }],
  };
}

/**
 * 格式化嵌入結果
 */
function formatEmbeddingResult(data: unknown): string {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    // OpenAI 格式
    if (Array.isArray(obj['data'])) {
      const first = obj['data'][0] as Record<string, unknown> | undefined;
      if (first?.['embedding'] && Array.isArray(first['embedding'])) {
        const dim = (first['embedding'] as number[]).length;
        const preview = (first['embedding'] as number[]).slice(0, 5).map(v => v.toFixed(4));
        return `向量嵌入完成：維度 ${dim}，前 5 值 [${preview.join(', ')}...]`;
      }
    }
  }

  return JSON.stringify(data);
}
