// 動態版本號 — 從 engine 的 package.json 讀取
// 避免跟 @clawapi/protocol 的 CLAWAPI_VERSION 常數不同步
// （protocol 套件版本可能沒跟 engine 一起發新版）
//
// 此檔案位於 src/version.ts → package.json 在上一層 (apps/engine/package.json)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let _version: string | null = null;

/**
 * 從 engine 的 package.json 動態讀取版本號
 * 結果會快取，整個 process 只讀一次
 */
export function getEngineVersion(): string {
  if (_version !== null) return _version;

  try {
    // src/ → apps/engine/（上一層）
    const pkgPath = join(import.meta.dir, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    _version = pkg.version || 'unknown';
  } catch {
    _version = 'unknown';
  }

  return _version;
}
