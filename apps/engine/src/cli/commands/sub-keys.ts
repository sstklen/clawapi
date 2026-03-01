// sub-keys 命令群組 — Sub-Key 管理
// 子命令：issue, list, revoke, usage

import { color, print, blank, success, error, info, warn, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, confirm, select, multiSelect } from '../utils/prompt';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function subKeysCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'issue':
      return subKeysIssue(args);
    case 'list':
    case 'ls':
      return subKeysList(args);
    case 'revoke':
      return subKeysRevoke(args);
    case 'usage':
      return subKeysUsage(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['issue', 'list', 'revoke', 'usage'] });
        process.exit(1);
      }
      error(t('common.unknown_subcmd', { subcmd: sub ?? t('common.none') }));
      print(t('common.available_subcmds', { list: 'issue, list, revoke, usage' }));
      process.exit(1);
  }
}

// ===== sub-keys issue =====

async function subKeysIssue(_args: ParsedArgs): Promise<void> {
  blank();
  info(t('cmd.sub_keys.issue_title'));
  blank();

  // 標籤
  const label = await ask(t('cmd.sub_keys.label_prompt'));
  if (!label) {
    error(t('cmd.sub_keys.label_empty'));
    process.exit(1);
  }

  // 有效期
  const expiryStr = await ask(t('cmd.sub_keys.expiry_prompt'), '30');
  const expiryDays = parseInt(expiryStr, 10) || 30;

  // 每日用量上限
  const dailyLimitStr = await ask(t('cmd.sub_keys.daily_limit_prompt'), '100');
  const dailyLimit = parseInt(dailyLimitStr, 10) || 0;

  // 每小時速率
  const rateLimitStr = await ask(t('cmd.sub_keys.rate_limit_prompt'), '60');
  const rateLimit = parseInt(rateLimitStr, 10) || 0;

  // 允許的服務
  const allowedServices = await ask(t('cmd.sub_keys.allowed_services_prompt'));

  // 產生 token
  const token = `sk_live_${randomHex(32)}`;

  output(
    () => {
      blank();
      success(t('cmd.sub_keys.issued'));
      blank();
      print(t('cmd.sub_keys.token_display', { token: color.bold(token) }));
      print(t('cmd.sub_keys.label_display', { label }));
      print(expiryDays === 0
        ? t('cmd.sub_keys.expiry_display_permanent')
        : t('cmd.sub_keys.expiry_display_days', { days: expiryDays }));
      print(dailyLimit === 0
        ? t('cmd.sub_keys.daily_limit_display_unlimited')
        : t('cmd.sub_keys.daily_limit_display', { limit: dailyLimit }));
      print(rateLimit === 0
        ? t('cmd.sub_keys.rate_limit_display_unlimited')
        : t('cmd.sub_keys.rate_limit_display', { limit: rateLimit }));
      if (allowedServices) print(t('cmd.sub_keys.allowed_services_display', { services: allowedServices }));
      blank();
      warn(t('cmd.sub_keys.token_warning'));
    },
    {
      status: 'issued',
      token,
      label,
      expires_in_days: expiryDays,
      daily_limit: dailyLimit || null,
      rate_limit_per_hour: rateLimit || null,
      allowed_services: allowedServices ? allowedServices.split(',').map(s => s.trim()) : null,
    }
  );
}

// ===== sub-keys list =====

async function subKeysList(_args: ParsedArgs): Promise<void> {
  // 模擬資料
  const mockSubKeys = [
    {
      id: 1,
      label: '前端 App',
      token_prefix: 'sk_live_a1b2...',
      daily_limit: 100,
      daily_used: 23,
      is_active: true,
      expires_at: '2026-04-01T00:00:00Z',
    },
  ];

  output(
    () => {
      blank();
      info(t('cmd.sub_keys.list_title'));
      blank();

      if (mockSubKeys.length === 0) {
        print(t('cmd.sub_keys.no_sub_keys'));
        blank();
        return;
      }

      table(
        [
          { header: 'ID', key: 'id', minWidth: 4, align: 'right' },
          { header: t('cmd.sub_keys.header_label'), key: 'label', minWidth: 10 },
          { header: 'Token', key: 'token_prefix', minWidth: 16 },
          { header: t('cmd.sub_keys.header_daily_limit'), key: 'daily_limit', minWidth: 8, align: 'right' },
          { header: t('cmd.sub_keys.header_daily_usage'), key: 'daily_used', minWidth: 8, align: 'right' },
          { header: t('cmd.sub_keys.header_status'), key: 'is_active', minWidth: 6 },
          { header: t('cmd.sub_keys.header_expiry'), key: 'expires_at', minWidth: 12 },
        ],
        mockSubKeys
      );
      blank();
    },
    { sub_keys: mockSubKeys }
  );
}

// ===== sub-keys revoke =====

async function subKeysRevoke(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error(t('cmd.sub_keys.specify_id', { cmd: 'revoke' }));
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(t('common.invalid_id', { id: idStr }));
    process.exit(1);
  }

  const confirmed = await confirm(t('cmd.sub_keys.confirm_revoke', { id }));
  if (!confirmed) {
    info(t('common.cancelled'));
    return;
  }

  output(
    () => success(t('cmd.sub_keys.revoked', { id })),
    { status: 'revoked', id }
  );
}

// ===== sub-keys usage =====

async function subKeysUsage(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error(t('cmd.sub_keys.specify_id', { cmd: 'usage' }));
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(t('common.invalid_id', { id: idStr }));
    process.exit(1);
  }

  // 模擬用量
  const usage = {
    id,
    label: '前端 App',
    daily_used: 23,
    daily_limit: 100,
    rate_used_this_hour: 5,
    rate_limit_per_hour: 60,
    total_requests: 1234,
    last_used_at: '2026-03-01T10:30:00Z',
  };

  output(
    () => {
      blank();
      info(t('cmd.sub_keys.usage_title', { id }));
      blank();
      print(t('cmd.sub_keys.usage_label', { label: usage.label }));
      print(t('cmd.sub_keys.usage_daily', { used: usage.daily_used, limit: usage.daily_limit }));
      print(t('cmd.sub_keys.usage_rate', { used: usage.rate_used_this_hour, limit: usage.rate_limit_per_hour }));
      print(t('cmd.sub_keys.usage_total', { total: usage.total_requests }));
      print(t('cmd.sub_keys.usage_last_used', { time: usage.last_used_at }));
      blank();
    },
    usage
  );
}

// ===== 工具 =====

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export default subKeysCommand;
