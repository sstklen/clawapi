#!/usr/bin/env bun
// ClawAPI CLI 主進入點
// 使用 process.argv 手動解析，不依賴外部 CLI 框架
// 支援全域旗標：--plain, --json, --locale

import { getEngineVersion } from './utils/version';
import { setOutputMode, print, color, blank, error } from './utils/output';
import { initCliI18n, t } from './utils/i18n';

// ===== 型別定義 =====

/** 解析後的 CLI 參數 */
export interface ParsedArgs {
  /** 主命令（如 start, keys, doctor） */
  command: string;
  /** 子命令和位置參數 */
  positional: string[];
  /** 旗標（--key=value 或 --flag） */
  flags: Record<string, string | boolean>;
}

// ===== 參數解析器 =====

/**
 * 解析 process.argv
 * 支援格式：
 *   --flag        → { flag: true }
 *   --key=value   → { key: 'value' }
 *   --key value   → { key: 'value' }
 *   -p value      → { p: 'value' }
 *   -p=value      → { p: 'value' }
 *
 * 位置參數收集在 positional 陣列中
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // 跳過 bun / node 和腳本路徑
  const args = argv.slice(2);

  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = '';

  // 需要值的短旗標
  const shortFlagsWithValue = new Set(['p', 'h', 'n']);

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--') {
      // 之後都是位置參數
      positional.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      // 長旗標
      const withoutDashes = arg.slice(2);

      if (withoutDashes.includes('=')) {
        // --key=value
        const eqIndex = withoutDashes.indexOf('=');
        const key = withoutDashes.slice(0, eqIndex);
        const value = withoutDashes.slice(eqIndex + 1);
        flags[key] = value;
      } else {
        // --flag 或 --key value
        const nextArg = args[i + 1];
        // 如果下一個參數不是旗標且不是命令，視為值
        if (nextArg && !nextArg.startsWith('-') && isValueFlag(withoutDashes)) {
          flags[withoutDashes] = nextArg;
          i++;
        } else {
          flags[withoutDashes] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      // 短旗標
      const flag = arg.slice(1);

      if (flag.includes('=')) {
        const eqIndex = flag.indexOf('=');
        const key = flag.slice(0, eqIndex);
        const value = flag.slice(eqIndex + 1);
        flags[key] = value;
      } else if (shortFlagsWithValue.has(flag)) {
        // 需要值的短旗標
        const nextArg = args[i + 1];
        if (nextArg && !nextArg.startsWith('-')) {
          flags[flag] = nextArg;
          i++;
        } else {
          flags[flag] = true;
        }
      } else {
        flags[flag] = true;
      }
    } else {
      // 位置參數
      if (!command) {
        command = arg;
      } else {
        positional.push(arg);
      }
    }

    i++;
  }

  return { command, positional, flags };
}

/** 判斷一個長旗標是否需要接值 */
function isValueFlag(flag: string): boolean {
  const valueFlags = new Set([
    'port', 'host', 'locale', 'service', 'export', 'n',
    // sub-keys issue 非互動模式用
    'label', 'limit', 'expire', 'rate', 'services',
  ]);
  return valueFlags.has(flag);
}

// ===== 幫助文字 =====

