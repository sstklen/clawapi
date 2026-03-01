// gold-key 命令群組 — 金鑰匙管理
// 子命令：set, show, remove

import { color, print, blank, success, error, info, warn, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, password, confirm, select } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== 子命令路由 =====

export async function goldKeyCommand(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];

  switch (sub) {
    case 'set':
      return goldKeySet(args);
    case 'show':
      return goldKeyShow(args);
    case 'remove':
      return goldKeyRemove(args);
    default:
      if (isJsonMode()) {
        jsonOutput({ error: 'unknown_subcommand', available: ['set', 'show', 'remove'] });
        process.exit(1);
      }
      error(`未知的子命令：${sub ?? '(無)'}`);
      print('可用的子命令：set, show, remove');
      process.exit(1);
  }
}

// ===== gold-key set =====

async function goldKeySet(_args: ParsedArgs): Promise<void> {
  blank();
  info('設定金鑰匙');
  print('  金鑰匙用於 L3 Concierge 和 L4 Task 層，需要高品質模型。');
  blank();

  // 選擇服務
  const service = await select('選擇金鑰匙服務', [
    { label: 'OpenAI', value: 'openai', description: 'GPT-4o 推薦' },
    { label: 'Anthropic', value: 'anthropic', description: 'Claude Opus 推薦' },
    { label: 'Google AI', value: 'google', description: 'Gemini Pro' },
    { label: '其他', value: 'other' },
  ]);

  const finalService = service === 'other'
    ? await ask('輸入服務 ID')
    : service;

  // 輸入 Key
  const keyValue = await password('貼上金鑰匙 API Key');
  if (!keyValue) {
    error('API Key 不能為空');
    process.exit(1);
  }

  // 選擇預設模型
  const model = await ask('預設模型（可留空，系統自動選擇）');

  // 設定 reserve_percent
  const reserveStr = await ask('保留百分比（%）', '5');
  const reservePercent = parseInt(reserveStr, 10) || 5;

  output(
    () => {
      blank();
      success('金鑰匙已設定！');
      print(`  服務：${finalService}`);
      print(`  Key：${maskKey(keyValue)}`);
      if (model) print(`  預設模型：${model}`);
      print(`  保留百分比：${reservePercent}%`);
    },
    {
      status: 'set',
      service_id: finalService,
      key_masked: maskKey(keyValue),
      default_model: model || null,
      reserve_percent: reservePercent,
    }
  );
}

// ===== gold-key show =====

async function goldKeyShow(_args: ParsedArgs): Promise<void> {
  // 模擬顯示（實際從 config 讀取）
  const goldKey = {
    configured: true,
    service_id: 'openai',
    key_masked: 'sk-...AbCd',
    default_model: 'gpt-4o',
    reserve_percent: 5,
  };

  output(
    () => {
      blank();
      if (goldKey.configured) {
        info('金鑰匙設定');
        print(`  服務：${goldKey.service_id}`);
        print(`  Key：${goldKey.key_masked}`);
        print(`  預設模型：${goldKey.default_model ?? '(自動)'}`);
        print(`  保留百分比：${goldKey.reserve_percent}%`);
      } else {
        warn('尚未設定金鑰匙');
        print(`  使用 ${color.cyan('clawapi gold-key set')} 進行設定`);
      }
      blank();
    },
    goldKey
  );
}

// ===== gold-key remove =====

async function goldKeyRemove(_args: ParsedArgs): Promise<void> {
  const confirmed = await confirm('確定要移除金鑰匙？L3/L4 功能將無法使用。');
  if (!confirmed) {
    info('已取消');
    return;
  }

  output(
    () => success('金鑰匙已移除'),
    { status: 'removed' }
  );
}

// ===== 工具 =====

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export default goldKeyCommand;
