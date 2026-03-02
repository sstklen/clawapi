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
 */
async function duckDuckGoDemo(): Promise<boolean> {
  try {
    // 直接用 fetch 呼叫 DuckDuckGo API（不透過 adapter，保持輕量）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch('https://api.duckduckgo.com/?q=ClawAPI+AI+API&format=json&no_html=1&skip_disambig=1', {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return false;
    }

    const data = await response.json() as {
      AbstractText?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      Heading?: string;
    };

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
      return true;
    }

    // 即使沒有 RelatedTopics，連線成功也算通過
    print(`  ${color.green('✓')} API 連線成功 — 搜尋功能正常！`);
    return true;
  } catch {
    return false;
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

    const demoOk = await duckDuckGoDemo();
    if (!demoOk) {
      warn('搜尋 demo 跳過（網路不通或 API 暫時不可用）');
    }
  }

  // ── Step 5: 下一步指引 ──
  blank();
  print('─'.repeat(50));
  blank();
  success('初始化完成！');
  blank();
  if (!noMcp) {
    print(`  ${color.bold('👉 下一步：')}`);
    print(`    1. ${color.bold('重啟 Claude Code')}（關掉終端再開，讓 MCP 生效）`);
    print(`    2. 對 Claude 說：${color.cyan('「幫我搜一下今天的科技新聞」')}`);
    print(`       ${color.dim('↑ DuckDuckGo 搜尋免費，裝完直接能用 🦆')}`);
  } else {
    print(`  ${color.bold('👉 下一步：')}`);
    print(`    1. ${color.bold('clawapi start')} 啟動引擎`);
    print(`    2. 用你的 OpenAI SDK client 連 ${color.cyan('http://localhost:4141/v1')}`);
  }
  blank();
}

export default initCommand;
