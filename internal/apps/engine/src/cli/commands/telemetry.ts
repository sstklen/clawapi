// telemetry 命令群組 — 遙測（集體智慧）管理
// 子命令：show, toggle

import { color, print, blank, success, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { confirm } from '../utils/prompt';
import { t } from '../utils/i18n';
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
      print(t('common.available_subcmds', { list: 'show, toggle' }));
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
      info(t('cmd.telemetry.status_title'));
      blank();
      print(`  ${t('cmd.telemetry.status_label')}：${pendingData.enabled ? color.green(t('common.enabled')) : color.red(t('common.disabled'))}`);
      print(`  ${t('cmd.telemetry.pending_events')}：${pendingData.pending_events} ${t('cmd.telemetry.events_unit')}`);
      print(`  ${t('cmd.telemetry.pending_size')}：${(pendingData.pending_size_bytes / 1024).toFixed(1)} KB`);
      print(`  ${t('cmd.telemetry.last_upload')}：${pendingData.last_upload_at}`);
      print(`  ${t('cmd.telemetry.next_upload')}：${pendingData.next_upload_at}`);
      blank();
      info(t('cmd.telemetry.sample_title'));
      for (const e of pendingData.sample_events) {
        print(`    ${e.type} | ${e.service} | ${e.latency_ms}ms | ${e.timestamp}`);
      }
      blank();
      print(color.dim('  ' + t('cmd.telemetry.disclaimer')));
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
    info(t('cmd.telemetry.current_status', { status: t('common.enabled') }));
    const disable = await confirm(t('cmd.telemetry.disable_prompt'));
    if (disable) {
      output(
        () => success(t('cmd.telemetry.disabled')),
        { status: 'disabled' }
      );
    } else {
      info(t('cmd.telemetry.kept_enabled'));
    }
  } else {
    info(t('cmd.telemetry.current_status', { status: t('common.disabled') }));
    print('  ' + t('cmd.telemetry.benefit_desc'));
    const enable = await confirm(t('cmd.telemetry.enable_prompt'));
    if (enable) {
      output(
        () => success(t('cmd.telemetry.enabled')),
        { status: 'enabled' }
      );
    } else {
      info(t('cmd.telemetry.kept_disabled'));
    }
  }
}

export default telemetryCommand;
