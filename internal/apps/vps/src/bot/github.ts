// Claude Bot — GitHub Issue 自動分類與回覆
// 負責 Issue 關鍵字分類、自動標籤、模板回覆、48 小時無回應標記

// ===== 型別定義 =====

// Issue 分類標籤
export type IssueLabel =
  | 'bug'
  | 'security'
  | 'adapter'
  | 'feature'
  | 'question'
  | 'needs-triage'
  | 'needs-human';

// GitHub Issue 資料（最小必要欄位）
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  created_at: string;
  labels: Array<{ name: string }>;
  comments: number;
  user: {
    login: string;
  };
}

// 分類結果
export interface IssueClassification {
  label: IssueLabel;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
}

// 回覆模板參數
export interface ReplyTemplateParams {
  issueNumber: number;
  authorLogin: string;
  label: IssueLabel;
}

// GitHub API 設定
export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

// ===== 關鍵字分類規則 =====

// 各標籤的關鍵字列表（全部轉小寫比對）
const LABEL_KEYWORDS: Record<Exclude<IssueLabel, 'needs-triage' | 'needs-human'>, string[]> = {
  bug: [
    'bug', 'error', 'crash', 'fail', 'broken', 'exception',
    'panic', 'segfault', 'hang', 'freeze', 'not working',
    '錯誤', '壞了', '崩潰', '無法', '失敗', '異常',
  ],
  security: [
    'security', 'vulnerability', 'xss', 'injection', 'csrf', 'exploit',
    'attack', 'hack', 'breach', 'leak', 'exposure', 'cve',
    '安全', '漏洞', '注入', '攻擊', '防護',
  ],
  adapter: [
    'adapter', 'yaml', 'plugin', 'provider', 'connector', 'integration',
    '插件', '適配器', '連接器', '擴充', '對接',
  ],
  feature: [
    'feature', 'request', 'enhancement', 'improvement', 'add support',
    'would be nice', 'suggestion', 'propose', 'wish',
    '功能', '建議', '新增', '希望', '期望', '加入',
  ],
  question: [
    'how', 'what', 'why', 'when', 'where', 'help', 'explain',
    'understand', 'confused', 'documentation', 'docs',
    '?', '怎麼', '如何', '為什麼', '請問', '幫忙', '不懂',
  ],
};

// ===== 回覆模板 =====

const REPLY_TEMPLATES: Record<IssueLabel, (params: ReplyTemplateParams) => string> = {
  bug: ({ authorLogin }) => `
感謝 @${authorLogin} 回報！

我們已將此 Issue 標記為 **Bug**，團隊會盡快跟進。

為了幫助我們更快解決問題，請提供以下資訊：

- **ClawAPI 版本**：（執行 \`clawapi --version\` 查看）
- **作業系統**：
- **重現步驟**：
- **預期行為 vs 實際行為**：
- **錯誤訊息 / 日誌**：（如有）

---
*🤖 此為自動回覆，由 ClawAPI Bot 產生*
`.trim(),

  security: ({ authorLogin }) => `
感謝 @${authorLogin} 的安全回報！

⚠️ **重要：** 如果此為高危安全漏洞，**請勿在 Issue 公開詳細資訊**。

請透過以下方式私訊回報：
- Email：security@clawapi.dev
- 或使用 GitHub [Security Advisories](../../security/advisories/new)

我們保證在 48 小時內確認並回應所有安全回報。

---
*🤖 此為自動回覆，由 ClawAPI Bot 產生*
`.trim(),

  adapter: ({ authorLogin }) => `
感謝 @${authorLogin} 的回饋！

我們已將此 Issue 標記為 **Adapter / Plugin**。

撰寫自訂 Adapter 請參考：
- [Adapter 開發指南](../../docs/adapter-guide.md)
- [YAML Schema 規格](../../docs/adapter-schema.md)
- [範例 Adapter](../../examples/adapters/)

如果您需要某個服務的官方 Adapter 支援，請說明：
- 服務名稱與 API 文件連結
- 使用場景描述

---
*🤖 此為自動回覆，由 ClawAPI Bot 產生*
`.trim(),

  feature: ({ authorLogin }) => `
感謝 @${authorLogin} 的功能建議！

我們已將此 Issue 標記為 **Feature Request**。

為了讓我們更好地評估，請補充：
- **使用場景**：這個功能解決什麼問題？
- **建議實作方式**（可選）：
- **優先級**：這對您的工作流程影響有多大？

我們會在排期時優先考慮獲得最多 👍 的功能請求。

---
*🤖 此為自動回覆，由 ClawAPI Bot 產生*
`.trim(),

  question: ({ authorLogin }) => `
感謝 @${authorLogin} 的提問！

請先查閱以下資源，可能已有解答：
- [官方文件](../../docs/)
- [FAQ](../../docs/faq.md)
- [現有 Issues](../../issues?q=is%3Aissue)

如果文件無法解決您的問題，請補充：
- 您已嘗試的解決方案
- 您的使用環境（OS、版本）

---
*🤖 此為自動回覆，由 ClawAPI Bot 產生*
`.trim(),

  'needs-triage': ({ authorLogin }) => `
感謝 @${authorLogin} 的回報！

我們已收到您的 Issue，正在分類中。團隊將在 48 小時內回覆。

---
*🤖 此為自動回覆，由 ClawAPI Bot 產生*
`.trim(),

  'needs-human': ({ authorLogin }) => `
@${authorLogin} 感謝您的耐心！

此 Issue 需要人工審查，我們已標記為 **needs-human**，會盡快安排處理。

---
*🤖 此為自動回覆，由 ClawAPI Bot 產生*
`.trim(),
};

