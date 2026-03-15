// CLI i18n 便捷模組
// 包裝 core/i18n 的 getI18n().t()，提供簡潔的 t() 函式給所有 CLI 命令使用
// 若 i18n 尚未初始化（例如在 --help 等極早期路徑），回傳 key 本身
//
// Locale 偵測優先順序：CLI --locale > config.yaml ui.locale > 系統 LANG > 'en'

import { getI18n, createI18n } from '../../core/i18n';
import type { TranslateParams } from '../../core/i18n';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * 翻譯指定 key
 * 用法：t('cmd.start.ready') 或 t('cmd.start.port', { port: 4141 })
 */
export function t(key: string, params?: TranslateParams): string {
  try {
    return getI18n().t(key, params);
  } catch {
    // i18n 尚未初始化時回傳 key 本身
    return key;
  }
}

/**
 * 從 config.yaml 讀取 ui.locale（輕量級，不依賴完整 config 載入）
 * 只做簡單的文字匹配，不解析完整 YAML
 */
function readConfigLocale(): string | undefined {
  try {
    const configPath = join(homedir(), '.clawapi', 'config.yaml');
    if (!existsSync(configPath)) return undefined;
    const content = readFileSync(configPath, 'utf8');
    // 簡單匹配 "locale: zh-TW" 或 "locale: ja" 等
    const match = content.match(/^\s*locale:\s*(.+)$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * 初始化 CLI 多語系
 * 必須在 CLI main() 的最開頭呼叫
 *
 * 偵測順序：CLI --locale > config.yaml ui.locale > 系統 LANG > 'en'
 */
export function initCliI18n(cliLocale?: string): void {
  // 從 src/cli/utils/ 往上三層到 apps/engine/，再進入 locales/
  const localesDir = join(import.meta.dir, '..', '..', '..', 'locales');
  // CLI 旗標優先；沒有的話讀 config.yaml 的 ui.locale
  const locale = cliLocale || readConfigLocale();
  createI18n(localesDir, locale);
}
