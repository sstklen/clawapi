// config 命令群組 — 設定檔管理
// 子命令：show, set

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
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
      error(`未知的子命令：${sub ?? '(無)'}`);
      print('可用的子命令：show, set');
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
        info('尚未建立設定檔，使用預設值');
        print(`  預期路徑：${configPath}`);
        print(`  使用 ${color.cyan('clawapi setup')} 進行初始設定`);
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
      info(`設定檔：${configPath}`);
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
    error('用法：clawapi config set <key> <value>');
    print('  範例：');
    print('    clawapi config set server.port 8080');
    print('    clawapi config set routing.default_strategy fast');
    print('    clawapi config set ui.locale en');
    print('    clawapi config set telemetry.enabled false');
    process.exit(1);
  }

  // 驗證 key 路徑
  const validPrefixes = [
    'server.', 'routing.', 'gold_key.', 'telemetry.', 'l0.',
    'aid.', 'vps.', 'ui.', 'logging.', 'backup.', 'notifications.', 'advanced.',
  ];

  const isValidKey = validPrefixes.some(prefix => key.startsWith(prefix));
  if (!isValidKey) {
    error(`無效的設定 key：${key}`);
    print(`  有效的前綴：${validPrefixes.map(p => p.slice(0, -1)).join(', ')}`);
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
      success(`已更新設定：${key} = ${JSON.stringify(parsedValue)}`);
      info('重啟引擎後生效');
    },
    {
      status: 'updated',
      key,
      value: parsedValue,
    }
  );
}

export default configCommand;
