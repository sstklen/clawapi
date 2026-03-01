// setup 命令 — 首次安裝互動式引導（5 步）
// 步驟：
//   1. 歡迎 + 語言選擇
//   2. 加入第一把 Key（Groq 推薦）
//   3. 金鑰匙設定（可跳過）
//   4. VPS 連線設定
//   5. 確認 + 完成

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { CLAWAPI_VERSION } from '@clawapi/protocol';
import { color, print, blank, success, error, info, warn, step, box, jsonOutput, isJsonMode, output } from '../utils/output';
import { ask, password, confirm, select } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== 常數 =====

const TOTAL_STEPS = 5;
const CONFIG_DIR = join(homedir(), '.clawapi');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

// ===== 主命令 =====

export async function setupCommand(args: ParsedArgs): Promise<void> {
  // JSON 模式不支援互動式
  if (isJsonMode()) {
    jsonOutput({ error: 'not_supported', message: 'setup 不支援 --json 模式，請使用互動式模式' });
    process.exit(1);
  }

  blank();
  box([
    `ClawAPI v${CLAWAPI_VERSION}`,
    '首次安裝引導',
  ], 'Welcome');
  blank();
  print('  這個引導會幫你完成基本設定。隨時按 Ctrl+C 離開。');
  blank();

  // ===== 步驟 1：歡迎 + 語言選擇 =====
  step(1, TOTAL_STEPS, '語言設定');
  blank();

  const locale = await select('選擇語言', [
    { label: '繁體中文', value: 'zh-TW' },
    { label: 'English', value: 'en' },
    { label: '日本語', value: 'ja' },
  ]);

  success(`語言已設定為：${localeLabel(locale)}`);
  blank();

  // ===== 步驟 2：加入第一把 Key =====
  step(2, TOTAL_STEPS, '新增第一把 API Key');
  blank();

  print(`  推薦使用 ${color.bold('Groq')}（免費、速度極快）`);
  print(`  前往 ${color.cyan('https://console.groq.com/')} 取得 API Key`);
  blank();

  const addKey = await confirm('現在新增 API Key？', true);
  let firstKeyService: string | null = null;
  let firstKeyMasked: string | null = null;

  if (addKey) {
    const service = await select('選擇服務', [
      { label: 'Groq（推薦）', value: 'groq', description: '免費、超快' },
      { label: 'OpenAI', value: 'openai' },
      { label: 'Anthropic', value: 'anthropic' },
      { label: 'Google AI', value: 'google' },
      { label: '其他', value: 'other' },
    ]);

    const finalService = service === 'other'
      ? await ask('輸入服務 ID')
      : service;

    const keyValue = await password('貼上 API Key');
    if (keyValue) {
      firstKeyService = finalService;
      firstKeyMasked = maskKey(keyValue);
      success(`已新增 ${finalService} Key`);
    } else {
      warn('跳過（稍後可用 clawapi keys add 新增）');
    }
  } else {
    info('跳過（稍後可用 clawapi keys add 新增）');
  }
  blank();

  // ===== 步驟 3：金鑰匙設定 =====
  step(3, TOTAL_STEPS, '金鑰匙設定（進階功能）');
  blank();
  print('  金鑰匙用於 L3 管家和 L4 多步驟任務。');
  print('  需要 OpenAI 或 Anthropic 等付費 API Key。');
  blank();

  const setupGoldKey = await confirm('現在設定金鑰匙？', false);
  let goldKeyService: string | null = null;

  if (setupGoldKey) {
    const gkService = await select('金鑰匙服務', [
      { label: 'OpenAI', value: 'openai', description: 'GPT-4o' },
      { label: 'Anthropic', value: 'anthropic', description: 'Claude' },
    ]);

    const gkKey = await password('貼上 API Key');
    if (gkKey) {
      goldKeyService = gkService;
      success(`金鑰匙已設定（${gkService}）`);
    } else {
      warn('跳過金鑰匙設定');
    }
  } else {
    info('跳過（稍後可用 clawapi gold-key set 設定）');
  }
  blank();

  // ===== 步驟 4：VPS 連線設定 =====
  step(4, TOTAL_STEPS, 'VPS 連線設定');
  blank();
  print('  連接 ClawAPI VPS 可啟用互助、遙測、聊天室等線上功能。');
  print('  不連接也能正常使用所有本機功能。');
  blank();

  const enableVps = await confirm('啟用 VPS 連線？', true);
  blank();

  // ===== 步驟 5：確認 + 完成 =====
  step(5, TOTAL_STEPS, '確認設定');
  blank();

  print('  設定摘要：');
  print(`    語言：${localeLabel(locale)}`);
  print(`    第一把 Key：${firstKeyService ? `${firstKeyService} (${firstKeyMasked})` : '(未設定)'}`);
  print(`    金鑰匙：${goldKeyService ?? '(未設定)'}`);
  print(`    VPS 連線：${enableVps ? '啟用' : '停用'}`);
  blank();

  const confirmed = await confirm('確認以上設定？', true);
  if (!confirmed) {
    warn('設定已取消');
    process.exit(0);
  }

  // 寫入設定檔
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const configYaml = generateConfig(locale, enableVps);
  writeFileSync(CONFIG_PATH, configYaml, 'utf8');

  blank();
  box([
    '設定完成！',
    '',
    `使用 ${color.bold('clawapi start')} 啟動引擎`,
    `使用 ${color.bold('clawapi doctor')} 檢查系統狀態`,
    `使用 ${color.bold('clawapi --help')} 查看所有命令`,
  ], 'All Done');
  blank();
}

// ===== 工具 =====

function localeLabel(locale: string): string {
  switch (locale) {
    case 'zh-TW': return '繁體中文';
    case 'en': return 'English';
    case 'ja': return '日本語';
    default: return locale;
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function generateConfig(locale: string, vpsEnabled: boolean): string {
  return `# ClawAPI 設定檔
# 由 clawapi setup 產生於 ${new Date().toISOString()}

server:
  port: 4141
  host: 127.0.0.1
  auto_port: true

routing:
  default_strategy: smart
  failover_enabled: true

ui:
  locale: ${locale}
  theme: system

vps:
  enabled: ${vpsEnabled}

telemetry:
  enabled: true

logging:
  level: info
  retention_days: 30
`;
}

export default setupCommand;
