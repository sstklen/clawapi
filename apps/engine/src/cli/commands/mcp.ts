// mcp 命令 — 啟動 ClawAPI MCP Server（stdio 模式）
// 讓 Claude Code / Cursor 等 AI 工具透過 MCP 協議直接使用 ClawAPI
//
// 用法：clawapi mcp
//
// 行為：
// 1. 靜默初始化引擎（不印啟動訊息到 stdout，因為 stdout 是 MCP 通道）
// 2. 建立 MCP Server 並進入 stdio 模式
// 3. 收到 SIGTERM/SIGINT 時優雅關機

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../index';

export async function mcpCommand(_args: ParsedArgs): Promise<void> {
  const configDir = join(homedir(), '.clawapi');

  // 重要：MCP 模式下 stdout 是 JSON-RPC 通道，所有日誌必須走 stderr
  // 劫持 console.log/warn/error 全部導向 stderr，防止引擎初始化時的 console.log 污染通道
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
  console.warn = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
  console.error = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');

  const log = (msg: string) => process.stderr.write(`[ClawAPI MCP] ${msg}\n`);

  try {
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

    log(`MCP Server 就緒（${adapters.size} 個 Adapter、12 個 Tools）`);

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
