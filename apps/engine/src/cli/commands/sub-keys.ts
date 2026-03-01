// sub-keys 命令群組 — Sub-Key 管理
// 子命令：issue, list, revoke, usage

import { color, print, blank, success, error, info, warn, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, confirm, select, multiSelect } from '../utils/prompt';
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
      error(`未知的子命令：${sub ?? '(無)'}`);
      print('可用的子命令：issue, list, revoke, usage');
      process.exit(1);
  }
}

// ===== sub-keys issue =====

async function subKeysIssue(_args: ParsedArgs): Promise<void> {
  blank();
  info('發行新的 Sub-Key');
  blank();

  // 標籤
  const label = await ask('Sub-Key 標籤');
  if (!label) {
    error('標籤不能為空');
    process.exit(1);
  }

  // 有效期
  const expiryStr = await ask('有效期（天數，0=永久）', '30');
  const expiryDays = parseInt(expiryStr, 10) || 30;

  // 每日用量上限
  const dailyLimitStr = await ask('每日用量上限（0=無限制）', '100');
  const dailyLimit = parseInt(dailyLimitStr, 10) || 0;

  // 每小時速率
  const rateLimitStr = await ask('每小時速率上限（0=無限制）', '60');
  const rateLimit = parseInt(rateLimitStr, 10) || 0;

  // 允許的服務
  const allowedServices = await ask('允許的服務（逗號分隔，留空=全部）');

  // 產生 token
  const token = `sk_live_${randomHex(32)}`;

  output(
    () => {
      blank();
      success('Sub-Key 已發行！');
      blank();
      print(`  Token：${color.bold(token)}`);
      print(`  標籤：${label}`);
      print(`  有效期：${expiryDays === 0 ? '永久' : `${expiryDays} 天`}`);
      print(`  每日上限：${dailyLimit === 0 ? '無限制' : dailyLimit}`);
      print(`  每小時速率：${rateLimit === 0 ? '無限制' : rateLimit}`);
      if (allowedServices) print(`  允許的服務：${allowedServices}`);
      blank();
      warn('請妥善保管此 Token，它不會再次顯示！');
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
      info('Sub-Key 列表');
      blank();

      if (mockSubKeys.length === 0) {
        print('  目前沒有任何 Sub-Key。使用 clawapi sub-keys issue 發行。');
        blank();
        return;
      }

      table(
        [
          { header: 'ID', key: 'id', minWidth: 4, align: 'right' },
          { header: '標籤', key: 'label', minWidth: 10 },
          { header: 'Token', key: 'token_prefix', minWidth: 16 },
          { header: '每日上限', key: 'daily_limit', minWidth: 8, align: 'right' },
          { header: '今日用量', key: 'daily_used', minWidth: 8, align: 'right' },
          { header: '狀態', key: 'is_active', minWidth: 6 },
          { header: '到期日', key: 'expires_at', minWidth: 12 },
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
    error('請指定 Sub-Key ID。用法：clawapi sub-keys revoke <id>');
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(`無效的 ID：${idStr}`);
    process.exit(1);
  }

  const confirmed = await confirm(`確定要撤銷 Sub-Key #${id}？撤銷後無法恢復。`);
  if (!confirmed) {
    info('已取消');
    return;
  }

  output(
    () => success(`Sub-Key #${id} 已撤銷`),
    { status: 'revoked', id }
  );
}

// ===== sub-keys usage =====

async function subKeysUsage(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error('請指定 Sub-Key ID。用法：clawapi sub-keys usage <id>');
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(`無效的 ID：${idStr}`);
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
      info(`Sub-Key #${id} 用量統計`);
      blank();
      print(`  標籤：${usage.label}`);
      print(`  今日用量：${usage.daily_used} / ${usage.daily_limit}`);
      print(`  本小時速率：${usage.rate_used_this_hour} / ${usage.rate_limit_per_hour}`);
      print(`  累計請求：${usage.total_requests}`);
      print(`  最後使用：${usage.last_used_at}`);
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
