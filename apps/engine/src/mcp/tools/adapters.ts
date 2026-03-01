// MCP Tool: adapters — 列出已安裝 Adapter
// 讀取引擎已載入的 Adapter 清單

import type { AdapterConfig } from '../../adapters/loader';

// ===== 型別定義 =====

/** adapters tool 的輸入參數 */
export interface AdaptersToolInput {
  // 不需要參數
}

/** adapters tool 的 JSON Schema */
export const adaptersToolSchema = {
  name: 'adapters',
  description: '列出已安裝的 Adapter（服務轉接器）清單',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

// ===== Tool 執行 =====

/**
 * 執行 adapters tool
 */
export async function executeAdaptersTool(
  _input: AdaptersToolInput,
  adapters: Map<string, AdapterConfig>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (adapters.size === 0) {
    return {
      content: [{
        type: 'text',
        text: '尚未安裝任何 Adapter。',
      }],
    };
  }

  const lines: string[] = [`已安裝的 Adapter（${adapters.size} 個）：\n`];

  for (const [id, config] of adapters) {
    const adapter = config.adapter;
    const keyRequired = adapter.requires_key ? '需要 Key' : '免 Key';
    const freeTier = adapter.free_tier ? ' | 有免費額度' : '';

    lines.push(
      `  ${adapter.id} — ${adapter.name} v${adapter.version}`,
      `    分類：${adapter.category} | ${keyRequired}${freeTier}`,
      ''
    );
  }

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
}
