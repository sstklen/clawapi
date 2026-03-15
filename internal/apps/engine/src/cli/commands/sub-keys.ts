// sub-keys 命令群組 — Sub-Key 管理
// 子命令：issue, list, revoke, usage

import { color, print, blank, success, error, info, warn, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, confirm, select, multiSelect } from '../utils/prompt';
import { t } from '../utils/i18n';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function subKeysCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  // sub-keys --help：顯示子命令總覽
  if (!sub && (args.flags['help'] === true || args.flags['h'] === true)) {
    printSubKeysHelp();
    return;
  }

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

/**
 * 顯示 sub-keys 子命令總覽
 */
function printSubKeysHelp(): void {
  blank();
  print(color.bold('clawapi sub-keys'));
  print(color.dim('  Sub-Key 管理 — 發行、列表、撤銷、查用量'));
  blank();
  print('  issue              發行一把 Sub-Key（支援非互動模式）');
  print('  list               列出所有 Sub-Key');
  print('  revoke <id>        撤銷指定 Sub-Key');
  print('  usage <id>         查看指定 Sub-Key 的用量');
  blank();
  print(color.dim('  詳細用法：clawapi sub-keys issue --help'));
  blank();
}

// ===== sub-keys issue =====

/**
 * 顯示 sub-keys issue 的用法說明
 */
function printIssueHelp(): void {
  blank();
  print(color.bold('clawapi sub-keys issue'));
  print(color.dim('  發行一把 Sub-Key（分發給其他人使用）'));
  blank();
  print(color.bold('  非互動模式（腳本/批量用）：'));
  print('  clawapi sub-keys issue --label "龍蝦001"');
  print('  clawapi sub-keys issue --label "朋友A" --expire 7 --limit 50');
  print('  clawapi sub-keys issue --label "API" --rate 120 --services "groq,openai" --json');
  blank();
  print(color.bold('  旗標：'));
  print('  --label <名稱>       標籤名稱（必填）');
  print('  --expire <天數>      有效期，預設 30 天（0 = 永久）');
  print('  --limit <次數>       每日用量上限，預設 100（0 = 無限）');
  print('  --rate <次/小時>     每小時速率限制，預設 60（0 = 無限）');
  print('  --services <清單>    允許的服務，逗號分隔（如 "groq,openai"）');
  print('  --json               以 JSON 格式輸出（適合程式解析）');
  blank();
  print(color.bold('  互動模式：'));
  print('  clawapi sub-keys issue    （不帶 --label 就進入互動問答）');
  blank();
}

async function subKeysIssue(args: ParsedArgs): Promise<void> {
  // --help：顯示 sub-keys issue 的用法
  if (args.flags['help'] === true || args.flags['h'] === true) {
    printIssueHelp();
    return;
  }

  // 判斷模式：有 --label 旗標 → 非互動模式
  const flagLabel = args.flags['label'];
  const isNonInteractive = typeof flagLabel === 'string';

  let label: string;
  let expiryDays: number;
  let dailyLimit: number;
  let rateLimit: number;
  let allowedServices: string;

  if (isNonInteractive) {
    // === 非互動模式：從 CLI 旗標讀取 ===
    label = flagLabel;
    if (!label) {
      error('--label 不能為空');
      process.exit(1);
    }

    const expireFlag = args.flags['expire'];
    expiryDays = typeof expireFlag === 'string' ? (parseInt(expireFlag, 10) || 30) : 30;

    const limitFlag = args.flags['limit'];
    dailyLimit = typeof limitFlag === 'string' ? (parseInt(limitFlag, 10) || 0) : 100;

    const rateFlag = args.flags['rate'];
    rateLimit = typeof rateFlag === 'string' ? (parseInt(rateFlag, 10) || 0) : 60;

    const servicesFlag = args.flags['services'];
    allowedServices = typeof servicesFlag === 'string' ? servicesFlag : '';
  } else {
    // === 互動模式：原有的 readline 問答 ===
    blank();
    info(t('cmd.sub_keys.issue_title'));
    blank();

    label = await ask(t('cmd.sub_keys.label_prompt'));
    if (!label) {
      error(t('cmd.sub_keys.label_empty'));
      process.exit(1);
    }

    const expiryStr = await ask(t('cmd.sub_keys.expiry_prompt'), '30');
    expiryDays = parseInt(expiryStr, 10) || 30;

    const dailyLimitStr = await ask(t('cmd.sub_keys.daily_limit_prompt'), '100');
    dailyLimit = parseInt(dailyLimitStr, 10) || 0;

    const rateLimitStr = await ask(t('cmd.sub_keys.rate_limit_prompt'), '60');
    rateLimit = parseInt(rateLimitStr, 10) || 0;

    allowedServices = await ask(t('cmd.sub_keys.allowed_services_prompt'));
  }

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
