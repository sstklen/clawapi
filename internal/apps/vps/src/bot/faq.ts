// Claude Bot — FAQ 自動回答系統
// 關鍵字匹配（至少 2 個關鍵字才觸發自動回答）
// 分類：setup, keys, routing, mcp, adapter, l0, aid, subkey

// ===== 型別定義 =====

// FAQ 分類
export type FAQCategory =
  | 'setup'     // 安裝與設定
  | 'keys'      // API Key 管理
  | 'routing'   // 智慧路由
  | 'mcp'       // MCP 整合
  | 'adapter'   // Adapter 開發
  | 'l0'        // L0 公共 Key 池
  | 'aid'       // 互助系統
  | 'subkey';   // Sub-Key 驗證

// FAQ 條目
export interface FAQEntry {
  id: string;
  category: FAQCategory;
  keywords: string[];     // 觸發關鍵字（至少匹配 2 個才回答）
  question: string;       // 代表性問題
  answer: string;         // 詳細回答
}

// 匹配結果
export interface FAQMatchResult {
  matched: boolean;
  entry?: FAQEntry;
  matchedKeywords: string[];
  confidence: number;     // 0-1，匹配關鍵字數 / 問題關鍵字總數
}

// ===== FAQ 知識庫 =====

export const FAQ_DATABASE: FAQEntry[] = [
  // ===== Setup 分類 =====
  {
    id: 'setup-001',
    category: 'setup',
    keywords: ['install', 'installation', 'setup', 'getting started', '安裝', '設定', '開始', '入門', 'how to start'],
    question: '如何安裝和設定 ClawAPI？',
    answer: `## 安裝 ClawAPI

**快速開始：**

\`\`\`bash
# 安裝 ClawAPI
curl -fsSL https://clawapi.dev/install.sh | sh

# 或使用 Bun
bun install -g clawapi
\`\`\`

**初始設定：**

\`\`\`bash
clawapi init
\`\`\`

這會引導你完成：
1. 裝置註冊（產生唯一 Device ID）
2. 選擇區域（asia / europe / americas）
3. 設定預設路由策略

詳見 [快速上手文件](https://docs.clawapi.dev/quickstart)。`,
  },

  // ===== Keys 分類 =====
  {
    id: 'keys-001',
    category: 'keys',
    keywords: ['api key', 'key', 'configure key', 'add key', 'set key', 'API 金鑰', '加入 key', '設定 key', '金鑰', '新增金鑰'],
    question: '如何新增 API Key 到 ClawAPI？',
    answer: `## 新增 API Key

ClawAPI 遵守「Key 永遠不過 VPS」原則 — 所有 Key 都儲存在你的本機。

**新增方式：**

\`\`\`yaml
# ~/.clawapi/adapters/openai.yaml
name: openai
base_url: https://api.openai.com/v1
auth:
  type: bearer
  key: sk-your-key-here
\`\`\`

\`\`\`bash
# 或用 CLI
clawapi key add openai sk-your-key-here
clawapi key list        # 查看所有 Key
clawapi key test openai # 測試連線
\`\`\`

Key 以 AES-256-GCM 加密儲存在本機，VPS 永遠看不到原始 Key。`,
  },

  {
    id: 'keys-002',
    category: 'keys',
    keywords: ['key rotate', 'rotate key', 'update key', 'change key', '換 key', '更換金鑰', '輪換', 'revoke'],
    question: '如何輪換或更新 API Key？',
    answer: `## 輪換 API Key

\`\`\`bash
# 更新現有 Key
clawapi key update openai sk-new-key-here

# 刪除 Key
clawapi key remove openai

# 查看 Key 狀態（不顯示明文）
clawapi key status openai
\`\`\`

**注意：** 舊的 Key 刪除後會立即失效，請確認新 Key 測試通過再刪除舊的。`,
  },

  // ===== Routing 分類 =====
  {
    id: 'routing-001',
    category: 'routing',
    keywords: ['routing', 'route', 'smart routing', 'fallback', 'load balance', '路由', '智慧路由', '負載均衡', '備援', '切換'],
    question: '智慧路由是如何運作的？',
    answer: `## 智慧路由機制

ClawAPI 的路由決策基於集體智慧：

**路由層級：**
- **L1（直連）**：用你自己的 Key，直接呼叫 API
- **L2（智慧路由）**：根據集體智慧選最佳服務
- **L3（互助）**：暫時借用其他龍蝦的 Key（加密傳輸）
- **L4（L0 公共池）**：使用社群捐贈的公共 Key

**設定路由策略：**

\`\`\`yaml
# ~/.clawapi/config.yaml
routing:
  strategy: smart    # smart | direct | l0 | aid
  fallback: true     # 自動備援
  region: asia       # 偏好地區
\`\`\`

集體智慧每小時更新，自動避開延遲高或成功率低的服務。`,
  },

  // ===== MCP 分類 =====
  {
    id: 'mcp-001',
    category: 'mcp',
    keywords: ['mcp', 'model context protocol', 'claude', 'integration', 'connect', 'MCP 整合', '整合 claude', '協議', '連接'],
    question: '如何將 ClawAPI 整合到 MCP？',
    answer: `## MCP 整合

ClawAPI 支援 MCP（Model Context Protocol），讓 AI 助理直接透過 ClawAPI 呼叫各種 API。

**設定 MCP：**

\`\`\`json
// ~/.config/claude/claude_desktop_config.json
{
  "mcpServers": {
    "clawapi": {
      "command": "clawapi",
      "args": ["mcp", "serve"],
      "env": {}
    }
  }
}
\`\`\`

**重啟 Claude Desktop** 後即可使用 ClawAPI 提供的所有工具。

可用工具：\`clawapi_route\`, \`clawapi_search\`, \`clawapi_translate\` 等。`,
  },

  // ===== Adapter 分類 =====
  {
    id: 'adapter-001',
    category: 'adapter',
    keywords: ['adapter', 'custom adapter', 'yaml adapter', 'create adapter', '自訂 adapter', '撰寫 adapter', 'YAML', '插件', '自建'],
    question: '如何建立自訂 Adapter？',
    answer: `## 建立自訂 Adapter

Adapter 是描述如何呼叫特定 API 的 YAML 設定檔。

**基本結構：**

\`\`\`yaml
name: my-service
description: 我的服務 Adapter
version: 1.0.0
base_url: https://api.my-service.com/v1
auth:
  type: bearer
  key: "{{ key }}"
endpoints:
  - path: /chat
    method: POST
    headers:
      Content-Type: application/json
    body_template: |
      {
        "messages": {{ messages }},
        "model": "{{ model | default: 'gpt-4' }}"
      }
\`\`\`

**安全限制：**
- base_url 必須使用白名單中的域名
- 禁止使用 \`{{ env.* }}\`, \`{{ file.* }}\` 等敏感模板
- 禁止 eval、exec 等危險函式

詳見 [Adapter 開發指南](https://docs.clawapi.dev/adapter-guide)。`,
  },

  // ===== L0 分類 =====
  {
    id: 'l0-001',
    category: 'l0',
    keywords: ['l0', 'public key', 'donate', 'key pool', 'community key', 'L0 Key', '公共 key', '捐贈', 'key 池', '共享', '免費'],
    question: '什麼是 L0 公共 Key 池？如何使用？',
    answer: `## L0 公共 Key 池

L0 是社群龍蝦自願捐贈 API Key 組成的公共池，讓沒有 Key 的新龍蝦也能使用 AI 服務。

**使用 L0：**

\`\`\`bash
# 查看 L0 可用服務
clawapi l0 list

# 使用 L0 呼叫
clawapi call --tier l0 groq "你好"
\`\`\`

**捐贈 Key 到 L0：**

\`\`\`bash
clawapi l0 donate groq sk-your-key
\`\`\`

**限制：**
- 每個服務每日有使用限額（依 Key 總容量 / 活躍裝置數計算）
- L0 Key 加密存在 VPS，VPS 也看不到原始 Key

感謝所有捐贈者的貢獻！🦞`,
  },

  // ===== Aid 分類 =====
  {
    id: 'aid-001',
    category: 'aid',
    keywords: ['aid', 'mutual aid', 'borrow', 'helper', 'share key', '互助', '借用', '分享', '幫助', '志願者', '互相幫助'],
    question: '互助系統是什麼？如何啟用？',
    answer: `## 互助系統（Aid）

互助系統讓龍蝦之間可以臨時分享 API 能力。當你的 Key 配額不足時，
已啟用互助的裝置可以幫你代發請求（加密傳輸，對方看不到你的 Prompt）。

**啟用互助（成為 Helper）：**

\`\`\`bash
clawapi aid enable
clawapi aid config --services "groq,openai" --daily-limit 50
\`\`\`

**使用互助：**

\`\`\`bash
clawapi call --tier aid groq "你好"
\`\`\`

**隱私保護：**
- Prompt 用 ECDH + AES-256-GCM 加密
- Helper 只看到加密後的請求，無法得知內容
- 雙向匿名`,
  },

  // ===== Sub-Key 分類 =====
  {
    id: 'subkey-001',
    category: 'subkey',
    keywords: ['subkey', 'sub-key', 'sub key', 'secondary key', 'delegate', '子金鑰', 'Sub-Key', '代理金鑰', '委派', '授權', '分派'],
    question: '什麼是 Sub-Key？如何建立？',
    answer: `## Sub-Key（子金鑰）

Sub-Key 是從你的主 Key 衍生出的受限金鑰，可以分給他人或應用程式使用，
同時限制他們能呼叫的服務和用量。

**建立 Sub-Key：**

\`\`\`bash
# 建立限制每日 100 次的 Sub-Key
clawapi subkey create \\
  --services "groq,openai" \\
  --daily-limit 100 \\
  --expires "2024-12-31"

# 查看 Sub-Key 列表
clawapi subkey list
\`\`\`

**Sub-Key 特性：**
- 無法繼續衍生子 Sub-Key（防止無限層級）
- 可隨時撤銷
- VPS 即時驗證（WebSocket 快取）`,
  },
];

