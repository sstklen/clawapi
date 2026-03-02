// init 命令 — 一行完成 ClawAPI 初始化
// 測試員回饋：「裝完 CLI 之後沒有 clawapi init，要自己猜目錄、猜檔名、翻 node_modules」
// 這個命令解決這個問題：一行搞定 config + MCP
//
// 用法：clawapi init          # 建立 config + 註冊 MCP
//       clawapi init --force  # 強制覆蓋已存在的 config

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { success, error, info, warn, blank, color, print } from '../utils/output';
import { getEngineVersion } from '../utils/version';
import { ensureConfigExists, mcpInstall } from './mcp';
import type { ParsedArgs } from '../index';

const CONFIG_DIR = join(homedir(), '.clawapi');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

export async function initCommand(args: ParsedArgs): Promise<void> {
  const force = args.flags.force === true;

  blank();
  print(color.bold(`ClawAPI v${getEngineVersion()} — 初始化`));
  blank();

  // Step 1: 建立 config
  if (existsSync(CONFIG_PATH) && !force) {
    info(`設定檔已存在（${CONFIG_PATH}）`);
    info('如需覆蓋，請加 --force');
  } else {
    if (force && existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
    }
    const created = ensureConfigExists();
    if (created) {
      success(`已建立設定檔（${CONFIG_PATH}）`);
    }
  }

  // Step 2: 註冊 MCP 到 Claude Code
  const mcpResult = mcpInstall({ quiet: true });
  if (mcpResult.ok) {
    if (mcpResult.mcpUpdated) {
      success('已新增 MCP 設定到 Claude Code（~/.claude.json）');
    } else {
      success('已更新 MCP 設定（~/.claude.json）');
    }
  } else {
    warn(`MCP 註冊失敗：${mcpResult.error}`);
    info('可稍後用 clawapi mcp --install 手動註冊');
  }

  // Step 3: 完成提示
  blank();
  success('初始化完成！');
  blank();
  print(`  接下來：`);
  print(`    1. ${color.bold('重啟 Claude Code')}（讓 MCP 生效）`);
  print(`    2. ${color.bold('clawapi doctor')}（檢查環境）`);
  print(`    3. ${color.bold('clawapi keys add')}（加入 API Key）`);
  blank();
}

export default initCommand;
