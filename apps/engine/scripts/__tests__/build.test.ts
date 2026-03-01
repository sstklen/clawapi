// ============================================================
// 打包 + 發布配置驗證測試
// 驗證：package.json 配置、build script、install.sh、平台目標
// ============================================================

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { CLAWAPI_VERSION } from '@clawapi/protocol';

// 專案根目錄（從 apps/engine/scripts/__tests__ 往上 4 層）
const ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const ENGINE_DIR = resolve(ROOT, 'apps', 'engine');

// ===== 輔助函數 =====

/** 讀取檔案內容 */
function readFile(relativePath: string): string {
  const fullPath = resolve(ROOT, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`檔案不存在：${fullPath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

/** 檢查檔案是否存在 */
function fileExists(relativePath: string): boolean {
  return existsSync(resolve(ROOT, relativePath));
}

/** 讀取 JSON 檔案 */
function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFile(relativePath));
}

// ===== package.json 配置測試 =====

describe('package.json 打包配置', () => {
  let pkg: Record<string, unknown>;

  test('檔案存在', () => {
    expect(fileExists('apps/engine/package.json')).toBe(true);
    pkg = readJson('apps/engine/package.json');
  });

  test('name 為 @clawapi/engine', () => {
    pkg = readJson('apps/engine/package.json');
    expect(pkg.name).toBe('@clawapi/engine');
  });

  test('version 與 CLAWAPI_VERSION 一致', () => {
    pkg = readJson('apps/engine/package.json');
    expect(pkg.version).toBe(CLAWAPI_VERSION);
  });

  test('有 bin 配置', () => {
    pkg = readJson('apps/engine/package.json');
    expect(pkg.bin).toBeDefined();
    const bin = pkg.bin as Record<string, string>;
    expect(bin.clawapi).toBeDefined();
    expect(typeof bin.clawapi).toBe('string');
  });

  test('bin 指向 CLI 入口點', () => {
    pkg = readJson('apps/engine/package.json');
    const bin = pkg.bin as Record<string, string>;
    expect(bin.clawapi).toContain('cli/index.ts');
  });

  test('有 files 配置', () => {
    pkg = readJson('apps/engine/package.json');
    expect(pkg.files).toBeDefined();
    expect(Array.isArray(pkg.files)).toBe(true);
    const files = pkg.files as string[];
    expect(files.length).toBeGreaterThan(0);
  });

  test('files 包含 src 和 dist', () => {
    pkg = readJson('apps/engine/package.json');
    const files = pkg.files as string[];
    expect(files.some(f => f.includes('src'))).toBe(true);
    expect(files.some(f => f.includes('dist'))).toBe(true);
  });

  test('有 main 配置', () => {
    pkg = readJson('apps/engine/package.json');
    expect(pkg.main).toBeDefined();
    expect(typeof pkg.main).toBe('string');
  });

  test('有 types 配置', () => {
    pkg = readJson('apps/engine/package.json');
    expect(pkg.types).toBeDefined();
    expect(typeof pkg.types).toBe('string');
  });

  test('scripts.build 指向 build script', () => {
    pkg = readJson('apps/engine/package.json');
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.build).toContain('scripts/build.ts');
  });

  test('scripts 有 build:current 快速打包', () => {
    pkg = readJson('apps/engine/package.json');
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts['build:current']).toBeDefined();
    expect(scripts['build:current']).toContain('--compile');
  });

  test('license 為 AGPL-3.0', () => {
    pkg = readJson('apps/engine/package.json');
    expect(pkg.license).toBe('AGPL-3.0');
  });
});

// ===== Build Script 測試 =====

describe('build.ts 打包腳本', () => {
  test('檔案存在', () => {
    expect(fileExists('apps/engine/scripts/build.ts')).toBe(true);
  });

  test('可被 Bun 解析（語法正確）', async () => {
    // 用 dynamic import 驗證語法正確性
    // build.ts 的主流程在 main() 中，import 時不會執行打包
    // 但會執行頂層程式碼，所以我們用 Bun transpiler 驗證語法
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const source = readFile('apps/engine/scripts/build.ts');
    const result = transpiler.transformSync(source);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  test('定義四個平台 target', () => {
    const source = readFile('apps/engine/scripts/build.ts');
    expect(source).toContain('linux-x64');
    expect(source).toContain('darwin-arm64');
    expect(source).toContain('darwin-x64');
    expect(source).toContain('windows-x64');
  });

  test('有四個輸出檔名', () => {
    const source = readFile('apps/engine/scripts/build.ts');
    expect(source).toContain('clawapi-linux-x64');
    expect(source).toContain('clawapi-darwin-arm64');
    expect(source).toContain('clawapi-darwin-x64');
    expect(source).toContain('clawapi-win-x64.exe');
  });

  test('引用 CLAWAPI_VERSION', () => {
    const source = readFile('apps/engine/scripts/build.ts');
    expect(source).toContain('CLAWAPI_VERSION');
  });

  test('入口點指向 CLI', () => {
    const source = readFile('apps/engine/scripts/build.ts');
    // build.ts 用 resolve() 組合路徑，分別含有 'cli' 和 'index.ts'
    expect(source).toContain("'cli'");
    expect(source).toContain("'index.ts'");
  });

  test('打包前清理 dist 目錄', () => {
    const source = readFile('apps/engine/scripts/build.ts');
    expect(source).toContain('rmSync');
    expect(source).toContain('dist');
  });

  test('使用 --compile 參數', () => {
    const source = readFile('apps/engine/scripts/build.ts');
    expect(source).toContain('--compile');
  });

  test('顯示檔案大小', () => {
    const source = readFile('apps/engine/scripts/build.ts');
    expect(source).toContain('formatSize');
  });

  test('匯出 BUILD_TARGETS 供外部使用', () => {
    const source = readFile('apps/engine/scripts/build.ts');
    expect(source).toContain('export const BUILD_TARGETS');
  });
});

// ===== install.sh 測試 =====

describe('install.sh 安裝腳本', () => {
  test('檔案存在', () => {
    expect(fileExists('scripts/install.sh')).toBe(true);
  });

  test('bash -n 語法檢查通過', () => {
    const result = Bun.spawnSync(['bash', '-n', resolve(ROOT, 'scripts/install.sh')]);
    expect(result.exitCode).toBe(0);
  });

  test('使用 set -euo pipefail', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('set -euo pipefail');
  });

  test('偵測平台（Linux/macOS/Windows）', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('uname');
    expect(source).toContain('Linux');
    expect(source).toContain('Darwin');
  });

  test('偵測架構（x64/arm64）', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('x86_64');
    expect(source).toContain('arm64');
  });

  test('支援 --version 參數', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('--version');
  });

  test('驗證 checksum', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('sha256');
    expect(source).toContain('checksum');
  });

  test('安裝到 /usr/local/bin', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('/usr/local/bin');
  });

  test('需要時使用 sudo', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('sudo');
  });

  test('設定可執行權限', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('chmod +x');
  });

  test('有 shebang 行', () => {
    const source = readFile('scripts/install.sh');
    expect(source.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('清理暫存目錄（trap）', () => {
    const source = readFile('scripts/install.sh');
    expect(source).toContain('trap');
    expect(source).toContain('mktemp');
  });
});

// ===== CLI 入口點存在性測試 =====

describe('CLI 入口點', () => {
  test('入口檔案存在', () => {
    expect(fileExists('apps/engine/src/cli/index.ts')).toBe(true);
  });

  test('匯出 main 函數', () => {
    const source = readFile('apps/engine/src/cli/index.ts');
    expect(source).toContain('export async function main');
  });

  test('支援 import.meta.main 直接執行', () => {
    const source = readFile('apps/engine/src/cli/index.ts');
    expect(source).toContain('import.meta.main');
  });
});

// ===== 版本一致性測試 =====

describe('版本一致性', () => {
  test('protocol CLAWAPI_VERSION 有值', () => {
    expect(CLAWAPI_VERSION).toBeDefined();
    expect(typeof CLAWAPI_VERSION).toBe('string');
    expect(CLAWAPI_VERSION.length).toBeGreaterThan(0);
  });

  test('CLAWAPI_VERSION 符合 semver 格式', () => {
    const semverRegex = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
    expect(semverRegex.test(CLAWAPI_VERSION)).toBe(true);
  });

  test('package.json version 與 protocol 一致', () => {
    const pkg = readJson('apps/engine/package.json');
    expect(pkg.version).toBe(CLAWAPI_VERSION);
  });
});
