// init 命令 — 一行完成 ClawAPI 初始化 + 第一個爽點
//
// 安裝後的完整體驗鏈：
//   config → MCP → 掃描環境 Key → DuckDuckGo 搜尋 demo → 教你下一步
//
// 用法：clawapi init            # 全自動（config + MCP + 掃描 + demo）
//       clawapi init --force    # 強制覆蓋已存在的 config
//       clawapi init --no-mcp   # 只建 config，不動 MCP 設定
//       clawapi init --skip-demo  # 跳過 DuckDuckGo 搜尋 demo

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { success, error, info, warn, blank, color, print } from '../utils/output';
import { getEngineVersion } from '../utils/version';
import { ensureConfigExists, mcpInstall } from './mcp';
import { scanEnvVars } from '../../growth/env-scanner';
import type { FoundKey } from '../../growth/types';
import type { ParsedArgs } from '../index';

const CONFIG_DIR = join(homedir(), '.clawapi');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');

/** 分類的中文名稱 */
const CATEGORY_NAMES: Record<string, string> = {
  llm: '🧠 AI 模型',
  search: '🔍 搜尋',
  translate: '🌐 翻譯',
  image: '🎨 圖片',
  audio: '🎵 語音',
  embedding: '📐 Embedding',
  code: '💻 程式碼',
  tool: '🔧 工具',
};

/**
 * 嘗試用 DuckDuckGo 做一次快速搜尋 demo
 * 不需要 API Key、不需要啟動引擎
 * 回傳精確的錯誤原因，不再一律說「網路不通」
 */
async function duckDuckGoDemo(): Promise<{ ok: boolean; error?: string }> {
  try {
    // 直接用 fetch 呼叫 DuckDuckGo API（不透過 adapter，保持輕量）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let response: Response;
    try {
      // 注意：不能用 api.duckduckgo.com — 該子域名對 Bun 的 User-Agent 回空 body
      // duckduckgo.com（不加 api.）在所有 runtime 下都正常
      response = await fetch('https://duckduckgo.com/?q=ClawAPI+AI+API&format=json&no_html=1&skip_disambig=1', {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        return { ok: false, error: '連線逾時（5 秒）' };
      }
      return { ok: false, error: '網路不通' };
    }

    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, error: `API 回傳 HTTP ${response.status}` };
    }

    let data: {
      AbstractText?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      Heading?: string;
    } | null;
    try {
      data = await response.json() as typeof data;
    } catch {
      return { ok: false, error: '回應格式異常（JSON 解析失敗）' };
    }

    // 防護：某些環境下 response body 為空，json() 會回傳 null
    if (!data || typeof data !== 'object') {
      return { ok: false, error: '回應為空（API 可能暫時不可用）' };
    }

    // DuckDuckGo Instant Answer API 回傳的是摘要資訊
    const topics = data.RelatedTopics || [];
    const resultCount = topics.filter(t => t.Text).length;

    if (resultCount > 0) {
      print(`  ${color.green('✓')} 回傳 ${resultCount} 筆結果 — 搜尋功能正常！`);
      // 顯示前 2 筆摘要
      const preview = topics
        .filter(t => t.Text)
        .slice(0, 2)
        .map(t => {
          const text = (t.Text || '').slice(0, 60);
          return `    ${color.dim(`• ${text}${(t.Text || '').length > 60 ? '...' : ''}`)}`;
        });
      for (const line of preview) {
        print(line);
      }
      return { ok: true };
    }

    // 即使沒有 RelatedTopics，連線成功也算通過
    print(`  ${color.green('✓')} API 連線成功 — 搜尋功能正常！`);
    return { ok: true };
  } catch {
    return { ok: false, error: '未預期的錯誤' };
  }
}

/**
 * 顯示掃描到的 Key，按分類分組
 */
function displayFoundKeys(found: FoundKey[]): void {
  // 按 category 分組
  const groups = new Map<string, FoundKey[]>();
  for (const key of found) {
    const cat = key.category || 'tool';
    if (!groups.has(cat)) {
      groups.set(cat, []);
    }
    groups.get(cat)!.push(key);
  }

  for (const [category, keys] of groups) {
    const catName = CATEGORY_NAMES[category] || category;
    print(`  ${catName}`);
    for (const key of keys) {
      const name = key.display_name || key.service_id;
      print(`    ${color.green('✓')} ${name} ${color.dim(`(${key.key_preview})`)}`);
    }
  }
}

/**
 * 顯示推薦的免費服務
 */
function displayRecommendations(): void {
  print(`  ${color.dim('推薦免費服務（註冊即用）：')}`);
  print(`    • ${color.bold('Groq')}     — 免費 + 超快推論    ${color.dim('https://console.groq.com/keys')}`);
  print(`    • ${color.bold('Gemini')}   — 免費 + 100 萬 token ${color.dim('https://aistudio.google.com/apikey')}`);
  print(`    • ${color.bold('DeepSeek')} — 超便宜 + 強推理    ${color.dim('https://platform.deepseek.com/')}`);
}

