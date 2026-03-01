// telemetry 命令群組 — 遙測（集體智慧）管理
// 子命令：show, toggle

import { color, print, blank, success, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { confirm } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function telemetryCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'show':
      return telemetryShow(args);
    case 'toggle':
      return telemetryToggle(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['show', 'toggle'] });
        process.exit(1);
      }
      print('可用的子命令：show, toggle');
      process.exit(1);
  }
}

// ===== telemetry show =====

async function telemetryShow(_args: ParsedArgs): Promise<void> {
  // 模擬待上報內容
  const pendingData = {
    enabled: true,
    pending_events: 42,
    pending_size_bytes: 15360,
    last_upload_at: '2026-03-01T09:00:00Z',
    next_upload_at: '2026-03-01T10:00:00Z',
    sample_events: [
      { type: 'route_result', service: 'groq', latency_ms: 120, timestamp: '2026-03-01T09:45:00Z' },
      { type: 'route_result', service: 'openai', latency_ms: 450, timestamp: '2026-03-01T09:44:00Z' },
    ],
  };

  output(
    () => {
      blank();
      info('遙測（集體智慧）狀態');
      blank();
      print(`  狀態：${pendingData.enabled ? color.green('已啟用') : color.red('已停用')}`);
      print(`  待上報事件：${pendingData.pending_events} 筆`);
      print(`  待上報大小：${(pendingData.pending_size_bytes / 1024).toFixed(1)} KB`);
      print(`  上次上報：${pendingData.last_upload_at}`);
      print(`  下次上報：${pendingData.next_upload_at}`);
      blank();
      info('待上報事件樣本：');
      for (const e of pendingData.sample_events) {
        print(`    ${e.type} | ${e.service} | ${e.latency_ms}ms | ${e.timestamp}`);
      }
      blank();
      print(color.dim('  說明：遙測資料僅包含匿名化的路由結果，不含任何 API Key 或請求內容。'));
      blank();
    },
    pendingData
  );
}

// ===== telemetry toggle =====

async function telemetryToggle(_args: ParsedArgs): Promise<void> {
  // 模擬目前狀態
  const currentlyEnabled = true;

  blank();
  if (currentlyEnabled) {
    info('遙測目前為：已啟用');
    const disable = await confirm('要關閉遙測嗎？');
    if (disable) {
      output(
        () => success('遙測已關閉'),
        { status: 'disabled' }
      );
    } else {
      info('已保持啟用');
    }
  } else {
    info('遙測目前為：已停用');
    print('  遙測資料幫助 ClawAPI 改善路由品質，僅包含匿名統計。');
    const enable = await confirm('要開啟遙測嗎？');
    if (enable) {
      output(
        () => success('遙測已啟用'),
        { status: 'enabled' }
      );
    } else {
      info('已保持停用');
    }
  }
}

export default telemetryCommand;
