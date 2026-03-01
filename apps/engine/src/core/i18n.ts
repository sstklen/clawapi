// i18n 多語系模組
// 支援 zh-TW、en、ja 三種語言
// 使用 {param} 語法進行字串插值
// Fallback 順序：指定語言 → en → 回傳 key 本身

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ===== 型別定義 =====

export type SupportedLocale = 'zh-TW' | 'en' | 'ja';

/** 翻譯參數型別 */
export type TranslateParams = Record<string, string | number>;

/** 語言訊息集合（locale → key → 翻譯文字） */
type MessageStore = Record<string, Record<string, string>>;

// ===== 工具函式 =====

/**
 * 從系統環境變數（LANG / LANGUAGE）猜測語系
 * 回傳最接近的支援語系，若無法判斷回傳 null
 */
function guessLocaleFromEnv(): SupportedLocale | null {
  const lang = process.env['LANG'] ?? process.env['LANGUAGE'] ?? '';

  if (lang.startsWith('zh_TW') || lang.startsWith('zh-TW')) return 'zh-TW';
  if (lang.startsWith('zh')) return 'zh-TW';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('en')) return 'en';

  return null;
}

/**
 * 字串插值：將 {key} 替換為 params 中對應的值
 * 若 params 中沒有對應的 key，保留原始 {key} 不替換
 */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const val = params[key];
    return val !== undefined ? String(val) : match;
  });
}

// ===== I18n 類別 =====

export class I18n {
  private locale: SupportedLocale;
  private messages: MessageStore;
  private localesDir: string;

  /**
   * @param localesDir 語言檔目錄（每個語言對應一個 JSON 檔案，如 zh-TW.json）
   * @param defaultLocale 初始語系（若不指定則自動偵測）
   */
  constructor(localesDir: string, defaultLocale?: string) {
    this.localesDir = localesDir;
    this.messages = {};

    // 載入所有可用的語言檔
    this.loadAllLocales();

    // 設定初始語系
    this.locale = this.normalizeLocale(defaultLocale) ?? 'en';
  }

  // ===== 語系偵測 =====

  /**
   * 語言偵測優先順序：
   * 1. config.yaml 的 ui.locale（configLocale）
   * 2. CLI --locale 參數（cliLocale）
   * 3. 系統語言 process.env.LANG
   * 4. 預設 'en'
   *
   * 注意：CLI 參數優先於 configLocale 嗎？
   * 根據 loadConfig 的優先順序 CLI > yaml，所以 cliLocale 優先
   */
  detectLocale(configLocale?: string, cliLocale?: string): SupportedLocale {
    // CLI 最優先
    const fromCli = this.normalizeLocale(cliLocale);
    if (fromCli) return fromCli;

    // config.yaml
    const fromConfig = this.normalizeLocale(configLocale);
    if (fromConfig) return fromConfig;

    // 系統語言
    const fromEnv = guessLocaleFromEnv();
    if (fromEnv) return fromEnv;

    // 預設
    return 'en';
  }

  // ===== 翻譯 =====

  /**
   * 翻譯指定 key
   * Fallback 順序：當前語系 → en → 回傳 key 本身
   * @param key 翻譯 key（如 'startup.ready'）
   * @param params 插值參數（如 { host: '127.0.0.1', port: 4141 }）
   */
  t(key: string, params?: TranslateParams): string {
    // 嘗試當前語系
    const primary = this.messages[this.locale]?.[key];
    if (primary !== undefined) {
      return interpolate(primary, params);
    }

    // Fallback 到 en
    if (this.locale !== 'en') {
      const fallback = this.messages['en']?.[key];
      if (fallback !== undefined) {
        return interpolate(fallback, params);
      }
    }

    // 最後回傳 key 本身
    return key;
  }

  // ===== 語系切換 =====

  /**
   * 切換當前語系
   */
  setLocale(locale: SupportedLocale): void {
    this.locale = locale;
  }

  /**
   * 取得當前語系代碼
   */
  getLocale(): string {
    return this.locale;
  }

  // ===== 私有方法 =====

  /**
   * 載入目錄內所有 JSON 語言檔
   * 每個語言對應一個 {locale}.json（如 zh-TW.json）
   */
  private loadAllLocales(): void {
    const supportedLocales: SupportedLocale[] = ['zh-TW', 'en', 'ja'];

    for (const locale of supportedLocales) {
      const filePath = join(this.localesDir, `${locale}.json`);
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, 'utf8');
          this.messages[locale] = JSON.parse(raw) as Record<string, string>;
        } catch {
          // 若語言檔損毀則跳過，不影響其他語言
          this.messages[locale] = {};
        }
      } else {
        this.messages[locale] = {};
      }
    }
  }

  /**
   * 將字串正規化為 SupportedLocale，若無法識別回傳 null
   */
  private normalizeLocale(locale?: string): SupportedLocale | null {
    if (!locale) return null;

    const map: Record<string, SupportedLocale> = {
      'zh-TW': 'zh-TW',
      'zh_TW': 'zh-TW',
      'zh': 'zh-TW',
      'en': 'en',
      'en-US': 'en',
      'en_US': 'en',
      'ja': 'ja',
      'ja-JP': 'ja',
      'ja_JP': 'ja',
    };

    return map[locale] ?? null;
  }
}

// ===== 模組導出 =====

/** 全域單例（使用前需呼叫 createI18n 初始化）*/
let _instance: I18n | null = null;

/**
 * 建立並初始化 I18n 實例
 * @param localesDir 語言檔目錄
 * @param defaultLocale 初始語系
 */
export function createI18n(localesDir: string, defaultLocale?: string): I18n {
  _instance = new I18n(localesDir, defaultLocale);
  return _instance;
}

/**
 * 取得全域 I18n 單例
 * 必須先呼叫 createI18n 初始化
 */
export function getI18n(): I18n {
  if (!_instance) {
    throw new Error('I18n 尚未初始化，請先呼叫 createI18n()');
  }
  return _instance;
}

export default I18n;