// ===== 關鍵字匹配引擎 =====

// 在問題文字中搜尋匹配的關鍵字（最少 2 個才視為匹配）
export function matchFAQ(questionText: string): FAQMatchResult {
  const normalizedText = questionText.toLowerCase();
  const MINIMUM_KEYWORDS_TO_MATCH = 2;

  let bestMatch: FAQEntry | undefined;
  let bestMatchedKeywords: string[] = [];
  let bestScore = 0;

  for (const entry of FAQ_DATABASE) {
    const matchedKeywords = entry.keywords.filter(kw =>
      normalizedText.includes(kw.toLowerCase()),
    );

    if (matchedKeywords.length >= MINIMUM_KEYWORDS_TO_MATCH) {
      const score = matchedKeywords.length / entry.keywords.length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
        bestMatchedKeywords = matchedKeywords;
      }
    }
  }

  if (!bestMatch) {
    return {
      matched: false,
      matchedKeywords: [],
      confidence: 0,
    };
  }

  return {
    matched: true,
    entry: bestMatch,
    matchedKeywords: bestMatchedKeywords,
    confidence: bestScore,
  };
}

// 依分類搜尋 FAQ
export function getFAQByCategory(category: FAQCategory): FAQEntry[] {
  return FAQ_DATABASE.filter(entry => entry.category === category);
}

