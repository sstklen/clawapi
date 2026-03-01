// MCP Tool: image_generate — 圖片生成
// 透過引擎路由呼叫圖片生成 Adapter

import type { Router } from '../../core/router';

// ===== 型別定義 =====

/** image_generate tool 的輸入參數 */
export interface ImageGenerateToolInput {
  /** 圖片描述提示（必填） */
  prompt: string;
  /** 模型名稱 */
  model?: string;
  /** 圖片尺寸 */
  size?: string;
}

/** image_generate tool 的 JSON Schema */
export const imageGenerateToolSchema = {
  name: 'image_generate',
  description: '根據文字描述生成圖片',
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: '圖片描述提示' },
      model: { type: 'string', description: '圖片生成模型' },
      size: { type: 'string', description: '圖片尺寸（如 1024x1024）' },
    },
    required: ['prompt'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 image_generate tool
 */
export async function executeImageGenerateTool(
  input: ImageGenerateToolInput,
  router: Router
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const model = input.model ?? 'auto';

  const params: Record<string, unknown> = {
    prompt: input.prompt,
    type: 'image_generate',
  };
  if (input.size) params['size'] = input.size;

  const result = await router.routeRequest({
    model,
    params,
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `圖片生成失敗：${result.error ?? '未知錯誤'}`,
      }],
    };
  }

  // 提取圖片 URL 或 base64
  const text = formatImageResult(result.data);

  return {
    content: [{
      type: 'text',
      text,
    }],
  };
}

/**
 * 格式化圖片生成結果
 */
function formatImageResult(data: unknown): string {
  if (typeof data === 'string') return `圖片已生成：${data}`;

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    // OpenAI 格式
    if (Array.isArray(obj['data'])) {
      const first = obj['data'][0] as Record<string, unknown> | undefined;
      if (first?.['url']) return `圖片已生成：${first['url']}`;
      if (first?.['b64_json']) return `圖片已生成（base64），長度：${(first['b64_json'] as string).length}`;
    }

    if (typeof obj['url'] === 'string') return `圖片已生成：${obj['url']}`;
  }

  return JSON.stringify(data);
}