// ===== 核心函式 =====

// 分類 Issue（依標題 + 內文關鍵字）
export function classifyIssue(issue: GitHubIssue): IssueClassification {
  const text = `${issue.title} ${issue.body ?? ''}`.toLowerCase();

  const scores: Map<Exclude<IssueLabel, 'needs-triage' | 'needs-human'>, string[]> = new Map();

  // 計算各標籤匹配的關鍵字數量
  for (const [label, keywords] of Object.entries(LABEL_KEYWORDS) as Array<[
    Exclude<IssueLabel, 'needs-triage' | 'needs-human'>,
    string[]
  ]>) {
    const matched = keywords.filter(kw => text.includes(kw));
    if (matched.length > 0) {
      scores.set(label, matched);
    }
  }

  if (scores.size === 0) {
    // 沒有任何關鍵字匹配 → needs-triage
    return {
      label: 'needs-triage',
      confidence: 'low',
      matchedKeywords: [],
    };
  }

  // 依匹配數量排序，取最高分
  let bestLabel: Exclude<IssueLabel, 'needs-triage' | 'needs-human'> = 'question';
  let bestKeywords: string[] = [];

  for (const [label, keywords] of scores.entries()) {
    if (keywords.length > bestKeywords.length) {
      bestLabel = label;
      bestKeywords = keywords;
    }
  }

  // 信心度：匹配數 ≥ 3 → high，= 2 → medium，= 1 → low
  const confidence: 'high' | 'medium' | 'low' =
    bestKeywords.length >= 3 ? 'high' :
    bestKeywords.length === 2 ? 'medium' : 'low';

  return {
    label: bestLabel,
    confidence,
    matchedKeywords: bestKeywords,
  };
}

// 取得對應標籤的回覆模板
export function getReplyTemplate(params: ReplyTemplateParams): string {
  const template = REPLY_TEMPLATES[params.label];
  return template(params);
}

// ===== GitHubBot 類別 =====

export class GitHubBot {
  private config: GitHubConfig;

  constructor(config: GitHubConfig) {
    this.config = config;
  }

  // 處理新 Issue：分類 → 打標籤 → 自動回覆
  async handleNewIssue(issue: GitHubIssue): Promise<{
    label: IssueLabel;
    commentPosted: boolean;
    labelApplied: boolean;
  }> {
    const classification = classifyIssue(issue);

    // 並行執行：打標籤 + 留言
    const [labelResult, commentResult] = await Promise.allSettled([
      this.applyLabel(issue.number, classification.label),
      this.postComment(issue.number, {
        issueNumber: issue.number,
        authorLogin: issue.user.login,
        label: classification.label,
      }),
    ]);

    return {
      label: classification.label,
      labelApplied: labelResult.status === 'fulfilled',
      commentPosted: commentResult.status === 'fulfilled',
    };
  }

  // 掃描 48 小時無回應的 Issue → 標記 needs-human
  async markStaleIssues(issues: GitHubIssue[]): Promise<number> {
    const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 小時
    const now = Date.now();
    let marked = 0;

    for (const issue of issues) {
      const createdAt = new Date(issue.created_at).getTime();
      const isStale = now - createdAt > STALE_THRESHOLD_MS;
      const hasNoComments = issue.comments === 0;
      const alreadyMarked = issue.labels.some(l => l.name === 'needs-human');

      if (isStale && hasNoComments && !alreadyMarked) {
        try {
          await this.applyLabel(issue.number, 'needs-human');
          marked++;
        } catch (err) {
          console.error(`[GitHubBot] 標記 needs-human 失敗 (#${issue.number}):`, err);
        }
      }
    }

    return marked;
  }

  // ===== 私有方法（呼叫 GitHub REST API）=====

  // 對 Issue 打標籤
  private async applyLabel(issueNumber: number, label: IssueLabel): Promise<void> {
    const { token, owner, repo } = this.config;
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ labels: [label] }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API 錯誤 ${response.status}: ${body}`);
    }
  }

  // 留言到 Issue
  private async postComment(issueNumber: number, params: ReplyTemplateParams): Promise<void> {
    const { token, owner, repo } = this.config;
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
    const body = getReplyTemplate(params);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(`GitHub API 錯誤 ${response.status}: ${responseBody}`);
    }
  }
}

// 匯出關鍵字清單供測試使用
export { LABEL_KEYWORDS, REPLY_TEMPLATES };