export async function initCommand(args: ParsedArgs): Promise<void> {
  const force = args.flags.force === true;
  const noMcp = args.flags['no-mcp'] === true;
  const skipDemo = args.flags['skip-demo'] === true;

  blank();
  print(color.bold(`🦞 ClawAPI v${getEngineVersion()} — 初始化`));
  blank();

  // ── Step 1: 建立 config ──
  if (existsSync(CONFIG_PATH) && !force) {
    success(`設定檔已存在（${CONFIG_PATH}）`);
  } else {
    if (force && existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
    }
    const created = ensureConfigExists();
    if (created) {
      success(`已建立設定檔（${CONFIG_PATH}）`);
    }
  }

  // ── Step 2: 註冊 MCP ──
  if (noMcp) {
    info('跳過 MCP 註冊（--no-mcp）');
  } else {
    const mcpResult = mcpInstall({ quiet: true });
    if (mcpResult.ok) {
      if (mcpResult.mcpUpdated) {
        success('已新增 MCP 設定到 Claude Code（~/.claude.json）');
      } else {
        success('MCP 設定已是最新（~/.claude.json）');
      }
    } else {
      warn(`MCP 註冊失敗：${mcpResult.error}`);
      info('可稍後用 clawapi mcp --install 手動註冊');
    }
  }

  // ── Step 3: 掃描環境變數中的 API Key ──
  blank();
  print(color.bold('🔍 掃描環境變數...'));
  blank();

  const foundKeys = scanEnvVars();

  if (foundKeys.length > 0) {
    success(`找到 ${foundKeys.length} 把 API Key！`);
    blank();
    displayFoundKeys(foundKeys);
    blank();
    info(`重啟 Claude Code 後，用 ${color.bold('setup_wizard')} 工具一鍵匯入`);
  } else {
    info('沒有在環境變數中找到 API Key');
    blank();
    displayRecommendations();
    blank();
    info(`加好 Key 後用 ${color.bold('clawapi keys add')} 或 MCP 的 ${color.bold('setup_wizard')} 匯入`);
  }

  // ── Step 4: DuckDuckGo 搜尋 demo（第一個爽點！） ──
  if (!skipDemo) {
    blank();
    print(color.bold('🦆 快速測試：DuckDuckGo 搜尋（免費，不需要 Key）'));
    blank();

    const demoResult = await duckDuckGoDemo();
    if (!demoResult.ok) {
      warn(`搜尋 demo 跳過（${demoResult.error ?? '未知原因'}）`);
      info('這不影響 ClawAPI 功能，免費搜尋可在 MCP 中使用');
    }
  }

  // ── Step 5: 下一步指引（三國語言，讓全世界的龍蝦都知道下一步） ──
  blank();
  print('─'.repeat(50));
  blank();
  success('初始化完成！ / Setup complete! / セットアップ完了！');
  blank();
  if (!noMcp) {
    print(`  ${color.bold('⚠️  重啟 Claude Code / Restart Claude Code / Claude Code を再起動')}`);
    print(`  ${color.dim('     關掉終端再開新的 session，MCP 才會生效')}`);
    print(`  ${color.dim('     Close terminal and open a new session for MCP to take effect')}`);
    print(`  ${color.dim('     ターミナルを閉じて新しいセッションを開くと MCP が有効になります')}`);
    blank();
    print(`  ${color.bold('🦞 然後對 Claude 說：')}`);
    blank();
    print(`     🇹🇼  ${color.cyan('「幫我設定 ClawAPI」')}`);
    print(`     🇺🇸  ${color.cyan('"Set up ClawAPI for me"')}`);
    print(`     🇯🇵  ${color.cyan('「ClawAPI をセットアップして」')}`);
    blank();
    print(`  ${color.bold('     ↓ 你會體驗到四大爽點：')}`);
    blank();
    print(`     ${color.green('①')} ${color.bold('一鍵全自動')} — 掃描 → 驗證 → 匯入 → 產生萬用 Claw Key，零操作`);
    print(`     ${color.green('②')} ${color.bold('主動推薦')}   — 匯入後自動推薦下一個最值得加的免費服務`);
    print(`     ${color.green('③')} ${color.bold('碰壁引導')}   — 額度用完時，即時告訴你怎麼補`);
    print(`     ${color.green('④')} ${color.bold('群體智慧')}   — 匿名路由數據共享，越多人用越聰明`);
  } else {
    print(`  ${color.bold('👉 下一步 / Next / 次のステップ：')}`);
    print(`    1. ${color.bold('clawapi start')}`);
    print(`    2. OpenAI SDK → ${color.cyan('http://localhost:4141/v1')}`);
  }
  blank();
}

export default initCommand;
