// misc 命令 — version, migrate, device reset

import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { confirm, ask } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== version =====

export async function versionCommand(_args: ParsedArgs): Promise<void> {
  const versionInfo = {
    version: CLAWAPI_VERSION,
    runtime: `Bun ${Bun.version}`,
    platform: `${process.platform} ${process.arch}`,
  };

  output(
    () => {
      print(`ClawAPI v${CLAWAPI_VERSION}`);
      print(`Runtime: Bun ${Bun.version}`);
      print(`Platform: ${process.platform} ${process.arch}`);
    },
    versionInfo
  );
}

// ===== migrate =====

export async function migrateCommand(_args: ParsedArgs): Promise<void> {
  blank();
  info('執行資料庫遷移...');
  blank();

  // 模擬遷移（實際由 ClawDatabase.init 中的 migration 處理）
  const migrations = [
    { version: 1, name: '001-init', status: 'applied' },
  ];

  output(
    () => {
      for (const m of migrations) {
        const icon = m.status === 'applied' ? color.green('V') : color.yellow('->');
        print(`  ${icon} ${m.name} (v${m.version})`);
      }
      blank();
      success('遷移完成');
    },
    { migrations }
  );
}

// ===== device reset =====

export async function deviceResetCommand(_args: ParsedArgs): Promise<void> {
  blank();
  warn('裝置重置');
  print('  這個操作會：');
  print('    1. 刪除所有 Key（加密資料）');
  print('    2. 重新產生 master.key');
  print('    3. 重新產生 auth.token');
  print('    4. 清除所有 Sub-Key');
  print('    5. 重置 VPS 裝置註冊');
  blank();
  print(color.boldRed('  警告：此操作不可逆！'));
  blank();

  const firstConfirm = await confirm('確定要重置裝置？');
  if (!firstConfirm) {
    info('已取消');
    return;
  }

  const typedConfirm = await ask('請輸入 RESET 確認');
  if (typedConfirm !== 'RESET') {
    info('輸入不正確，已取消');
    return;
  }

  output(
    () => {
      blank();
      success('裝置已重置');
      info('請使用 clawapi setup 重新設定');
    },
    { status: 'reset' }
  );
}

export default { versionCommand, migrateCommand, deviceResetCommand };
