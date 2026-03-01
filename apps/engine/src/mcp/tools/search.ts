// MCP Tool: search — 搜尋網路
// 透過引擎路由呼叫搜尋類 Adapter（如 duckduckgo, brave-search, tavily, serper）

import type { Router } from '../../core/router';

// ===== 型別定義 =====

/** search tool 的輸入參數 */
export interface SearchToolInput {
  /** 搜尋關鍵字（必填） */
  query: string;
  /** 回傳結果數量 */
  count?: number;
  /** 指定使用的搜尋服務 */
  service?: string;
}

/** search tool 的 JSON Schema */
export const searchToolSchema = {
  name: 'search',
  description: '搜尋網路，取得最新資訊',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: '搜尋關鍵字' },
      count: { type: 'number', description: '回傳結果數量（預設 5）' },
      service: { type: 'string', description: '指定搜尋服務（如 duckduckgo, brave-search）' },
    },
    required: ['query'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 search tool
 * 透過 Router 的簡化 API 路由進行搜尋
 */
export async function executeSearchTool(
  input: SearchToolInput,
  router: Router
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // 決定模型（搜尋走 L1 直轉或 L2 智慧路由）
  const model = input.service
    ? `${input.service}/search`
    : 'auto';

  const params: Record<string, unknown> = {
    query: input.query,
    count: input.count ?? 5,
    type: 'search',
  };

  const result = await router.routeRequest({
    model,
    params,
  });

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `搜尋失敗：${result.error ?? '未知錯誤'}`,
      }],
    };
  }

  // 格式化搜尋結果
  const text = formatSearchResults(result.data, input.query);

  return {
    content: [{
      type: 'text',
      text,
    }],
  };
}

/**
 * 格式化搜尋結果為可讀文字
 */
function formatSearchResults(data: unknown, query: string): string {
  if (typeof data === 'string') return data;

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    // 嘗試解析 results 陣列
    const results = obj['results'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(results) && results.length > 0) {
      const lines = results.map((r, i) => {
        const title = r['title'] ?? '無標題';
        const url = r['url'] ?? '';
        const snippet = r['snippet'] ?? r['description'] ?? '';
        return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
      });
      return `搜尋「${query}」的結果：\n\n${lines.join('\n\n')}`;
    }
  }

  return JSON.stringify(data, null, 2);
}
