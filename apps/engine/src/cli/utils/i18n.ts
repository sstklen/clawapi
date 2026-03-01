// CLI i18n 便捷模組
// 包裝 core/i18n 的 getI18n().t()，提供簡潔的 t() 函式給所有 CLI 命令使用
// 若 i18n 尚未初始化（例如在 --help 等極早期路徑），回傳 key 本身

import { getI18n, createI18n } from '../../core/i18n';
import type { TranslateParams } from '../../core/i18n';
import { join } from 'node:path';

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
 * 初始化 CLI 多語系
 * 必須在 CLI main() 的最開頭呼叫
 */
export function initCliI18n(cliLocale?: string): void {
  // 從 src/cli/utils/ 往上三層到 apps/engine/，再進入 locales/
  const localesDir = join(import.meta.dir, '..', '..', '..', 'locales');
  createI18n(localesDir, cliLocale);
}
