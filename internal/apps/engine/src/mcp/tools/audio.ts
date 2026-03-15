// MCP Tool: audio_transcribe — 語音轉文字
// 透過引擎路由呼叫語音轉文字 Adapter

import type { Router } from '../../core/router';

// ===== 型別定義 =====

/** audio_transcribe tool 的輸入參數 */
export interface AudioTranscribeToolInput {
  /** 音檔路徑（必填） */
  file_path: string;
  /** 模型名稱 */
  model?: string;
  /** 音檔語言 */
  language?: string;
}

/** audio_transcribe tool 的 JSON Schema */
export const audioTranscribeToolSchema = {
  name: 'audio_transcribe',
  description: '將語音檔案轉換為文字',
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: '音檔路徑' },
      model: { type: 'string', description: '語音轉文字模型' },
      language: { type: 'string', description: '音檔語言（如 zh, en, ja）' },
    },
    required: ['file_path'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 audio_transcribe tool
 */
export async function executeAudioTranscribeTool(
  input: AudioTranscribeToolInput,
  router: Router
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const model = input.model ?? 'auto';

  const params: Record<string, unknown> = {
    file_path: input.file_path,
    type: 'audio_transcribe',
  };
  if (input.language) params['language'] = input.language;

  const result = await router.routeRequest({
    model,
    params,
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `語音轉文字失敗：${result.error ?? '未知錯誤'}`,
      }],
    };
  }

  // 提取轉錄文字
  const text = extractTranscription(result.data);

  return {
    content: [{
      type: 'text',
      text,
    }],
  };
}

/**
 * 從回應中提取轉錄文字
 */
function extractTranscription(data: unknown): string {
  if (typeof data === 'string') return data;

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    // OpenAI 格式
    if (typeof obj['text'] === 'string') return obj['text'];

    // 其他常見格式
    if (typeof obj['transcript'] === 'string') return obj['transcript'];
    if (typeof obj['transcription'] === 'string') return obj['transcription'];
  }

  return JSON.stringify(data);
}
