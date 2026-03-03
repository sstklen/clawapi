// uninstall 命令 — 一行清光 ClawAPI 所有痕跡
// 測試員回饋：「裝得進去拆不乾淨，要手動清 5 個地方，漏一個就爆」
//
// 用法：clawapi uninstall             # 清除 config + MCP 設定（保留 data.db）
//       clawapi uninstall --all       # 清光一切（含 data.db、key 資料）
//       clawapi uninstall --keep-mcp  # 只清 config，不動 MCP 設定

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { success, info, warn, blank, color, print, error } from '../utils/output';
import type { ParsedArgs } from '../index';

const CONFIG_DIR = join(homedir(), '.clawapi');

/** 要清除的項目和對應路徑 */
interface CleanupItem {
  label: string;
  path: string;
  /** true = 只在 --all 模式清除（含用戶資料） */
  dataOnly?: boolean;
}

export async function uninstallCommand(args: ParsedArgs): Promise<void> {
  const all = args.flags.all === true;
  const keepMcp = args.flags['keep-mcp'] === true;

  blank();
  print(color.bold('ClawAPI — 清除安裝痕跡'));
  blank();

  let cleaned = 0;
  let skipped = 0;

  // Step 1: 清除 MCP 設定（除非 --keep-mcp）
  if (!keepMcp) {
    // 動態 import 避免載入不需要的模組
    const { mcpUninstallQuiet } = await getMcpUninstaller();
    const mcpResult = mcpUninstallQuiet();
    if (mcpResult.removed) {
      success('已移除 Claude Code MCP 設定（~/.claude.json）');
      cleaned++;
    } else if (mcpResult.notFound) {
      info('MCP 設定不存在，跳過');
    } else if (mcpResult.error) {
      warn(`MCP 設定移除失敗：${mcpResult.error}`);
    }
  } else {
    info('保留 MCP 設定（--keep-mcp）');
  }

  // Step 2: 清除 ~/.clawapi 目錄
  if (existsSync(CONFIG_DIR)) {
    if (all) {
      // --all：整個目錄砍掉
      rmSync(CONFIG_DIR, { recursive: true, force: true });
      success(`已移除整個設定目錄（${CONFIG_DIR}）`);
      cleaned++;
    } else {
      // 預設：只移除 config，保留 data.db（用戶的 key 資料）
      // master.key 跟 data.db 是一對：DB 裡的 Key 用 master.key 加密，
      // 刪了 master.key 但留 data.db → 所有 Key 解密失敗 → 全部壞掉
      const safeToRemove = ['config.yaml', 'engine.pid'];
      const dataFiles = ['data.db', 'data.db-shm', 'data.db-wal', 'auth.token', 'master.key'];

      for (const file of safeToRemove) {
        const filePath = join(CONFIG_DIR, file);
        if (existsSync(filePath)) {
          rmSync(filePath, { force: true });
          success(`已移除 ${file}`);
          cleaned++;
        }
      }

      // 提示保留了哪些資料檔
      const keptFiles: string[] = [];
      for (const file of dataFiles) {
        if (existsSync(join(CONFIG_DIR, file))) {
          keptFiles.push(file);
        }
      }
      if (keptFiles.length > 0) {
        info(`保留用戶資料：${keptFiles.join(', ')}（加 --all 可清除）`);
        skipped += keptFiles.length;
      }

      // 如果目錄空了就刪掉
      try {
        const remaining = readdirSync(CONFIG_DIR);
        if (remaining.length === 0) {
          rmSync(CONFIG_DIR, { force: true });
        }
      } catch {
        // 目錄可能已不存在
      }
    }
  } else {
    info('設定目錄不存在，跳過');
  }

  // Step 3: 完成提示
  blank();
  if (cleaned > 0) {
    success(`清除完成（${cleaned} 項已移除${skipped > 0 ? `，${skipped} 項保留` : ''}）`);
  } else {
    info('沒有需要清除的項目');
  }

  if (!all && skipped > 0) {
    blank();
    print(`  如需完全移除（含 API Key 資料）：`);
    print(`    ${color.bold('clawapi uninstall --all')}`);
  }

  blank();
  print(`  最後一步（移除 CLI 本身）：`);
  print(`    ${color.bold('bun remove -g @clawapi/engine')}`);
  blank();
}

/** 靜默版 MCP uninstall（不用 process.exit，回傳結果） */
async function getMcpUninstaller(): Promise<{
  mcpUninstallQuiet: () => { removed: boolean; notFound?: boolean; error?: string };
}> {
  const { homedir: getHome } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { existsSync: exists, readFileSync, writeFileSync, renameSync } = await import('node:fs');

  return {
    mcpUninstallQuiet() {
      const claudeJsonPath = joinPath(getHome(), '.claude.json');

      if (!exists(claudeJsonPath)) {
        return { removed: false, notFound: true };
      }

      try {
        const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { removed: false, error: '~/.claude.json 不是 JSON 物件' };
        }

        const config = parsed as Record<string, unknown>;
        const servers = config.mcpServers as Record<string, unknown> | undefined;
        if (!servers || !('clawapi' in servers)) {
          return { removed: false, notFound: true };
        }

        delete servers.clawapi;

        // 原子寫入
        const tmpPath = claudeJsonPath + `.tmp.${process.pid}`;
        writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
        renameSync(tmpPath, claudeJsonPath);

        return { removed: true };
      } catch (e) {
        return { removed: false, error: (e as Error).message };
      }
    },
  };
}

export default uninstallCommand;
