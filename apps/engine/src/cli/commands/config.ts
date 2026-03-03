// config 命令群組 — 設定檔管理
// 子命令：show, set

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function configCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'show':
      return configShow(args);
    case 'set':
      return configSet(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['show', 'set'] });
        process.exit(1);
      }
      error(t('cmd.config.unknown_subcommand', { sub: sub ?? t('common.none') }));
      print(t('cmd.config.available_subcommands'));
      process.exit(1);
  }
}

// ===== config show =====

async function configShow(_args: ParsedArgs): Promise<void> {
  const configPath = join(homedir(), '.clawapi', 'config.yaml');

  if (!existsSync(configPath)) {
    output(
      () => {
        blank();
        info(t('cmd.config.no_config'));
        print(`  ${t('cmd.config.expected_path')}${configPath}`);
        print(`  ${t('cmd.config.use_setup', { cmd: color.cyan('clawapi setup') })}`);
        blank();
      },
      { exists: false, path: configPath }
    );
    return;
  }

  const content = readFileSync(configPath, 'utf8');

  output(
    () => {
      blank();
      info(t('cmd.config.config_file', { path: configPath }));
      blank();
      print(content);
      blank();
    },
    {
      exists: true,
      path: configPath,
      content,
    }
  );
}

// ===== config set =====

async function configSet(args: ParsedArgs): Promise<void> {
  const key = args.positional[1];
  const value = args.positional[2];

  if (!key || value === undefined) {
    error(t('cmd.config.set_usage'));
    print(`  ${t('cmd.config.set_examples')}`);
    print('    clawapi config set server.port 8080');
    print('    clawapi config set routing.default_strategy fast');
    print('    clawapi config set ui.locale en');
    print('    clawapi config set telemetry.enabled false');
    process.exit(1);
  }

  // 驗證 key 路徑
  const validPrefixes = [
    'server.', 'routing.', 'claw_key.', 'telemetry.', 'l0.',
    'aid.', 'vps.', 'ui.', 'logging.', 'backup.', 'notifications.', 'advanced.',
  ];

  const isValidKey = validPrefixes.some(prefix => key.startsWith(prefix));
  if (!isValidKey) {
    error(t('cmd.config.invalid_key', { key }));
    print(`  ${t('cmd.config.valid_prefixes', { prefixes: validPrefixes.map(p => p.slice(0, -1)).join(', ') })}`);
    process.exit(1);
  }

  // 型別轉換
  let parsedValue: unknown = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (value === 'null') parsedValue = null;
  else if (/^\d+$/.test(value)) parsedValue = parseInt(value, 10);
  else if (/^\d+\.\d+$/.test(value)) parsedValue = parseFloat(value);

  output(
    () => {
      success(t('cmd.config.updated', { key, value: JSON.stringify(parsedValue) }));
      info(t('common.restart_required'));
    },
    {
      status: 'updated',
      key,
      value: parsedValue,
    }
  );
}

export default configCommand;
