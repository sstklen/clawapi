/**
 * Debug 醫生 — 三層瀑布分析
 *
 * KB 命中 + LLM 綜合分析的核心流程：
 * 1. Opus Relay（最強腦袋） → 在線就用
 * 2. Sonnet API 備援 → Opus 不在才用
 *
 * 注入專科 prompt（來自 specialist.ts）
 */

import { createLogger } from '../logger';
import { getKeyOrEnv, reportKeyResult } from '../key-manager';
import { DRCLAW_QUALITY_THRESHOLD, DRCLAW_MAX_KB_ENTRIES, DRCLAW_MAX_ENTRY_CHARS, DEBUG_SYSTEM_PROMPT, cleanLLMJsonText } from './constants';
import { isOpusRelayOnline, tryOpusRelay } from './opus-bridge';
import { detectPlatform, getSpecialistPrompt } from './specialist';
import type { DebugAnalysis, DebugEntry, KBAugmentedAnalysis } from './types';

const log = createLogger('Waterfall');

/**
 * KB context + LLM 綜合分析
 *
 * 讀完 KB 案例 + 龍蝦的具體狀況 → 綜合出量身回答
 * 比純 KB 貼答案更精準，比純 AI 分析有驗證根據
 *
 * @param errorDescription 龍蝦的錯誤描述
 * @param errorMessage 錯誤訊息/stack trace
 * @param environment 環境資訊
 * @param kbHits 知識庫命中條目
 * @returns 分析結果（含 kb_entry_ids + validated_by_kb）
 */
