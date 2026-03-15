// Claude Bot — Adapter YAML 安全審查
// 三層掃描：URL 白名單 → 模板變數 → 危險模式
// 用於 PR 審查：自動掃描新增或修改的 Adapter YAML 檔案

// ===== 型別定義 =====

// 安全掃描層級
export type ScanLayer = 1 | 2 | 3;

// 掃描結果（單一項目）
export interface ScanFinding {
  layer: ScanLayer;
  type: string;           // 問題類型（例如 'unknown_url', 'env_access'）
  message: string;        // 問題描述
  line?: number;          // 問題所在行（若可定位）
  snippet?: string;       // 問題片段
}

// Adapter 完整審查結果
export interface AdapterReviewResult {
  passed: boolean;
  score: number;          // 0-100（100 = 全通過）
  findings: ScanFinding[];
  summary: string;
  prComment: string;      // 格式化後的 PR 留言
}

// PR 資訊（留言用）
export interface PRInfo {
  number: number;
  authorLogin: string;
  filename: string;
}

// ===== 層 1：URL 白名單 =====

// 已知合法的 API 域名（15 個）
const ALLOWED_DOMAINS = new Set([
  'api.groq.com',
  'generativelanguage.googleapis.com',
  'api.openai.com',
  'api.anthropic.com',
  'api.deepseek.com',
  'api.search.brave.com',
  'api.tavily.com',
  'google.serper.dev',
  'api.duckduckgo.com',
  'api-free.deepl.com',
  'api.deepl.com',
  'api.cerebras.ai',
  'api.sambanova.ai',
  'openrouter.ai',
  'dashscope.aliyuncs.com',
]);

// 從 URL 字串萃取域名
function extractDomain(url: string): string | null {
  try {
    // 補上 protocol 讓 URL 解析正常
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    return new URL(fullUrl).hostname;
  } catch {
    return null;
  }
}

// URL 正則（匹配 http/https URL 和無 scheme 的 domain/path）
const URL_PATTERN = /https?:\/\/[^\s"'`]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/[^\s"'`]*/g;

// ===== 層 2：模板變數 =====

// 禁止的模板變數模式
const FORBIDDEN_TEMPLATE_PATTERNS: Array<{
  pattern: RegExp;
  type: string;
  description: string;
}> = [
  {
    pattern: /\{\{\s*key\s*\}\}/gi,
    type: 'key_access',
    description: '禁止直接存取 {{ key }}，API Key 只能在安全環境中處理',
  },
  {
    pattern: /\{\{\s*env\.[^}]+\}\}/gi,
    type: 'env_access',
    description: '禁止存取 {{ env.* }} 環境變數，可能洩漏敏感資訊',
  },
  {
    pattern: /\{\{\s*file\.[^}]+\}\}/gi,
    type: 'file_access',
    description: '禁止存取 {{ file.* }} 本地檔案，防止路徑遍歷攻擊',
  },
  {
    pattern: /\{\{\s*process\.[^}]+\}\}/gi,
    type: 'process_access',
    description: '禁止存取 {{ process.* }} 進程資訊',
  },
  {
    pattern: /\{\{\s*secret\.[^}]+\}\}/gi,
    type: 'secret_access',
    description: '禁止存取 {{ secret.* }}，秘密不得直接引用',
  },
];

// ===== 層 3：危險模式 =====

