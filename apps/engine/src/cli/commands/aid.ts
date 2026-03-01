// aid 命令群組 — 互助功能管理
// 子命令：config, stats, donate

import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, confirm, select, password } from '../utils/prompt';
import { t } from '../utils/i18n';
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
      error(t('common.unknown_subcmd', { subcmd: sub ?? '(無)' }));
      print(t('common.available_subcmds', { list: 'config, stats, donate' }));
      process.exit(1);
  }
}

// ===== aid config =====

async function aidConfig(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.aid.config_title'));
  blank();

  // 是否啟用
  const enabled = await confirm(t('cmd.aid.enable_prompt'), false);

  if (!enabled) {
    output(
      () => success(t('cmd.aid.disabled')),
      { status: 'disabled' }
    );
    return;
  }

  // 每日上限
  const dailyLimitStr = await ask(t('cmd.aid.daily_limit'), '50');
  const dailyLimit = parseInt(dailyLimitStr, 10) || 50;

  // 允許的服務
  const allowedStr = await ask(t('cmd.aid.allowed_services'));
  const allowedServices = allowedStr ? allowedStr.split(',').map(s => s.trim()) : null;

  // 禁止時段
  const blackoutStr = await ask(t('cmd.aid.blackout_hours'));
  const blackoutHours = blackoutStr
    ? blackoutStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : [];

  output(
    () => {
      blank();
      success(t('cmd.aid.config_updated'));
      print(`  ${t('cmd.aid.daily_limit')}：${dailyLimit}`);
      print(`  ${t('cmd.aid.allowed_services_label')}：${allowedServices ? allowedServices.join(', ') : t('common.all')}`);
      print(`  ${t('cmd.aid.blackout_hours_label')}：${blackoutHours.length > 0 ? blackoutHours.join(', ') + ' ' + t('cmd.aid.hour_suffix') : t('common.none')}`);
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
      info(t('cmd.aid.stats_title'));
      blank();
      print(`  ${t('cmd.aid.status_label')}：${stats.enabled ? color.green(t('common.enabled')) : color.red(t('common.disabled'))}`);
      print(`  ${t('cmd.aid.daily_limit')}：${stats.daily_limit}`);
      blank();
      print(`  ${t('cmd.aid.today_helped')}：${stats.today_helped} ${t('cmd.aid.times_suffix')}`);
      print(`  ${t('cmd.aid.today_received')}：${stats.today_received} ${t('cmd.aid.times_suffix')}`);
      print(`  ${t('cmd.aid.total_helped')}：${stats.total_helped} ${t('cmd.aid.times_suffix')}`);
      print(`  ${t('cmd.aid.total_received')}：${stats.total_received} ${t('cmd.aid.times_suffix')}`);
      print(`  ${t('cmd.aid.reputation_score')}：${stats.reputation_score}`);
      blank();
    },
    stats
  );
}

// ===== aid donate =====

async function aidDonate(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.aid.donate_title'));
  print('  ' + t('cmd.aid.donate_desc'));
  blank();

  // 選擇服務
  const service = await ask(t('cmd.aid.donate_service_id'));
  if (!service) {
    error(t('cmd.aid.service_id_empty'));
    process.exit(1);
  }

  // 輸入 Key（安全規則：用 password 模式，不回顯在終端）
  const key = await password(t('cmd.aid.paste_api_key'));
  if (!key) {
    error(t('cmd.aid.api_key_empty'));
    process.exit(1);
  }

  const confirmed = await confirm(t('cmd.aid.donate_confirm'));
  if (!confirmed) {
    info(t('common.cancelled'));
    return;
  }

  output(
    () => {
      blank();
      success(t('cmd.aid.donate_thanks'));
      print(`  ${t('cmd.aid.service_label')}：${service}`);
    },
    {
      status: 'donated',
      service_id: service,
    }
  );
}

export default aidCommand;