export async function analyzeWithKBContext(
  errorDescription: string,
  errorMessage: string,
  environment: Record<string, any>,
  kbHits: DebugEntry[],
): Promise<KBAugmentedAnalysis> {

  // 組裝 KB context（只取高品質、截短、最多 N 筆）
  const qualityHits = kbHits
    .filter(h => h.quality_score >= DRCLAW_QUALITY_THRESHOLD)
    .slice(0, DRCLAW_MAX_KB_ENTRIES);

  const kbContext = qualityHits.map((h, i) => {
    const truncate = (s: string) => s.length > DRCLAW_MAX_ENTRY_CHARS ? s.substring(0, DRCLAW_MAX_ENTRY_CHARS) + '...' : s;
    return [
      `--- KB Entry #${i + 1} (id:${h.id}, quality:${h.quality_score.toFixed(2)}, verified:${h.verified === 1 ? 'YES' : 'NO'}, hits:${h.hit_count}) ---`,
      `Problem: ${truncate(h.error_description)}`,
      h.root_cause ? `Root Cause: ${truncate(h.root_cause)}` : '',
      h.fix_description ? `Fix: ${truncate(h.fix_description)}` : '',
      h.fix_patch ? `Patch: ${truncate(h.fix_patch)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const kbEntryIds = qualityHits.map(h => h.id);

  // ── 第一優先：Opus Relay（免費 + 最強腦袋）──
  if (isOpusRelayOnline()) {
    try {
      const opusResult = await tryOpusRelay(
        errorDescription, errorMessage, environment,
        { text: kbContext, entryIds: kbEntryIds as number[] },
      );
      if (opusResult) {
        // Opus Relay may return extra KB fields beyond DebugAnalysis
        const opusExtra = opusResult as DebugAnalysis & Partial<KBAugmentedAnalysis>;
        log.info(`Drclaw Opus Relay 完成: confidence=${opusExtra.confidence}`);
        return {
          ...opusResult,
          validated_by_kb: opusExtra.validated_by_kb ?? true,
          kb_entry_ids: Array.isArray(opusExtra.kb_entry_ids)
            ? opusExtra.kb_entry_ids
            : kbEntryIds as number[],
        };
      }
    } catch (err: any) {
      log.info(`Opus Relay 失敗，降級 Sonnet API: ${err.message?.slice(0, 60)}`);
    }
  }

  // ── 第二備援：Sonnet API ──
  const claudeKey = getKeyOrEnv('anthropic', 'ANTHROPIC_API_KEY');
  if (!claudeKey) throw new Error('Opus Relay 不在線，Anthropic 也無可用 Key');

  // 專科偵測 + prompt 注入
  const platform = detectPlatform(errorDescription, errorMessage);
  const specialistPrompt = getSpecialistPrompt(platform);

  const kbSystemBlock = `You also have access to the YanHui KB — verified solutions from previous bugs.
Use these KB entries as REFERENCE, not copy-paste answers.
ADAPT the solution to match the user's SPECIFIC error message and environment.

${kbContext}

INSTRUCTIONS:
1. If KB entries are relevant → use them as starting point, adapt to user's specific context
2. Set validated_by_kb: true ONLY if user's error closely matches a verified (or high-quality) KB entry
3. If KB says fix A but user's error_message suggests problem B → trust the evidence over KB
4. Include kb_entry_ids (array of entry id numbers you actually used)

Respond with valid JSON (no markdown):
{
  "root_cause": "...",
  "category": "api_error|config_error|logic_error|dependency_error|network_error|permission_error|data_error|general",
  "severity": 1-5,
  "confidence": 0.0-1.0,
  "fix_description": "...",
  "fix_steps": ["Step 1", ...],
  "fix_patch": "...",
  "validated_by_kb": true/false,
  "kb_entry_ids": [42, 17]
}`;

  const userPrompt = [
    `Error Description: ${errorDescription}`,
    errorMessage ? `Error Message: ${errorMessage}` : '',
    Object.keys(environment).length > 0 ? `Environment: ${JSON.stringify(environment)}` : '',
  ].filter(Boolean).join('\n\n');

  // system 陣列：固定 prompt（帶 cache_control）+ KB context + 專科 prompt
  const systemBlocks: Array<{ type: string; text: string; cache_control?: { type: string } }> = [
    {
      type: 'text',
      text: DEBUG_SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: kbSystemBlock,
    },
  ];
  if (specialistPrompt) {
    systemBlocks.push({ type: 'text', text: specialistPrompt });
  }

  const requestBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096, // v5.3: 從 2048 提升 — 2048 導致 73% 回覆被截斷
    temperature: 0.3,
    system: systemBlocks,
    messages: [
      { role: 'user', content: userPrompt },
    ],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text();
    reportKeyResult('anthropic', claudeKey, false, res.status === 429 ? 'rate-limit' : 'error');
    throw new Error(`Drclaw Sonnet HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }

  reportKeyResult('anthropic', claudeKey, true);
  const json = await res.json() as any;
  const text = json.content?.[0]?.text;
  if (!text) throw new Error('Drclaw Sonnet 回傳空內容');

  try {
    const cleaned = cleanLLMJsonText(text);
    const result = JSON.parse(cleaned);

    // 記錄 cache 使用情況
    const cacheInfo = json.usage?.cache_read_input_tokens
      ? `cache_hit=${json.usage.cache_read_input_tokens}`
      : 'no_cache';
    const platformInfo = platform ? ` [${platform}]` : '';
    log.info(`Drclaw Sonnet 完成: kb_entries=${qualityHits.length}, confidence=${result.confidence}, ${cacheInfo}${platformInfo}`);

    return {
      root_cause: result.root_cause || '',
      category: result.category || 'general',
      severity: Math.min(Math.max(result.severity || 3, 1), 5),
      confidence: Math.min(Math.max(result.confidence || 0, 0), 1),
      fix_description: result.fix_description || '',
      fix_steps: result.fix_steps || [],
      fix_patch: result.fix_patch || '',
      validated_by_kb: !!result.validated_by_kb,
      kb_entry_ids: Array.isArray(result.kb_entry_ids) ? result.kb_entry_ids : qualityHits.map(h => h.id),
    };
  } catch {
    log.warn('Drclaw JSON 解析失敗，降級為純 KB 回傳');
    // 降級：回傳最佳 KB 條目（防禦性 null guard）
    const best = qualityHits[0] || kbHits[0];
    if (!best) throw new Error('Drclaw JSON 解析失敗且無 KB 條目可降級');
    return {
      root_cause: best.root_cause,
      category: best.error_category,
      severity: 3,
      confidence: best.quality_score,
      fix_description: best.fix_description,
      fix_steps: [best.fix_description],
      fix_patch: best.fix_patch,
      validated_by_kb: true,
      kb_entry_ids: [best.id as number],
    };
  }
}