function printHelp(): void {
  blank();
  print(color.bold(`ClawAPI v${getEngineVersion()}`));
  print(color.dim(t('help.subtitle')));
  blank();
  print(color.bold(t('help.usage_title')));
  print(`  ${t('help.usage_line')}`);
  blank();
  print(color.bold('  ⚡ 快速開始'));
  print(`  init               一行完成初始化（建 config + 註冊 MCP）`);
  print(`  init --force       強制重新初始化（覆蓋已有 config）`);
  print(`  init --no-mcp      只建 config，不動 MCP 設定`);
  print(`  uninstall          清除 ClawAPI 所有設定和 MCP 註冊`);
  print(`  uninstall --all    完全移除（含 API Key 和資料庫）`);
  blank();
  print(color.bold(t('help.section.engine')));
  print(`  start              ${t('help.engine.start')}`);
  print(`  stop               ${t('help.engine.stop')}`);
  print(`  status             ${t('help.engine.status')}`);
  blank();
  print(color.bold(t('help.section.keys')));
  print(`  keys add           ${t('help.keys.add')}`);
  print(`  keys list          ${t('help.keys.list')}`);
  print(`  keys remove <id>   ${t('help.keys.remove')}`);
  print(`  keys pin <id>      ${t('help.keys.pin')}`);
  print(`  keys rotate <id>   ${t('help.keys.rotate')}`);
  print(`  keys import        ${t('help.keys.import')}`);
  print(`  keys check         ${t('help.keys.check')}`);
  blank();
  print(color.bold(t('help.section.claw_key')));
  print(`  claw-key set       ${t('help.claw_key.set')}`);
  print(`  claw-key show      ${t('help.claw_key.show')}`);
  print(`  claw-key remove    ${t('help.claw_key.remove')}`);
  blank();
  print(color.bold(t('help.section.sub_keys')));
  print(`  sub-keys issue     ${t('help.sub_keys.issue')}`);
  print(`  sub-keys list      ${t('help.sub_keys.list')}`);
  print(`  sub-keys revoke <id>  ${t('help.sub_keys.revoke')}`);
  print(`  sub-keys usage <id>   ${t('help.sub_keys.usage')}`);
  blank();
  print(color.bold(t('help.section.aid')));
  print(`  aid config         ${t('help.aid.config')}`);
  print(`  aid stats          ${t('help.aid.stats')}`);
  print(`  aid donate         ${t('help.aid.donate')}`);
  blank();
  print(color.bold(t('help.section.adapters')));
  print(`  adapters list      ${t('help.adapters.list')}`);
  print(`  adapters install <url>  ${t('help.adapters.install')}`);
  print(`  adapters remove <id>    ${t('help.adapters.remove')}`);
  print(`  adapters update    ${t('help.adapters.update')}`);
  blank();
  print(color.bold(t('help.section.telemetry')));
  print(`  telemetry show     ${t('help.telemetry.show')}`);
  print(`  telemetry toggle   ${t('help.telemetry.toggle')}`);
  blank();
  print(color.bold(t('help.section.backup')));
  print(`  backup export      ${t('help.backup.export')}`);
  print(`  backup import      ${t('help.backup.import')}`);
  blank();
  print(color.bold(t('help.section.misc')));
  print(`  logs               ${t('help.misc.logs')}`);
  print(`  config show        ${t('help.misc.config_show')}`);
  print(`  config set <key> <value>  ${t('help.misc.config_set')}`);
  print(`  migrate            ${t('help.misc.migrate')}`);
  print(`  device reset       ${t('help.misc.device_reset')}`);
  print(`  version            ${t('help.misc.version')}`);
  print(`  setup              ${t('help.misc.setup')}`);
  print(`  doctor             ${t('help.misc.doctor')}`);
  print(`  mcp                啟動 MCP Server（供 Claude Code 等 AI 工具使用）`);
  print(`  mcp --install      將 ClawAPI 註冊到 Claude Code（可重複執行）`);
  print(`  mcp --uninstall    從 Claude Code 移除 ClawAPI MCP 設定`);
  blank();
  print(color.bold(t('help.section.global_options')));
  print(`  --plain            ${t('help.options.plain')}`);
  print(`  --json             ${t('help.options.json')}`);
  print(`  --locale <locale>  ${t('help.options.locale')}`);
  print(`  --help, -h         ${t('help.options.help')}`);
  blank();
}

// ===== 命令路由 =====