// 取得全部 FAQ（供列表顯示）
export function getAllFAQ(): FAQEntry[] {
  return FAQ_DATABASE;
}

// ===== FAQBot 類別 =====

export class FAQBot {
  // 自動回答（依關鍵字匹配）
  autoAnswer(questionText: string): {
    shouldReply: boolean;
    answer?: string;
    entry?: FAQEntry;
    matchedKeywords: string[];
  } {
    const result = matchFAQ(questionText);

    if (!result.matched || !result.entry) {
      return {
        shouldReply: false,
        matchedKeywords: [],
      };
    }

    return {
      shouldReply: true,
      answer: this.formatAnswer(result.entry),
      entry: result.entry,
      matchedKeywords: result.matchedKeywords,
    };
  }

  // 格式化回答（加上分類標籤和署名）
  private formatAnswer(entry: FAQEntry): string {
    const categoryLabel: Record<FAQCategory, string> = {
      setup: '安裝設定',
      keys: 'API Key',
      routing: '智慧路由',
      mcp: 'MCP 整合',
      adapter: 'Adapter',
      l0: 'L0 公共池',
      aid: '互助系統',
      subkey: 'Sub-Key',
    };

    let response = `📚 **FAQ：${categoryLabel[entry.category]}**\n\n`;
    response += entry.answer;
    response += `\n\n---\n`;
    response += `*🤖 自動回答（FAQ #${entry.id}）。如需進一步協助，請提供更多細節。*`;

    return response;
  }
}
