// aid 命令群組 — 互助功能管理
// 子命令：config, stats, donate

import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, confirm, select } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function aidCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'config':
      return aidConfig(args);
    case 'stats':
      return aidStats(args);
    case 'donate':
      return aidDonate(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['config', 'stats', 'donate'] });
        process.exit(1);
      }
      error(`未知的子命令：${sub ?? '(無)'}`);
      print('可用的子命令：config, stats, donate');
      process.exit(1);
  }
}

// ===== aid config =====

async function aidConfig(_args: ParsedArgs): Promise<void> {
  blank();
  info('互助功能設定');
  blank();

  // 是否啟用
  const enabled = await confirm('啟用互助功能？', false);

  if (!enabled) {
    output(
      () => success('互助功能已關閉'),
      { status: 'disabled' }
    );
    return;
  }

  // 每日上限
  const dailyLimitStr = await ask('每日互助上限（次數）', '50');
  const dailyLimit = parseInt(dailyLimitStr, 10) || 50;

  // 允許的服務
  const allowedStr = await ask('允許的服務（逗號分隔，留空=全部）');
  const allowedServices = allowedStr ? allowedStr.split(',').map(s => s.trim()) : null;

  // 禁止時段
  const blackoutStr = await ask('禁止時段（小時，如 0,1,2,3，留空=無）');
  const blackoutHours = blackoutStr
    ? blackoutStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];

  output(
    () => {
      blank();
      success('互助設定已更新');
      print(`  每日上限：${dailyLimit}`);
      print(`  允許的服務：${allowedServices ? allowedServices.join(', ') : '全部'}`);
      print(`  禁止時段：${blackoutHours.length > 0 ? blackoutHours.join(', ') + ' 時' : '無'}`);
    },
    {
      status: 'configured',
      enabled: true,
      daily_limit: dailyLimit,
      allowed_services: allowedServices,
      blackout_hours: blackoutHours,
    }
  );
}

// ===== aid stats =====

async function aidStats(_args: ParsedArgs): Promise<void> {
  // 模擬統計
  const stats = {
    enabled: true,
    daily_limit: 50,
    today_helped: 8,
    today_received: 3,
    total_helped: 156,
    total_received: 42,
    reputation_score: 0.85,
  };

  output(
    () => {
      blank();
      info('互助統計');
      blank();
      print(`  狀態：${stats.enabled ? color.green('已啟用') : color.red('已停用')}`);
      print(`  每日上限：${stats.daily_limit}`);
      blank();
      print(`  今日幫助他人：${stats.today_helped} 次`);
      print(`  今日收到幫助：${stats.today_received} 次`);
      print(`  累計幫助他人：${stats.total_helped} 次`);
      print(`  累計收到幫助：${stats.total_received} 次`);
      print(`  信譽分數：${stats.reputation_score}`);
      blank();
    },
    stats
  );
}

// ===== aid donate =====

async function aidDonate(_args: ParsedArgs): Promise<void> {
  blank();
  info('捐贈 Key 給 L0（免費層）');
  print('  捐贈的 Key 會讓所有人都能使用基礎 AI 服務。');
  blank();

  // 選擇服務
  const service = await ask('要捐贈的服務 ID');
  if (!service) {
    error('服務 ID 不能為空');
    process.exit(1);
  }

  // 輸入 Key（安全規則：用 password 模式，不回顯在終端）
  const key = await password('貼上 API Key');
  if (!key) {
    error('API Key 不能為空');
    process.exit(1);
  }

  const confirmed = await confirm('確定要捐贈此 Key？');
  if (!confirmed) {
    info('已取消');
    return;
  }

  output(
    () => {
      blank();
      success('感謝您的慷慨捐贈！');
      print(`  服務：${service}`);
    },
    {
      status: 'donated',
      service_id: service,
    }
  );
}

export default aidCommand;
