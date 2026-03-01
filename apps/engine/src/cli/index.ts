// ClawAPI CLI 主進入點
// 使用 process.argv 手動解析，不依賴外部 CLI 框架
// 支援全域旗標：--plain, --json, --locale

import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { setOutputMode, print, color, blank, error } from './utils/output';

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
  ]);
  return valueFlags.has(flag);
}

// ===== 幫助文字 =====

function printHelp(): void {
  blank();
  print(color.bold(`ClawAPI v${CLAWAPI_VERSION}`));
  print(color.dim('開源 AI API 鑰匙管理器 + 智慧路由器'));
  blank();
  print(color.bold('用法：'));
  print('  clawapi <命令> [子命令] [選項]');
  blank();
  print(color.bold('引擎控制：'));
  print('  start              啟動引擎 (-p/--port, --host, --daemon, --no-vps, --verbose)');
  print('  stop               停止引擎');
  print('  status             查看引擎狀態');
  blank();
  print(color.bold('Key 管理：'));
  print('  keys add           新增 Key（互動式）');
  print('  keys list          列出 Key');
  print('  keys remove <id>   刪除 Key');
  print('  keys pin <id>      釘選 Key');
  print('  keys rotate <id>   輪換 Key');
  print('  keys import        批量匯入');
  print('  keys check         手動檢查 Key 健康度');
  blank();
  print(color.bold('金鑰匙：'));
  print('  gold-key set       設定金鑰匙');
  print('  gold-key show      查看金鑰匙');
  print('  gold-key remove    移除金鑰匙');
  blank();
  print(color.bold('Sub-Key：'));
  print('  sub-keys issue     發行 Sub-Key');
  print('  sub-keys list      列出 Sub-Key');
  print('  sub-keys revoke <id>  撤銷 Sub-Key');
  print('  sub-keys usage <id>   查看用量');
  blank();
  print(color.bold('互助：'));
  print('  aid config         設定互助');
  print('  aid stats          查看互助統計');
  print('  aid donate         捐 Key 給 L0');
  blank();
  print(color.bold('Adapter：'));
  print('  adapters list      列出 Adapter');
  print('  adapters install <url>  安裝社群 Adapter');
  print('  adapters remove <id>    移除 Adapter');
  print('  adapters update    手動更新');
  blank();
  print(color.bold('遙測：'));
  print('  telemetry show     查看待上報內容');
  print('  telemetry toggle   開/關統計上報');
  blank();
  print(color.bold('備份：'));
  print('  backup export      匯出加密備份');
  print('  backup import      匯入備份');
  blank();
  print(color.bold('其他：'));
  print('  logs               查看最近紀錄 (--service, --export csv)');
  print('  config show        查看設定');
  print('  config set <key> <value>  修改設定');
  print('  migrate            執行 DB 遷移');
  print('  device reset       重置裝置');
  print('  version            查看版本');
  print('  setup              首次安裝引導');
  print('  doctor             診斷工具');
  blank();
  print(color.bold('全域選項：'));
  print('  --plain            無色彩（CI 環境友好）');
  print('  --json             JSON 輸出（機器可讀）');
  print('  --locale <locale>  語言切換 (zh-TW|en|ja)');
  print('  --help, -h         顯示幫助');
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
    case 'gold-key': {
      const { goldKeyCommand } = await import('./commands/gold-key');
      return goldKeyCommand(parsed);
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
    case 'setup': {
      const { setupCommand } = await import('./commands/setup');
      return setupCommand(parsed);
    }
    case 'doctor': {
      const { doctorCommand } = await import('./commands/doctor');
      return doctorCommand(parsed);
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
      error(`未知的子命令：device ${parsed.positional[0] ?? ''}`);
      print('可用的子命令：device reset');
      process.exit(1);
      break;
    }
    case 'help':
    case '': {
      printHelp();
      break;
    }
    default: {
      error(`未知的命令：${command}`);
      print(`使用 ${color.cyan('clawapi --help')} 查看所有可用命令`);
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

  // --help / -h
  if (parsed.flags['help'] === true || parsed.flags['h'] === true) {
    // 若有命令但同時傳了 --help，還是顯示總幫助
    printHelp();
    return;
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
