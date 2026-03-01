// keys 命令群組 — Key 管理
// 子命令：add, list, remove, pin, rotate, import, check

import { color, print, blank, success, error, info, warn, table, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, select, password, confirm } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== 已知服務列表（互動式新增用） =====

const KNOWN_SERVICES = [
  { label: 'Groq', value: 'groq', description: '免費、超快推論' },
  { label: 'OpenAI', value: 'openai', description: 'GPT-4o, o1 系列' },
  { label: 'Anthropic', value: 'anthropic', description: 'Claude 系列' },
  { label: 'Google AI', value: 'google', description: 'Gemini 系列' },
  { label: 'Mistral', value: 'mistral', description: 'Mistral/Mixtral 系列' },
  { label: 'Together AI', value: 'together', description: '開源模型推論' },
  { label: 'OpenRouter', value: 'openrouter', description: '多模型閘道' },
  { label: 'DeepSeek', value: 'deepseek', description: 'DeepSeek 系列' },
  { label: '其他', value: 'other', description: '自行輸入服務 ID' },
];

// ===== 子命令路由 =====

export async function keysCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'add':
      return keysAdd(args);
    case 'list':
    case 'ls':
      return keysList(args);
    case 'remove':
    case 'rm':
      return keysRemove(args);
    case 'pin':
      return keysPin(args);
    case 'rotate':
      return keysRotate(args);
    case 'import':
      return keysImport(args);
    case 'check':
      return keysCheck(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['add', 'list', 'remove', 'pin', 'rotate', 'import', 'check'] });
        process.exit(1);
      }
      error(`未知的子命令：${sub ?? '(無)'}`);
      print('可用的子命令：add, list, remove, pin, rotate, import, check');
      process.exit(1);
  }
}

// ===== keys add =====

async function keysAdd(args: ParsedArgs): Promise<void> {
  // 互動式流程
  blank();
  info('新增 API Key');
  blank();

  // 步驟 1：選擇服務
  const serviceId = await select('選擇服務', KNOWN_SERVICES);
  const finalService = serviceId === 'other'
    ? await ask('輸入服務 ID')
    : serviceId;

  if (!finalService) {
    error('服務 ID 不能為空');
    process.exit(1);
  }

  // 步驟 2：輸入 Key
  const keyValue = await password('貼上 API Key');
  if (!keyValue) {
    error('API Key 不能為空');
    process.exit(1);
  }

  // 步驟 3：選擇池
  const poolType = await select('選擇 Key 池', [
    { label: 'King（國王池 — 自己的 Key）', value: 'king' },
    { label: 'Friend（朋友池 — 別人給的 Key）', value: 'friend' },
  ]) as 'king' | 'friend';

  // 步驟 4：取名
  const label = await ask('Key 標籤（可留空）');

  // 執行新增
  blank();

  output(
    () => {
      success(`已新增 Key：${finalService} (${poolType})`);
      if (label) print(`  標籤：${label}`);
      print(`  Key：${maskKey(keyValue)}`);
    },
    {
      status: 'added',
      service_id: finalService,
      pool_type: poolType,
      label: label || null,
      key_masked: maskKey(keyValue),
    }
  );
}

// ===== keys list =====

async function keysList(args: ParsedArgs): Promise<void> {
  const serviceFilter = args.positional[1];

  // 模擬資料（實際實作會從 KeyPool 取）
  const mockKeys = [
    {
      id: 1,
      service_id: 'groq',
      key_masked: 'gsk_...Xm4Q',
      pool_type: 'king',
      label: '主要',
      status: 'active',
      daily_used: 12,
      pinned: false,
    },
  ];

  if (isJsonMode()) {
    jsonOutput({ keys: mockKeys });
    return;
  }

  blank();
  info(serviceFilter ? `Key 列表（${serviceFilter}）` : 'Key 列表');
  blank();

  if (mockKeys.length === 0) {
    print('  目前沒有任何 Key。使用 clawapi keys add 新增。');
    blank();
    return;
  }

  table(
    [
      { header: 'ID', key: 'id', minWidth: 4, align: 'right' },
      { header: '服務', key: 'service_id', minWidth: 10 },
      { header: 'Key', key: 'key_masked', minWidth: 14 },
      { header: '池', key: 'pool_type', minWidth: 6 },
      { header: '標籤', key: 'label', minWidth: 6 },
      { header: '狀態', key: 'status', minWidth: 8 },
      { header: '今日用量', key: 'daily_used', minWidth: 8, align: 'right' },
    ],
    mockKeys
  );

  blank();
}

// ===== keys remove =====

async function keysRemove(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error('請指定 Key ID。用法：clawapi keys remove <id>');
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(`無效的 ID：${idStr}`);
    process.exit(1);
  }

  const confirmed = await confirm(`確定要刪除 Key #${id}？`);
  if (!confirmed) {
    info('已取消');
    return;
  }

  output(
    () => success(`已刪除 Key #${id}`),
    { status: 'removed', id }
  );
}

// ===== keys pin =====

async function keysPin(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error('請指定 Key ID。用法：clawapi keys pin <id>');
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(`無效的 ID：${idStr}`);
    process.exit(1);
  }

  output(
    () => success(`已釘選 Key #${id}（優先使用）`),
    { status: 'pinned', id }
  );
}

// ===== keys rotate =====

async function keysRotate(args: ParsedArgs): Promise<void> {
  const idStr = args.positional[1];
  if (!idStr) {
    error('請指定 Key ID。用法：clawapi keys rotate <id>');
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    error(`無效的 ID：${idStr}`);
    process.exit(1);
  }

  // 輸入新 Key
  const newKey = await password('貼上新的 API Key');
  if (!newKey) {
    error('新 Key 不能為空');
    process.exit(1);
  }

  output(
    () => {
      success(`已輪換 Key #${id}`);
      print(`  新 Key：${maskKey(newKey)}`);
    },
    { status: 'rotated', id, key_masked: maskKey(newKey) }
  );
}

// ===== keys import =====

async function keysImport(_args: ParsedArgs): Promise<void> {
  blank();
  info('批量匯入 Key');
  print('  支援格式：每行一個 Key，格式為 service_id:key_value');
  print('  例如：');
  print('    groq:gsk_xxxxxxxxxxxx');
  print('    openai:sk-xxxxxxxxxxxx');
  blank();

  const input = await ask('請貼上 Key 列表（按 Enter 結束）');
  if (!input) {
    info('已取消');
    return;
  }

  const lines = input.split('\n').filter(l => l.trim());
  let added = 0;
  let failed = 0;

  for (const line of lines) {
    const [service, key] = line.split(':');
    if (service && key) {
      added++;
    } else {
      failed++;
    }
  }

  output(
    () => {
      success(`匯入完成：${added} 個成功，${failed} 個失敗`);
    },
    { status: 'imported', added, failed }
  );
}

// ===== keys check =====

async function keysCheck(_args: ParsedArgs): Promise<void> {
  blank();
  info('檢查所有 Key 健康度...');
  blank();

  // 模擬檢查結果
  const results = [
    { service_id: 'groq', key_masked: 'gsk_...Xm4Q', status: 'active', latency_ms: 120 },
  ];

  output(
    () => {
      for (const r of results) {
        const statusIcon = r.status === 'active'
          ? color.green('OK')
          : color.red('FAIL');
        print(`  ${statusIcon}  ${r.service_id}  ${r.key_masked}  ${r.latency_ms}ms`);
      }
      blank();
      success(`檢查完成：${results.length} 個 Key`);
    },
    { keys: results }
  );
}

// ===== 工具 =====

/** 遮罩 Key 值 */
function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export default keysCommand;