async function route(parsed: ParsedArgs): Promise<void> {
  const { command } = parsed;

  switch (command) {
    case 'start': {
      const { startCommand } = await import('./commands/start');
      return startCommand(parsed);
    }
    case 'stop': {
      const { stopCommand } = await import('./commands/stop');
      return stopCommand(parsed);
    }
    case 'status': {
      const { statusCommand } = await import('./commands/status');
      return statusCommand(parsed);
    }
    case 'keys': {
      const { keysCommand } = await import('./commands/keys');
      return keysCommand(parsed);
    }
    case 'claw-key': {
      const { clawKeyCommand } = await import('./commands/claw-key');
      return clawKeyCommand(parsed);
    }
    case 'sub-keys': {
      const { subKeysCommand } = await import('./commands/sub-keys');
      return subKeysCommand(parsed);
    }
    case 'aid': {
      const { aidCommand } = await import('./commands/aid');
      return aidCommand(parsed);
    }
    case 'adapters': {
      const { adaptersCommand } = await import('./commands/adapters');
      return adaptersCommand(parsed);
    }
    case 'telemetry': {
      const { telemetryCommand } = await import('./commands/telemetry');
      return telemetryCommand(parsed);
    }
    case 'backup': {
      const { backupCommand } = await import('./commands/backup');
      return backupCommand(parsed);
    }
    case 'logs': {
      const { logsCommand } = await import('./commands/logs');
      return logsCommand(parsed);
    }
    case 'config': {
      const { configCommand } = await import('./commands/config');
      return configCommand(parsed);
    }
    case 'init': {
      const { initCommand } = await import('./commands/init');
      return initCommand(parsed);
    }
    case 'uninstall': {
      const { uninstallCommand } = await import('./commands/uninstall');
      return uninstallCommand(parsed);
    }
    case 'setup': {
      const { setupCommand } = await import('./commands/setup');
      return setupCommand(parsed);
    }
    case 'doctor': {
      const { doctorCommand } = await import('./commands/doctor');
      return doctorCommand(parsed);
    }
    case 'mcp': {
      const { mcpCommand } = await import('./commands/mcp');
      return mcpCommand(parsed);
    }
    case 'version':
    case '-v':
    case '--version': {
      const { versionCommand } = await import('./commands/misc');
      return versionCommand(parsed);
    }
    case 'migrate': {
      const { migrateCommand } = await import('./commands/misc');
      return migrateCommand(parsed);
    }
    case 'device': {
      if (parsed.positional[0] === 'reset') {
        const { deviceResetCommand } = await import('./commands/misc');
        return deviceResetCommand(parsed);
      }
      error(t('common.unknown_subcommand', { command: `device ${parsed.positional[0] ?? ''}` }));
      print(t('common.available_subcommands', { list: 'device reset' }));
      process.exit(1);
      break;
    }
    case 'help':
    case '': {
      printHelp();
      // 如果沒有 config，提示跑 init
      if (!command) {
        const { existsSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const { join } = await import('node:path');
        if (!existsSync(join(homedir(), '.clawapi', 'config.yaml'))) {
          blank();
          print(color.yellow('💡 尚未初始化。跑 clawapi init 一行搞定！'));
          blank();
        }
      }
      break;
    }
    default: {
      error(t('common.unknown_command', { command }));
      print(t('common.use_help'));
      process.exit(1);
    }
  }
}

// ===== 主進入點 =====

export async function main(argv: string[] = process.argv): Promise<void> {
  const parsed = parseArgs(argv);

  // 處理全域旗標
  const plain = parsed.flags['plain'] === true;
  const json = parsed.flags['json'] === true;
  setOutputMode({ plain, json });

  // 初始化多語系（必須在所有命令之前）
  const cliLocale = parsed.flags['locale'] as string | undefined;
  initCliI18n(cliLocale);

  // --help / -h：沒有命令時顯示總幫助，有命令時交給子命令自己處理
  if (parsed.flags['help'] === true || parsed.flags['h'] === true) {
    if (!parsed.command || parsed.command === 'help') {
      printHelp();
      return;
    }
    // 有命令 → 讓命令自己處理 --help（如 sub-keys issue --help）
  }

  // 路由到命令
  await route(parsed);
}

// 直接執行時啟動 CLI
if (import.meta.main) {
  main().catch((err) => {
    error(String(err));
    process.exit(1);
  });
}

export default main;
