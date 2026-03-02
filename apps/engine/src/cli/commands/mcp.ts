// mcp 命令 — 啟動 ClawAPI MCP Server（stdio 模式）
// 讓 Claude Code / Cursor 等 AI 工具透過 MCP 協議直接使用 ClawAPI
//
// 用法：clawapi mcp              # 啟動 stdio 模式
//       clawapi mcp --test       # 快速驗證 MCP Server 功能
//       clawapi mcp --install    # 將 ClawAPI 註冊到 Claude Code 的 MCP 設定（idempotent）
//       clawapi mcp --uninstall  # 從 Claude Code 移除 ClawAPI MCP 設定
//
// 行為：
// 1. 靜默初始化引擎（不印啟動訊息到 stdout，因為 stdout 是 MCP 通道）
// 2. 建立 MCP Server 並進入 stdio 模式
// 3. 收到 SIGTERM/SIGINT 時優雅關機

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { success, error, info, warn, blank } from '../utils/output';
import type { ParsedArgs } from '../index';

// ===== MCP 設定管理（解決重裝殘留問題） =====

/**
 * 將 ClawAPI 註冊到 Claude Code 的 MCP 設定
 * 直接操作 ~/.claude.json，不依賴 claude CLI
 * Idempotent：已存在則更新，不存在則新增
 */
function mcpInstall(): void {
  const claudeJsonPath = join(homedir(), '.claude.json');

  let config: Record<string, unknown> = {};

  if (existsSync(claudeJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
      // 驗證是 JSON 物件（不是 array、string、null 等）
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        error('~/.claude.json 不是 JSON 物件，拒絕修改（避免破壞設定檔）');
        process.exit(1);
      }
      config = parsed as Record<string, unknown>;
    } catch (e) {
      if ((e as Error).message?.includes('JSON')) {
        error('~/.claude.json 格式錯誤，無法解析');
      } else {
        error(`讀取 ~/.claude.json 失敗：${(e as Error).message}`);
      }
      process.exit(1);
    }
  }

  // 確保 mcpServers 物件存在
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  const existed = 'clawapi' in servers;

  // 寫入（或覆蓋）clawapi MCP 設定
  servers.clawapi = {
    type: 'stdio',
    command: 'clawapi',
    args: ['mcp'],
  };

  // 原子寫入：先寫 .tmp 再 rename，避免寫到一半斷電造成檔案損壞
  const tmpPath = claudeJsonPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, claudeJsonPath);

  blank();
  if (existed) {
    success('已更新 ClawAPI MCP 設定（~/.claude.json）');
  } else {
    success('已新增 ClawAPI MCP 設定（~/.claude.json）');
  }
  info('重啟 Claude Code 即生效');
  blank();
}

/**
 * 從 Claude Code 移除 ClawAPI MCP 設定
 */
function mcpUninstall(): void {
  const claudeJsonPath = join(homedir(), '.claude.json');

  if (!existsSync(claudeJsonPath)) {
    info('~/.claude.json 不存在，無需清理');
    return;
  }

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      error('~/.claude.json 不是 JSON 物件，拒絕修改');
      process.exit(1);
    }
    config = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as Error).message?.includes('JSON')) {
      error('~/.claude.json 格式錯誤，無法解析');
    } else {
      error(`讀取 ~/.claude.json 失敗：${(e as Error).message}`);
    }
    process.exit(1);
  }

  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !('clawapi' in servers)) {
    info('ClawAPI MCP 設定不存在，無需清理');
    return;
  }

  delete servers.clawapi;

  // 原子寫入
  const tmpPath = claudeJsonPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, claudeJsonPath);

  blank();
  success('已移除 ClawAPI MCP 設定（~/.claude.json）');
  info('重啟 Claude Code 即生效');
  blank();
}

// ===== 主命令 =====

