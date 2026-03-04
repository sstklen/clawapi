// MCP Tool: adapters — 列出已安裝 Adapter + 市集瀏覽/搜尋
// 讀取引擎已載入的 Adapter 清單 + AdapterRegistry 市集功能

import type { AdapterConfig } from '../../adapters/loader';
import type { AdapterRegistry } from '../../adapters/registry';

// ===== 型別定義 =====

/** adapters tool 的輸入參數 */
export interface AdaptersToolInput {
  /** 檢視模式：installed=已安裝（預設）、marketplace=市集目錄、search=搜尋 */
  view?: 'installed' | 'marketplace' | 'search';
  /** 搜尋關鍵字（search 模式用） */
  query?: string;
  /** 篩選分類（marketplace/search 模式用） */
  category?: string;
}

/** adapters tool 的 JSON Schema */
export const adaptersToolSchema = {
  name: 'adapters',
  description:
    '管理 Adapter（服務轉接器）。可查看已安裝清單、瀏覽社群市集、搜尋可安裝的 Adapter。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      view: {
        type: 'string',
        enum: ['installed', 'marketplace', 'search'],
        description:
          '檢視模式：installed=已安裝（預設）、marketplace=市集目錄、search=搜尋',
      },
      query: {
        type: 'string',
        description: '搜尋關鍵字（search 模式用）',
      },
      category: {
        type: 'string',
        description: '篩選分類：llm, search, translate, image, audio, tool',
      },
    },
  },
};

// ===== Tool 執行 =====

/**
 * 執行 adapters tool
 */
export async function executeAdaptersTool(
  input: AdaptersToolInput,
  adapters: Map<string, AdapterConfig>,
  registry?: AdapterRegistry
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const view = input.view ?? 'installed';

  switch (view) {
    case 'installed':
      return handleInstalled(adapters);
    case 'marketplace':
      return handleMarketplace(registry, input.category);
    case 'search':
      return handleSearch(registry, input.query ?? '', input.category);
    default:
      return {
        content: [{
          type: 'text',
          text: `不支援的 view：${view}。可用：installed, marketplace, search`,
        }],
      };
  }
}

// ===== 各 view 處理器 =====

/**
 * installed — 列出已安裝的 Adapter
 */
function handleInstalled(
  adapters: Map<string, AdapterConfig>
): { content: Array<{ type: 'text'; text: string }> } {
  if (adapters.size === 0) {
    return {
      content: [{
        type: 'text',
        text: '尚未安裝任何 Adapter。\n\n使用 adapters(view=marketplace) 瀏覽社群市集。',
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

  lines.push('使用 adapters(view=marketplace) 瀏覽社群市集');

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
}

/**
 * marketplace — 瀏覽社群市集目錄
 */
async function handleMarketplace(
  registry?: AdapterRegistry,
  category?: string
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!registry) {
    return {
      content: [{
        type: 'text',
        text: '⚠️ Adapter 市集未啟用。請在 config.yaml 中設定 registry.enabled = true。',
      }],
    };
  }

  try {
    const catalog = await registry.fetchCatalog();
    let items = catalog.adapters;

    // 分類篩選
    if (category) {
      items = items.filter(a => a.category === category);
    }

    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: category
            ? `市集中沒有 ${category} 分類的 Adapter。`
            : '市集目前沒有可用的 Adapter。',
        }],
      };
    }

    const lines: string[] = [];
    lines.push(`🏪 Adapter 市集（${items.length} 個${category ? `，分類：${category}` : ''}）`);
    lines.push(`最後更新：${catalog.updated_at}\n`);

    for (const adapter of items.slice(0, 20)) {
      const verified = adapter.verified ? ' ✅' : '';
      const freeTier = adapter.free_tier ? ' | 免費' : '';
      const keyReq = adapter.requires_key ? '需 Key' : '免 Key';
      lines.push(
        `  ${adapter.id}${verified} — ${adapter.name} v${adapter.version}`,
        `    ${adapter.description}`,
        `    分類：${adapter.category} | ${keyReq}${freeTier} | 📥 ${adapter.downloads}`,
        `    by ${adapter.author}`,
        ''
      );
    }

    if (items.length > 20) {
      lines.push(`... 還有 ${items.length - 20} 個。使用 adapters(view=search, query=xxx) 搜尋。`);
    }

    lines.push('───────────────────────');
    lines.push('使用 `clawapi adapters install <id>` 安裝');

    return {
      content: [{
        type: 'text',
        text: lines.join('\n'),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `取得市集目錄失敗：${(err as Error).message}`,
      }],
    };
  }
}

/**
 * search — 搜尋市集 Adapter
 */
async function handleSearch(
  registry?: AdapterRegistry,
  query?: string,
  category?: string
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!registry) {
    return {
      content: [{
        type: 'text',
        text: '⚠️ Adapter 市集未啟用。請在 config.yaml 中設定 registry.enabled = true。',
      }],
    };
  }

  if (!query) {
    return {
      content: [{
        type: 'text',
        text: '請提供搜尋關鍵字：adapters(view=search, query="groq")',
      }],
    };
  }

  try {
    const results = await registry.search(query, category);

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `搜尋 "${query}" 沒有找到匹配的 Adapter。`,
        }],
      };
    }

    const lines: string[] = [];
    lines.push(`🔍 搜尋 "${query}" — 找到 ${results.length} 個結果：\n`);

    for (const adapter of results.slice(0, 10)) {
      const verified = adapter.verified ? ' ✅' : '';
      const freeTier = adapter.free_tier ? ' | 免費' : '';
      lines.push(
        `  ${adapter.id}${verified} — ${adapter.name} v${adapter.version}`,
        `    ${adapter.description}`,
        `    分類：${adapter.category}${freeTier} | 📥 ${adapter.downloads}`,
        ''
      );
    }

    if (results.length > 10) {
      lines.push(`... 還有 ${results.length - 10} 個結果。`);
    }

    lines.push('使用 `clawapi adapters install <id>` 安裝');

    return {
      content: [{
        type: 'text',
        text: lines.join('\n'),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `搜尋失敗：${(err as Error).message}`,
      }],
    };
  }
}
