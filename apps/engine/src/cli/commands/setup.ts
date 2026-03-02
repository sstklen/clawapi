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
import { t } from '../utils/i18n';
import { ask, password, confirm, select } from '../utils/prompt';
import type { ParsedArgs } from '../index';

// ===== 常數 =====

const TOTAL_STEPS = 5;
const CONFIG_DIR = join(homedir(), '.clawapi');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

// ===== 主命令 =====

export async function setupCommand(args: ParsedArgs): Promise<void> {
  // --defaults 模式：跳過互動，直接用預設值寫 config
  if (args.flags.defaults) {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const configYaml = generateConfig('en', true);
    writeFileSync(CONFIG_PATH, configYaml, 'utf8');

    if (!isJsonMode()) {
      success('Config created with defaults at ' + CONFIG_PATH);
      print(`  Next: ${color.bold('clawapi start')} or ${color.bold('clawapi mcp')}`);
    } else {
      jsonOutput({ success: true, config_path: CONFIG_PATH });
    }
    return;
  }

  // JSON 模式不支援互動式
  if (isJsonMode()) {
    jsonOutput({ error: 'not_supported', message: t('cmd.setup.no_json_mode') });
    process.exit(1);
  }

  blank();
  box([
    `ClawAPI v${CLAWAPI_VERSION}`,
    t('cmd.setup.first_run_title'),
  ], 'Welcome');
  blank();
  print(`  ${t('cmd.setup.intro')}`);
  blank();

  // ===== 步驟 1：歡迎 + 語言選擇 =====
  step(1, TOTAL_STEPS, t('cmd.setup.step_language'));
  blank();

  const locale = await select(t('cmd.setup.select_language'), [
    { label: t('cmd.setup.lang_zh_tw'), value: 'zh-TW' },
    { label: 'English', value: 'en' },
    { label: t('cmd.setup.lang_ja'), value: 'ja' },
  ]);

  success(t('cmd.setup.language_set', { lang: localeLabel(locale) }));
  blank();

  // ===== 步驟 2：加入第一把 Key =====
  step(2, TOTAL_STEPS, t('cmd.setup.step_add_key'));
  blank();

  print(`  ${t('cmd.setup.recommend_groq', { groq: color.bold('Groq') })}`);
  print(`  ${t('cmd.setup.groq_url', { url: color.cyan('https://console.groq.com/') })}`);
  blank();

  const addKey = await confirm(t('cmd.setup.add_key_now'), true);
  let firstKeyService: string | null = null;
  let firstKeyMasked: string | null = null;

  if (addKey) {
    const service = await select(t('cmd.setup.select_service'), [
      { label: t('cmd.setup.groq_recommended'), value: 'groq', description: t('cmd.setup.groq_desc') },
      { label: 'OpenAI', value: 'openai' },
      { label: 'Anthropic', value: 'anthropic' },
      { label: 'Google AI', value: 'google' },
      { label: t('cmd.setup.other'), value: 'other' },
    ]);

    const finalService = service === 'other'
      ? await ask(t('cmd.setup.enter_service_id'))
      : service;

    const keyValue = await password(t('cmd.setup.paste_api_key'));
    if (keyValue) {
      firstKeyService = finalService;
      firstKeyMasked = maskKey(keyValue);
      success(t('cmd.setup.key_added', { service: finalService }));
    } else {
      warn(t('cmd.setup.skip_key'));
    }
  } else {
    info(t('cmd.setup.skip_key'));
  }
  blank();

  // ===== 步驟 3：金鑰匙設定 =====
  step(3, TOTAL_STEPS, t('cmd.setup.step_gold_key'));
  blank();
  print(`  ${t('cmd.setup.gold_key_desc')}`);
  print(`  ${t('cmd.setup.gold_key_requirement')}`);
  blank();

  const setupGoldKey = await confirm(t('cmd.setup.setup_gold_key_now'), false);
  let goldKeyService: string | null = null;

  if (setupGoldKey) {
    const gkService = await select(t('cmd.setup.gold_key_service'), [
      { label: 'OpenAI', value: 'openai', description: 'GPT-4o' },
      { label: 'Anthropic', value: 'anthropic', description: 'Claude' },
    ]);

    const gkKey = await password(t('cmd.setup.paste_api_key'));
    if (gkKey) {
      goldKeyService = gkService;
      success(t('cmd.setup.gold_key_set', { service: gkService }));
    } else {
      warn(t('cmd.setup.skip_gold_key'));
    }
  } else {
    info(t('cmd.setup.skip_gold_key_later'));
  }
  blank();

  // ===== 步驟 4：VPS 連線設定 =====
  step(4, TOTAL_STEPS, t('cmd.setup.step_vps'));
  blank();
  print(`  ${t('cmd.setup.vps_desc')}`);
  print(`  ${t('cmd.setup.vps_optional')}`);
  blank();

  const enableVps = await confirm(t('cmd.setup.enable_vps'), true);
  blank();

  // ===== 步驟 5：確認 + 完成 =====
  step(5, TOTAL_STEPS, t('cmd.setup.step_confirm'));
  blank();

  print(`  ${t('cmd.setup.summary')}`)
  print(`    ${t('cmd.setup.summary_language')}${localeLabel(locale)}`);
  print(`    ${t('cmd.setup.summary_first_key')}${firstKeyService ? `${firstKeyService} (${firstKeyMasked})` : t('cmd.setup.not_set')}`);
  print(`    ${t('cmd.setup.summary_gold_key')}${goldKeyService ?? t('cmd.setup.not_set')}`);
  print(`    ${t('cmd.setup.summary_vps')}${enableVps ? t('cmd.setup.enabled') : t('cmd.setup.disabled')}`);
  blank();

  const confirmed = await confirm(t('cmd.setup.confirm_settings'), true);
  if (!confirmed) {
    warn(t('common.cancelled'));
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
    t('cmd.setup.complete'),
    '',
    t('cmd.setup.hint_start', { cmd: color.bold('clawapi start') }),
    t('cmd.setup.hint_doctor', { cmd: color.bold('clawapi doctor') }),
    t('cmd.setup.hint_help', { cmd: color.bold('clawapi --help') }),
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
