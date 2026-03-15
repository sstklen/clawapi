/**
 * Debug 醫生 — 專科路由
 * 平台偵測 + 專科 prompt 的「唯一來源」
 *
 * Phase 2：建立模組，從 kb-scraper/config.ts 抽出 ✅
 * Phase 4：型別安全修正 + 注入三層瀑布（Opus/Sonnet 收到專科 prompt）✅
 * Phase 6：統一平台定義 — config.ts + issue-parser.ts 改從此處 import ✅
 */

// ─── 專科 Prompt（教 AI 用對的維度看問題）───
// 先宣告 PLATFORM_TRAINING，再用它的 key 約束 PLATFORM_PATTERNS

export const PLATFORM_TRAINING = {
  telegram: `[Telegram specialist]
❌ BAD: "OAuth header parsing issue in Telegram integration" → too vague, which header? which file?
✅ GOOD: "TelegramBot.sendMessage parse_mode='MarkdownV2' fails because underscores in username aren't escaped. Fix: escape _ to \\_ in formatTelegramMessage() at src/extensions/telegram/utils.ts"`,

  discord: `[Discord specialist]
❌ BAD: "Discord bot not responding to commands" → which command? which event handler?
✅ GOOD: "InteractionCreate handler in discord-client.ts:142 drops slash commands when guild.id is undefined (DM context). Fix: add fallback to interaction.user.id when guild is null"`,

  whatsapp: `[WhatsApp specialist]
❌ BAD: "WhatsApp message delivery issue" → what kind of message? what error code?
✅ GOOD: "WhatsApp Cloud API returns 131047 (re-engagement) when sending template outside 24h window. Gateway retries 3x with same template. Fix: check error.code===131047 in handleWhatsAppError() and skip retry"`,

  ollama: `[Ollama/Local LLM specialist]
❌ BAD: "Ollama model loading failed" → which model? which endpoint? what error?
✅ GOOD: "Ollama /api/chat returns 404 when model name includes tag ('llama3:8b'). normalizeModelName() strips ':8b' tag. Fix: preserve tag in ollama-provider.ts buildRequestUrl()"`,

  cron: `[Cron/Scheduler specialist]
❌ BAD: "Cron job failed to execute on time" → every cron bug says this
✅ GOOD: "node-cron parseExpression uses 5-field but gateway passes 6-field (with seconds). Extra field shifts positions — minute becomes hour. Fix: strip leading seconds in parseCronExpression() at src/cron/scheduler.ts"`,

  memory_rag: `[Memory/RAG specialist]
❌ BAD: "Memory retrieval not working properly" → not working HOW?
✅ GOOD: "Cognee vectorSearch returns empty — embedding dimension mismatch: cognee uses 1536-dim (ada-002) but gateway sends 3072-dim (text-embedding-3-large). Fix: set EMBEDDING_MODEL=text-embedding-ada-002 in cognee config"`,

  openai: `[OpenAI/GPT specialist]
❌ BAD: "OpenAI API returned an error" → which endpoint? which model? what status?
✅ GOOD: "gpt-4-turbo returns 400 'max_tokens exceeds limit' because max_output_tokens is set to 4096 (old gpt-4 default). Fix: update MODEL_DEFAULTS['gpt-4-turbo'].max_output_tokens to 16384 in providers/openai/config.ts"`,

  docker: `[Docker specialist]
❌ BAD: "Container failed to start" → which container? what exit code? what log?
✅ GOOD: "docker-compose healthcheck uses curl but image is alpine-based (no curl). Container restarts every 30s when healthcheck fails. Fix: change healthcheck to wget or install curl in Dockerfile"`,

  mcp: `[MCP (Model Context Protocol) specialist]
❌ BAD: "MCP tool call failed" → which tool? what transport? what error?
✅ GOOD: "MCP stdio server returns empty toolResult because child process stderr is mixed into stdout. Fix: separate stderr pipe in spawn() options at mcp-client.ts:89"`,

  browser: `[Browser/Web UI specialist]
❌ BAD: "Page not loading correctly" → which page? what error in console?
✅ GOOD: "React hydration mismatch on SSR page because Date.now() differs between server and client render. Fix: use useEffect() for time-dependent UI in components/Timer.tsx"`,

  anthropic: `[Anthropic/Claude specialist]
❌ BAD: "Claude API error" → which model? what status code? what was the request?
✅ GOOD: "claude-sonnet-4 returns 400 when system message uses cache_control but anthropic-version header is '2023-01-01'. Fix: update to '2023-06-01' which supports prompt caching"`,

  google: `[Google/Gemini specialist]
❌ BAD: "Gemini not working" → which model? which API? what error?
✅ GOOD: "Gemini 2.5 Flash returns 404 because model name format changed from 'gemini-pro' to 'models/gemini-2.5-flash'. Fix: prepend 'models/' prefix in google-provider.ts buildEndpoint()"`,
} as const;

// ─── 平台偵測 Regex ───
// key 嚴格約束為 PLATFORM_TRAINING 的 key，保證偵測結果 = 有對應 prompt

type PlatformKey = keyof typeof PLATFORM_TRAINING;

export const PLATFORM_PATTERNS: [PlatformKey, RegExp][] = [
  ['telegram', /telegram|telegrambot|long.?polling|sendmessage.*tg/i],
  ['discord', /discord|discord\.js|discordbot|guild|slash.?command/i],
  ['whatsapp', /whatsapp|whatsapp.?gateway|meta.?business|baileys/i],
  ['ollama', /ollama|local.?llm|gguf|llama\.cpp|vllm/i],
  ['cron', /cron|scheduler|schedule|periodic|interval|timer|agentTurn/i],
  ['memory_rag', /memory|cognee|rag|vector|embedding|knowledge.?base/i],
  ['mcp', /\bmcp\b|model.?context.?protocol|tool.?use|function.?call/i],
  ['docker', /docker|container|compose|dockerfile|k8s/i],
  ['browser', /browser|chrome|web.?ui|websocket.*relay|react|dom/i],
  ['openai', /openai|gpt-?[34]|chatgpt|dall-?e/i],
  ['anthropic', /anthropic|claude|sonnet|haiku|opus/i],
  ['google', /google|gemini|palm|vertex/i],
];

/** 所有已知平台名稱（偵測結果為 PlatformKey 或 null 表示通用） */
export type PlatformName = PlatformKey | null;

/**
 * 從錯誤描述 + 錯誤訊息偵測平台
 * 回傳平台名或 null（通用）
 */
export function detectPlatform(errorDescription: string, errorMessage?: string): PlatformName {
  // regex 已帶 /i flag，不需要 toLowerCase
  const text = `${errorDescription} ${(errorMessage || '').slice(0, 1000)}`;
  for (const [name, regex] of PLATFORM_PATTERNS) {
    if (regex.test(text)) return name; // name 已是 PlatformKey，型別安全 ✅
  }
  return null;
}

/**
 * 取得平台專科 prompt（用於注入 LLM 分析）
 * 回傳 null 表示通用、不需要專科
 */
export function getSpecialistPrompt(platform: PlatformName): string | null {
  if (!platform) return null;
  return PLATFORM_TRAINING[platform] || null;
}
