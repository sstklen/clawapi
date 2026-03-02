// Adapter 安全掃描器模組
// 三層安全掃描：URL 白名單、模板變數檢查、危險指令偵測

import { OFFICIAL_ADAPTERS } from '@clawapi/protocol';
import type { AdapterConfig } from './loader';

// ===== 型別定義 =====

/** 掃描結果 */
export interface ScanResult {
  /** 是否通過（有 errors 時為 false，只有 warnings 時為 true） */
  passed: boolean;
  /** 警告（不阻止使用，但應注意） */
  warnings: string[];
  /** 錯誤（會阻止使用） */
  errors: string[];
}

// ===== 官方域名白名單 =====

/**
 * 21 個官方 Adapter 的域名白名單
 * 未在此列表中的 base_url → warning（不是 error，允許自訂 Adapter）
 */
const OFFICIAL_DOMAINS = new Set([
  'api.groq.com',
  'generativelanguage.googleapis.com',
  'api.cerebras.ai',
  'api.sambanova.ai',
  'dashscope.aliyuncs.com',
  'localhost',
  '127.0.0.1',
  'api.duckduckgo.com',
  'api.openai.com',
  'api.anthropic.com',
  'api.deepseek.com',
  'api.brave.com',
  'api.tavily.com',
  'google.serper.dev',
  'openrouter.ai',
  'api-free.deepl.com',
  'api.deepl.com',
  // v0.1.11 新增
  'api.mistral.ai',
  'api.cohere.com',
  'api.together.xyz',
  'api.fireworks.ai',
  'api.perplexity.ai',
  'api.x.ai',
]);

// ===== 危險關鍵字 =====

/**
 * 禁止出現在任何字串值中的危險關鍵字
 * 這些關鍵字可能被用於注入攻擊
 */
const DANGEROUS_KEYWORDS = [
  'eval',
  'exec',
  'require',
  'import(',
  '__proto__',
  'constructor',
  'Function(',
  'setTimeout(',
  'setInterval(',
  'process.env',
  'child_process',
];

/**
 * 禁止出現在模板中的敏感變數
 * {{ key }}、{{ env.* }}、{{ secret }} 等
 */
const FORBIDDEN_TEMPLATE_PATTERNS = [
  /\{\{\s*key\s*\}\}/,
  /\{\{\s*env\./,
  /\{\{\s*secret\s*\}\}/,
  /\{\{\s*password\s*\}\}/,
  /\{\{\s*token\s*\}\}/,
];

// ===== AdapterScanner 主類別 =====

/**
 * Adapter 安全掃描器
 * 對 AdapterConfig 執行三層安全檢查
 */
export class AdapterScanner {
  /** URL 域名白名單 */
  private urlWhitelist: Set<string>;

  constructor(extraDomains?: string[]) {
    this.urlWhitelist = new Set(OFFICIAL_DOMAINS);
    if (extraDomains) {
      for (const d of extraDomains) {
        this.urlWhitelist.add(d);
      }
    }
  }

  /**
   * 對 Adapter 設定執行完整安全掃描
   */
  scan(config: AdapterConfig): ScanResult {
    const warnings: string[] = [];
    const errors: string[] = [];

    // === 第一層：URL 白名單檢查 ===
    this.checkUrlWhitelist(config, warnings);

    // === 第二層：模板變數安全性 ===
    this.checkTemplateVariables(config, errors);

    // === 第三層：危險指令偵測 ===
    this.checkDangerousKeywords(config, errors);

    return {
      passed: errors.length === 0,
      warnings,
      errors,
    };
  }

  // ===== 私有檢查方法 =====

  /**
   * 第一層：URL 白名單
   * base_url 的 hostname 不在白名單 → warning
   */
  private checkUrlWhitelist(config: AdapterConfig, warnings: string[]): void {
    const baseUrl = config.base_url;
    try {
      // 處理沒有 protocol 的 URL（例如 localhost:11434）
      const urlStr = baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`;
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname;

      if (!this.urlWhitelist.has(hostname)) {
        warnings.push(
          `base_url 域名 "${hostname}" 不在官方白名單中。` +
          `若這是自訂 Adapter 請確認域名安全性。`
        );
      }
    } catch {
      warnings.push(`無法解析 base_url：${baseUrl}`);
    }

    // 也掃描 endpoint 中的完整 URL（如果有的話）
    for (const [name, endpoint] of Object.entries(config.endpoints)) {
      if (endpoint.path && endpoint.path.startsWith('http')) {
        try {
          const parsed = new URL(endpoint.path);
          if (!this.urlWhitelist.has(parsed.hostname)) {
            warnings.push(
              `endpoint "${name}" 的 path 包含外部 URL："${parsed.hostname}" 不在白名單中`
            );
          }
        } catch {
          // 非完整 URL，忽略
        }
      }
    }
  }

  /**
   * 第二層：模板變數安全性
   * 禁止 {{ key }}、{{ env.* }}、{{ secret }} 等敏感模板
   */
  private checkTemplateVariables(config: AdapterConfig, errors: string[]): void {
    // 遞迴掃描所有字串值
    const allStrings = this.extractAllStrings(config);

    for (const str of allStrings) {
      for (const pattern of FORBIDDEN_TEMPLATE_PATTERNS) {
        if (pattern.test(str)) {
          errors.push(
            `安全違規：偵測到禁止的模板變數（${pattern.source}）in "${str.slice(0, 80)}"`
          );
          break;
        }
      }
    }
  }

  /**
   * 第三層：危險指令偵測
   * 掃描所有字串值，禁止 eval、exec、require、import 等
   */
  private checkDangerousKeywords(config: AdapterConfig, errors: string[]): void {
    const allStrings = this.extractAllStrings(config);

    for (const str of allStrings) {
      for (const keyword of DANGEROUS_KEYWORDS) {
        if (str.includes(keyword)) {
          errors.push(
            `安全違規：偵測到危險關鍵字 "${keyword}" in "${str.slice(0, 80)}"`
          );
          break;
        }
      }
    }
  }

  /**
   * 遞迴提取設定物件中所有字串值
   * 用於模板和危險指令掃描
   */
  private extractAllStrings(obj: unknown): string[] {
    const result: string[] = [];

    if (typeof obj === 'string') {
      result.push(obj);
    } else if (Array.isArray(obj)) {
      for (const item of obj) {
        result.push(...this.extractAllStrings(item));
      }
    } else if (obj && typeof obj === 'object') {
      for (const val of Object.values(obj as Record<string, unknown>)) {
        result.push(...this.extractAllStrings(val));
      }
    }

    return result;
  }

  /**
   * 取得目前的白名單（測試用）
   */
  getWhitelist(): Set<string> {
    return new Set(this.urlWhitelist);
  }

  /**
   * 新增域名到白名單
   */
  addToWhitelist(domain: string): void {
    this.urlWhitelist.add(domain);
  }
}

// ===== 驗證官方 Adapter 數量 =====

// 確認官方域名白名單涵蓋所有 21 個官方 Adapter
// （在 module 載入時做靜態驗證）
const _officialAdaptersCount = OFFICIAL_ADAPTERS.length;
if (_officialAdaptersCount !== 21) {
  console.warn(`[Scanner] 官方 Adapter 數量異常：期望 21，實際 ${_officialAdaptersCount}`);
}
