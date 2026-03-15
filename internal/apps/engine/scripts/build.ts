#!/usr/bin/env bun
// ============================================================
// ClawAPI 引擎 — 跨平台打包腳本
// 使用 Bun compile 打包四個平台的可執行檔
// 用法：bun run scripts/build.ts
// ============================================================

import { $ } from 'bun';
import { resolve, basename } from 'path';
import { existsSync, rmSync, mkdirSync, statSync } from 'fs';
import { CLAWAPI_VERSION } from '@clawapi/protocol';

// ===== 設定 =====

/** 入口點 */
const ENTRY_POINT = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');

/** 輸出目錄 */
const DIST_DIR = resolve(import.meta.dir, '..', 'dist');

/** 目標平台定義 */
export const BUILD_TARGETS = [
  { name: 'clawapi-linux-x64',       target: 'bun-linux-x64'    as const },
  { name: 'clawapi-darwin-arm64',     target: 'bun-darwin-arm64' as const },
  { name: 'clawapi-darwin-x64',       target: 'bun-darwin-x64'   as const },
  { name: 'clawapi-win-x64.exe',      target: 'bun-windows-x64'  as const },
] as const;

// ===== 輔助函數 =====

/** 格式化檔案大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 輸出帶顏色的訊息 */
function log(msg: string): void {
  console.log(`\x1b[34m[build]\x1b[0m ${msg}`);
}

function logOk(msg: string): void {
  console.log(`\x1b[32m[build]\x1b[0m ${msg}`);
}

function logError(msg: string): void {
  console.error(`\x1b[31m[build]\x1b[0m ${msg}`);
}

// ===== 主流程 =====

async function main(): Promise<void> {
  console.log('');
  log(`ClawAPI 引擎打包 v${CLAWAPI_VERSION}`);
  log(`入口點：${ENTRY_POINT}`);
  log(`輸出目錄：${DIST_DIR}`);
  console.log('');

  // 確認入口點存在
  if (!existsSync(ENTRY_POINT)) {
    logError(`入口點不存在：${ENTRY_POINT}`);
    process.exit(1);
  }

  // 清理 dist/ 目錄
  if (existsSync(DIST_DIR)) {
    log('清理 dist/ 目錄...');
    rmSync(DIST_DIR, { recursive: true, force: true });
  }
  mkdirSync(DIST_DIR, { recursive: true });

  // 逐平台打包
  const results: Array<{ name: string; size: string; ok: boolean }> = [];

  for (const { name, target } of BUILD_TARGETS) {
    const outfile = resolve(DIST_DIR, name);
    log(`打包 ${name}（${target}）...`);

    try {
      // 使用 bun build --compile 打包為可執行檔
      const proc = Bun.spawn([
        'bun', 'build',
        ENTRY_POINT,
        '--compile',
        `--target=${target}`,
        `--outfile=${outfile}`,
        '--minify',
        `--define=CLAWAPI_BUILD_VERSION="${CLAWAPI_VERSION}"`,
      ], {
        cwd: resolve(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        logError(`打包 ${name} 失敗（exit code: ${exitCode}）`);
        if (stderr) logError(stderr);
        results.push({ name, size: '-', ok: false });
        continue;
      }

      // 取得檔案大小
      if (existsSync(outfile)) {
        const stat = statSync(outfile);
        const size = formatSize(stat.size);
        logOk(`${name} ✓ (${size})`);
        results.push({ name, size, ok: true });
      } else {
        logError(`${name} — 輸出檔案不存在`);
        results.push({ name, size: '-', ok: false });
      }
    } catch (err) {
      logError(`打包 ${name} 時發生錯誤：${err}`);
      results.push({ name, size: '-', ok: false });
    }
  }

  // 輸出結果摘要
  console.log('');
  console.log('============================================================');
  log('打包結果摘要');
  console.log('============================================================');
  console.log('');

  const maxNameLen = Math.max(...results.map(r => r.name.length));
  for (const { name, size, ok } of results) {
    const status = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const paddedName = name.padEnd(maxNameLen + 2);
    console.log(`  ${status}  ${paddedName}${size}`);
  }

  console.log('');

  const successCount = results.filter(r => r.ok).length;
  const totalCount = results.length;

  if (successCount === totalCount) {
    logOk(`全部 ${totalCount} 個平台打包成功！`);
  } else {
    logError(`${successCount}/${totalCount} 個平台打包成功`);
    process.exit(1);
  }
}

// 直接執行
main().catch((err) => {
  logError(`打包失敗：${err}`);
  process.exit(1);
});