export async function mcpCommand(args: ParsedArgs): Promise<void> {
  // --install / --uninstall：管理 MCP 設定，不啟動 Server
  if (args.flags.install) {
    mcpInstall();
    return;
  }
  if (args.flags.uninstall) {
    mcpUninstall();
    return;
  }

  const configDir = join(homedir(), '.clawapi');

  // 重要：MCP 模式下 stdout 是 JSON-RPC 通道，所有日誌必須走 stderr
  // 劫持 console.log/warn/error 全部導向 stderr，防止引擎初始化時的 console.log 污染通道
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  console.log = (...msgs: unknown[]) => process.stderr.write(msgs.map(String).join(' ') + '\n');
  console.warn = (...msgs: unknown[]) => process.stderr.write(msgs.map(String).join(' ') + '\n');
  console.error = (...msgs: unknown[]) => process.stderr.write(msgs.map(String).join(' ') + '\n');

  const log = (msg: string) => process.stderr.write(`[ClawAPI MCP] ${msg}\n`);

  try {
    // 自動初始化：不需要先跑 setup，MCP 模式自動建立必要目錄和設定
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
      log(`已建立資料目錄 ${configDir}`);
    }

    const configPath = join(configDir, 'config.yaml');
    if (!existsSync(configPath)) {
      // 從套件內建的 default.yaml 複製一份到使用者目錄
      const defaultYaml = join(import.meta.dir, '..', '..', 'config', 'default.yaml');
      if (existsSync(defaultYaml)) {
        copyFileSync(defaultYaml, configPath);
        log('已自動建立 config.yaml（使用預設值）');
      } else {
        log('找不到 default.yaml，使用程式內建預設值');
      }
    }

    log('初始化引擎...');

    // 初始化引擎（HTTP Server 用 port 0 讓 OS 分配隨機 port，避免與已運行的引擎衝突）
    const engineModule = await import('../../index');
    const server = await engineModule.start({
      port: 0,
      host: '127.0.0.1',
      dataDir: configDir,
      noVps: true,  // MCP 模式預設離線，不連 VPS
    });

    log('引擎初始化完成');

    // 取得 MCP Server 所需的依賴
    const router = server.getRouter();
    const keyPool = server.getKeyPool();
    const adapters = server.getAdapters();

    // 建立 MCP Server
    const { createMcpServer } = await import('../../mcp/server');
    const mcpServer = createMcpServer({
      router,
      keyPool,
      adapters,
      statusDeps: {
        keyPool,
        startedAt: new Date(),
        adapterCount: adapters.size,
        config: { port: 0, host: '127.0.0.1' },
      },
    });

    log(`MCP Server 就緒（${adapters.size} 個 Adapter）`);

    // --test 模式：快速驗證 MCP Server 功能正常後退出
    if (args.flags.test) {
      log('測試模式：驗證 MCP Server...');

      // 用 tools/list 驗證 tool 數量
      const listResponse = await mcpServer.handleRequest({
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'tools/list',
        params: {},
      });
      const tools = (listResponse.result as any)?.tools ?? [];
      const toolCount = tools.length;

      // 用 tools/call status 驗證引擎健康
      const statusResponse = await mcpServer.handleRequest({
        jsonrpc: '2.0',
        id: 'test-2',
        method: 'tools/call',
        params: { name: 'status', arguments: {} },
      });
      const statusOk = !statusResponse.error;

      // 輸出結果到 stdout（讓用戶看到，不走 stderr）
      originalConsoleLog(`✅ MCP Server OK`);
      originalConsoleLog(`   Tools: ${toolCount}`);
      originalConsoleLog(`   Engine: ${statusOk ? 'healthy' : 'error'}`);
      originalConsoleLog(`   Adapters: ${adapters.size}`);

      // 清理並退出
      try {
        await engineModule.stop();
      } catch {
        // 停機失敗不影響測試結果
      }
      process.exit(statusOk ? 0 : 1);
    }

    // 註冊優雅關機
    const shutdown = async () => {
      log('收到關機訊號，正在關閉...');
      await engineModule.stop();
      log('已關閉');
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    // 啟動 stdio 模式（會阻塞，直到 stdin 關閉）
    await mcpServer.start();

  } catch (err) {
    log(`啟動失敗：${(err as Error).message}`);
    process.exit(1);
  }
}

export default mcpCommand;
