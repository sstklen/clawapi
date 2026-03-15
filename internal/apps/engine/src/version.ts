// 動態版本號 — 編譯時從 package.json 注入（Bun JSON import）
// 優點：打包成獨立執行檔後版本號仍正確（不依賴執行時讀檔）
// 之前用 readFileSync，在 bun compile 後找不到 package.json → 顯示 unknown 或 v0.1.0

import pkg from '../package.json';

/**
 * 取得引擎版本號
 * 使用 JSON import 在打包時直接嵌入版本，不依賴執行時讀取 package.json
 */
export function getEngineVersion(): string {
  return pkg.version ?? 'unknown';
}
