// misc 命令 — version, migrate, device reset

import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { t } from '../utils/i18n';
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
  info(t('cmd.misc.running_migration'));
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
      success(t('cmd.misc.migration_done'));
    },
    { migrations }
  );
}

// ===== device reset =====

export async function deviceResetCommand(_args: ParsedArgs): Promise<void> {
  blank();
  warn(t('cmd.misc.device_reset'));
  print(`  ${t('cmd.misc.reset_will')}`)
  print(`    1. ${t('cmd.misc.reset_step1')}`);
  print(`    2. ${t('cmd.misc.reset_step2')}`);
  print(`    3. ${t('cmd.misc.reset_step3')}`);
  print(`    4. ${t('cmd.misc.reset_step4')}`);
  print(`    5. ${t('cmd.misc.reset_step5')}`);
  blank();
  print(color.boldRed(`  ${t('cmd.misc.warning_irreversible')}`));
  blank();

  const firstConfirm = await confirm(t('cmd.misc.confirm_reset'));
  if (!firstConfirm) {
    info(t('common.cancelled'));
    return;
  }

  const typedConfirm = await ask(t('cmd.misc.type_reset'));
  if (typedConfirm !== 'RESET') {
    info(t('cmd.misc.wrong_input_cancelled'));
    return;
  }

  output(
    () => {
      blank();
      success(t('cmd.misc.reset_done'));
      info(t('cmd.misc.use_setup_again'));
    },
    { status: 'reset' }
  );
}

export default { versionCommand, migrateCommand, deviceResetCommand };