// 禁止的程式碼模式（防止代碼注入）
const DANGEROUS_PATTERNS: Array<{
  pattern: RegExp;
  type: string;
  description: string;
  severity: 'high' | 'critical';
}> = [
  {
    pattern: /\bexec\s*\(/gi,
    type: 'exec_call',
    description: '禁止 exec() 呼叫，可能執行任意系統指令',
    severity: 'critical',
  },
  {
    pattern: /\beval\s*\(/gi,
    type: 'eval_call',
    description: '禁止 eval() 呼叫，可能執行任意 JavaScript',
    severity: 'critical',
  },
  {
    pattern: /\bsystem\s*\(/gi,
    type: 'system_call',
    description: '禁止 system() 呼叫，可能執行系統指令',
    severity: 'critical',
  },
  {
    pattern: /require\s*\(\s*['"]child_process['"]\s*\)/gi,
    type: 'child_process',
    description: '禁止引入 child_process 模組',
    severity: 'critical',
  },
  {
    pattern: /import\s+.*?['"]child_process['"]/gi,
    type: 'child_process_import',
    description: '禁止 import child_process 模組',
    severity: 'critical',
  },
  {
    pattern: /__proto__/gi,
    type: 'prototype_pollution',
    description: '禁止存取 __proto__，可能導致原型污染攻擊',
    severity: 'high',
  },
  {
    pattern: /prototype\s*\[/gi,
    type: 'prototype_access',
    description: '禁止動態存取 prototype 屬性',
    severity: 'high',
  },
  {
    pattern: /constructor\s*\[/gi,
    type: 'constructor_access',
    description: '禁止動態存取 constructor，可能用於原型鏈攻擊',
    severity: 'high',
  },
  {
    pattern: /process\.env\b/gi,
    type: 'process_env',
    description: '禁止直接存取 process.env，環境變數不得外洩',
    severity: 'high',
  },
  {
    pattern: /require\s*\(\s*['"]fs['"]\s*\)/gi,
    type: 'fs_require',
    description: '禁止引入 fs 模組，防止檔案系統存取',
    severity: 'critical',
  },
];

// ===== 核心掃描函式 =====

// 層 1：掃描 URL 白名單
export function scanUrls(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = content.split('\n');

  lines.forEach((line, lineIndex) => {
    const matches = line.matchAll(URL_PATTERN);
    for (const match of matches) {
      const url = match[0];
      const domain = extractDomain(url);

      if (domain && !ALLOWED_DOMAINS.has(domain)) {
        findings.push({
          layer: 1,
          type: 'unknown_url',
          message: `發現未知域名 \`${domain}\`，不在白名單中`,
          line: lineIndex + 1,
          snippet: url.slice(0, 80),
        });
      }
    }
  });

  return findings;
}

// 層 2：掃描禁止的模板變數
export function scanTemplateVars(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = content.split('\n');

  for (const { pattern, type, description } of FORBIDDEN_TEMPLATE_PATTERNS) {
    lines.forEach((line, lineIndex) => {
      // 需要 reset lastIndex（因為全域正則有狀態）
      const localPattern = new RegExp(pattern.source, pattern.flags);
      const match = localPattern.exec(line);
      if (match) {
        findings.push({
          layer: 2,
          type,
          message: description,
          line: lineIndex + 1,
          snippet: match[0],
        });
      }
    });
  }

  return findings;
}

// 層 3：掃描危險程式碼模式
export function scanDangerousPatterns(content: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = content.split('\n');

  for (const { pattern, type, description } of DANGEROUS_PATTERNS) {
    lines.forEach((line, lineIndex) => {
      const localPattern = new RegExp(pattern.source, pattern.flags);
      const match = localPattern.exec(line);
      if (match) {
        findings.push({
          layer: 3,
          type,
          message: description,
          line: lineIndex + 1,
          snippet: match[0],
        });
      }
    });
  }

  return findings;
}

// ===== AdapterReviewer 主類別 =====

export class AdapterReviewer {
  // 執行完整三層安全審查
  review(content: string, prInfo?: PRInfo): AdapterReviewResult {
    // 層 1：URL 白名單
    const layer1Findings = scanUrls(content);

    // 層 2：模板變數
    const layer2Findings = scanTemplateVars(content);

    // 層 3：危險模式
    const layer3Findings = scanDangerousPatterns(content);

    const allFindings = [...layer1Findings, ...layer2Findings, ...layer3Findings];
    const passed = allFindings.length === 0;

    // 計算評分（每個問題扣分）
    const score = Math.max(0, 100 - allFindings.length * 20);

    // 產生摘要
    const summary = this.buildSummary(passed, allFindings);

    // 產生 PR 留言
    const prComment = this.formatPRComment(passed, allFindings, summary, prInfo);

    return { passed, score, findings: allFindings, summary, prComment };
  }

  // ===== 私有方法 =====

  private buildSummary(passed: boolean, findings: ScanFinding[]): string {
    if (passed) {
      return '三層安全掃描全部通過，Adapter 可安全合併。';
    }

    const layer1Count = findings.filter(f => f.layer === 1).length;
    const layer2Count = findings.filter(f => f.layer === 2).length;
    const layer3Count = findings.filter(f => f.layer === 3).length;

    const parts: string[] = [];
    if (layer1Count > 0) parts.push(`URL 白名單 ${layer1Count} 個問題`);
    if (layer2Count > 0) parts.push(`模板變數 ${layer2Count} 個問題`);
    if (layer3Count > 0) parts.push(`危險模式 ${layer3Count} 個問題`);

    return `安全掃描發現 ${findings.length} 個問題：${parts.join('、')}。`;
  }

  private formatPRComment(
    passed: boolean,
    findings: ScanFinding[],
    summary: string,
    prInfo?: PRInfo,
  ): string {
    const author = prInfo?.authorLogin ? `@${prInfo.authorLogin}` : '貢獻者';
    const filename = prInfo?.filename ? `（\`${prInfo.filename}\`）` : '';

    let comment = `## 🔒 Adapter 安全審查${filename}\n\n`;
    comment += `感謝 ${author} 的貢獻！\n\n`;

    if (passed) {
      comment += `✅ **全部通過** — ${summary}\n\n`;
      comment += `三層安全掃描：\n`;
      comment += `- ✅ 層 1：URL 白名單檢查\n`;
      comment += `- ✅ 層 2：模板變數檢查\n`;
      comment += `- ✅ 層 3：危險程式碼模式\n`;
    } else {
      comment += `❌ **需要修改** — ${summary}\n\n`;

      // 依層分組顯示問題
      for (const layer of [1, 2, 3] as ScanLayer[]) {
        const layerFindings = findings.filter(f => f.layer === layer);
        if (layerFindings.length === 0) {
          comment += `- ✅ 層 ${layer}：通過\n`;
          continue;
        }

        const layerName = layer === 1 ? 'URL 白名單' : layer === 2 ? '模板變數' : '危險模式';
        comment += `- ❌ 層 ${layer}（${layerName}）：${layerFindings.length} 個問題\n`;

        for (const finding of layerFindings) {
          const lineInfo = finding.line ? `（第 ${finding.line} 行）` : '';
          comment += `  - \`${finding.type}\`${lineInfo}：${finding.message}\n`;
          if (finding.snippet) {
            comment += `    \`\`\`\n    ${finding.snippet}\n    \`\`\`\n`;
          }
        }
      }

      comment += `\n請修正上述問題後重新提交 PR。\n`;
    }

    comment += `\n---\n*🤖 此為自動安全審查，由 ClawAPI Bot 產生*`;
    return comment;
  }
}

// 匯出常數供測試使用
export { ALLOWED_DOMAINS, FORBIDDEN_TEMPLATE_PATTERNS, DANGEROUS_PATTERNS };
