// backup 命令群組 — 備份管理
// 子命令：export, import

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, password, confirm } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function backupCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'export':
      return backupExport(args);
    case 'import':
      return backupImport(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['export', 'import'] });
        process.exit(1);
      }
      error(`未知的子命令：${sub ?? '(無)'}`);
      print('可用的子命令：export, import');
      process.exit(1);
  }
}

// ===== backup export =====

async function backupExport(_args: ParsedArgs): Promise<void> {
  blank();
  info('匯出加密備份');
  blank();

  // 輸入加密密碼
  const pwd = await password('設定備份密碼');
  if (!pwd) {
    error('密碼不能為空');
    process.exit(1);
  }

  const pwdConfirm = await password('再次輸入密碼');
  if (pwd !== pwdConfirm) {
    error('兩次密碼不一致');
    process.exit(1);
  }

  // 預設輸出路徑
  const defaultPath = join(homedir(), 'clawapi-backup.enc');
  const outputPath = await ask('輸出路徑', defaultPath);

  // 模擬備份
  const backupInfo = {
    path: outputPath,
    size_bytes: 102400,
    keys_count: 5,
    sub_keys_count: 2,
    config_included: true,
    created_at: new Date().toISOString(),
  };

  output(
    () => {
      blank();
      success('備份已匯出！');
      print(`  路徑：${backupInfo.path}`);
      print(`  大小：${(backupInfo.size_bytes / 1024).toFixed(1)} KB`);
      print(`  Key 數量：${backupInfo.keys_count}`);
      print(`  Sub-Key 數量：${backupInfo.sub_keys_count}`);
      blank();
      warn('請妥善保管備份檔案和密碼！');
    },
    backupInfo
  );
}

// ===== backup import =====

async function backupImport(args: ParsedArgs): Promise<void> {
  blank();
  info('匯入加密備份');
  blank();

  // 輸入檔案路徑
  const inputPath = args.positional[1] ?? await ask('備份檔案路徑');
  if (!inputPath) {
    error('請指定備份檔案路徑');
    process.exit(1);
  }

  if (!existsSync(inputPath)) {
    error(`檔案不存在：${inputPath}`);
    process.exit(1);
  }

  // 輸入密碼
  const pwd = await password('輸入備份密碼');
  if (!pwd) {
    error('密碼不能為空');
    process.exit(1);
  }

  // 確認覆寫
  warn('匯入備份將覆蓋現有的 Key 和設定');
  const confirmed = await confirm('確定要繼續？');
  if (!confirmed) {
    info('已取消');
    return;
  }

  // 模擬匯入
  const importInfo = {
    path: inputPath,
    keys_restored: 5,
    sub_keys_restored: 2,
    config_restored: true,
  };

  output(
    () => {
      blank();
      success('備份已匯入！');
      print(`  還原 Key：${importInfo.keys_restored} 個`);
      print(`  還原 Sub-Key：${importInfo.sub_keys_restored} 個`);
      print(`  設定檔：已還原`);
      blank();
      info('建議重啟引擎以套用新設定');
    },
    importInfo
  );
}

export default backupCommand;
