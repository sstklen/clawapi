// backup 命令群組 — 備份管理
// 子命令：export, import

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, password, confirm } from '../utils/prompt';
import { t } from '../utils/i18n';
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
      error(t('common.unknown_subcmd', { subcmd: sub ?? '(無)' }));
      print(t('common.available_subcmds', { list: 'export, import' }));
      process.exit(1);
  }
}

// ===== backup export =====

async function backupExport(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.backup.export_title'));
  blank();

  // 輸入加密密碼
  const pwd = await password(t('cmd.backup.set_password'));
  if (!pwd) {
    error(t('cmd.backup.password_empty'));
    process.exit(1);
  }

  const pwdConfirm = await password(t('cmd.backup.confirm_password'));
  if (pwd !== pwdConfirm) {
    error(t('cmd.backup.password_mismatch'));
    process.exit(1);
  }

  // 預設輸出路徑
  const defaultPath = join(homedir(), 'clawapi-backup.enc');
  const outputPath = await ask(t('cmd.backup.output_path'), defaultPath);

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
      success(t('cmd.backup.export_done'));
      print(`  ${t('cmd.backup.path_label')}：${backupInfo.path}`);
      print(`  ${t('cmd.backup.size_label')}：${(backupInfo.size_bytes / 1024).toFixed(1)} KB`);
      print(`  ${t('cmd.backup.keys_count')}：${backupInfo.keys_count}`);
      print(`  ${t('cmd.backup.sub_keys_count')}：${backupInfo.sub_keys_count}`);
      blank();
      warn(t('cmd.backup.keep_safe_warning'));
    },
    backupInfo
  );
}

// ===== backup import =====

async function backupImport(args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.backup.import_title'));
  blank();

  // 輸入檔案路徑
  const inputPath = args.positional[1] ?? await ask(t('cmd.backup.file_path'));
  if (!inputPath) {
    error(t('cmd.backup.file_path_required'));
    process.exit(1);
  }

  if (!existsSync(inputPath)) {
    error(t('cmd.backup.file_not_found', { path: inputPath }));
    process.exit(1);
  }

  // 輸入密碼
  const pwd = await password(t('cmd.backup.enter_password'));
  if (!pwd) {
    error(t('cmd.backup.password_empty'));
    process.exit(1);
  }

  // 確認覆寫
  warn(t('cmd.backup.import_overwrite_warning'));
  const confirmed = await confirm(t('cmd.backup.continue_confirm'));
  if (!confirmed) {
    info(t('common.cancelled'));
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
      success(t('cmd.backup.import_done'));
      print(`  ${t('cmd.backup.restored_keys')}：${importInfo.keys_restored} ${t('cmd.backup.count_unit')}`);
      print(`  ${t('cmd.backup.restored_sub_keys')}：${importInfo.sub_keys_restored} ${t('cmd.backup.count_unit')}`);
      print(`  ${t('cmd.backup.config_label')}：${t('cmd.backup.restored')}`);
      blank();
      info(t('cmd.backup.restart_suggestion'));
    },
    importInfo
  );
}

export default backupCommand;
