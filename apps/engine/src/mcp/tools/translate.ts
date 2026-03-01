// MCP Tool: translate — 翻譯文字
// 透過引擎路由呼叫翻譯類 Adapter（如 deepl）或 LLM 翻譯

import type { Router } from '../../core/router';

// ===== 型別定義 =====

/** translate tool 的輸入參數 */
export interface TranslateToolInput {
  /** 要翻譯的文字（必填） */
  text: string;
  /** 目標語言（必填） */
  target_lang: string;
  /** 來源語言（自動偵測） */
  source_lang?: string;
}

/** translate tool 的 JSON Schema */
export const translateToolSchema = {
  name: 'translate',
  description: '翻譯文字到指定語言',
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: '要翻譯的文字' },
      target_lang: { type: 'string', description: '目標語言（如 en, zh-TW, ja）' },
      source_lang: { type: 'string', description: '來源語言（預設自動偵測）' },
    },
    required: ['text', 'target_lang'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 translate tool
 */
export async function executeTranslateTool(
  input: TranslateToolInput,
  router: Router
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const params: Record<string, unknown> = {
    text: input.text,
    target_lang: input.target_lang,
    type: 'translate',
  };
  if (input.source_lang) {
    params['source_lang'] = input.source_lang;
  }

  // 先嘗試專用翻譯服務（如 deepl），不然 fallback 到 LLM 翻譯
  const result = await router.routeRequest({
    model: 'auto',
    params,
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `翻譯失敗：${result.error ?? '未知錯誤'}`,
      }],
    };
  }

  // 提取翻譯結果
  const translated = extractTranslation(result.data);

  return {
    content: [{
      type: 'text',
      text: translated,
    }],
  };
}

/**
 * 從回應中提取翻譯文字
 */
function extractTranslation(data: unknown): string {
  if (typeof data === 'string') return data;

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    // DeepL 格式
    if (typeof obj['translated_text'] === 'string') return obj['translated_text'];

    // 通用格式
    if (typeof obj['text'] === 'string') return obj['text'];
    if (typeof obj['translation'] === 'string') return obj['translation'];

    // LLM 回應格式（choices[0].message.content）
    if (Array.isArray(obj['choices'])) {
      const firstChoice = obj['choices'][0] as Record<string, unknown> | undefined;
      if (firstChoice?.['message']) {
        const msg = firstChoice['message'] as Record<string, unknown>;
        if (typeof msg['content'] === 'string') return msg['content'];
      }
    }
  }

  return JSON.stringify(data);
}
