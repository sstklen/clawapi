/**
 * Debug 醫生 — Sonnet 分析客戶端
 *
 * 呼叫 Claude Sonnet 4.6 分析錯誤（使用 Prompt Caching）
 * 注入專科 prompt（來自 specialist.ts）
 */

import { createLogger } from '../logger';
import { getKeyOrEnv, reportKeyResult } from '../key-manager';
import { DEBUG_SYSTEM_PROMPT, cleanLLMJsonText } from './constants';
import { detectPlatform, getSpecialistPrompt } from './specialist';
import type { DebugAnalysis } from './types';

const log = createLogger('SonnetClient');

/**
 * 呼叫 Claude Sonnet 4.6 分析錯誤
 * 使用 Prompt Caching 讓 system prompt 快取（90% off）
 * 自動偵測平台並注入專科 prompt
 */
export async function analyzeWithSonnet(
  errorDescription: string,
  errorMessage: string,
  environment: Record<string, any> = {},
): Promise<DebugAnalysis> {
  const claudeKey = getKeyOrEnv('anthropic', 'ANTHROPIC_API_KEY');
  if (!claudeKey) throw new Error('Anthropic 無可用 Key');

  // 專科偵測 + prompt 注入
  const platform = detectPlatform(errorDescription, errorMessage);
  const specialistPrompt = getSpecialistPrompt(platform);

  const userPrompt = [
    `Error Description: ${errorDescription}`,
    errorMessage ? `Error Message: ${errorMessage}` : '',
    Object.keys(environment).length > 0 ? `Environment: ${JSON.stringify(environment)}` : '',
  ].filter(Boolean).join('\n\n');

  // system 陣列：第一個帶 cache_control（大型固定 prompt），專科 prompt 不帶（每次可能不同）
  const systemBlocks: Array<{ type: string; text: string; cache_control?: { type: string } }> = [
    {
      type: 'text',
      text: DEBUG_SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
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
    throw new Error(`Sonnet HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }

  reportKeyResult('anthropic', claudeKey, true);
  const json = await res.json() as any;

  const text = json.content?.[0]?.text;
  if (!text) throw new Error('Sonnet 回傳空內容');

  // 解析 JSON
  try {
    // 清除可能的 markdown 包裹
    const cleaned = cleanLLMJsonText(text);
    const analysis = JSON.parse(cleaned) as DebugAnalysis;

    // 記錄 cache 使用情況
    const cacheInfo = json.usage?.cache_creation_input_tokens
      ? `cache_created=${json.usage.cache_creation_input_tokens}`
      : json.usage?.cache_read_input_tokens
        ? `cache_hit=${json.usage.cache_read_input_tokens} (省 90%!)`
        : 'no_cache';
    const platformInfo = platform ? ` [${platform}]` : '';
    log.info(`Sonnet 分析完成: severity=${analysis.severity}, confidence=${analysis.confidence}, ${cacheInfo}${platformInfo}`);

    return analysis;
  } catch {
    log.warn('Sonnet JSON 解析失敗，使用原始文本');
    return {
      root_cause: text.substring(0, 200),
      category: 'general',
      severity: 3,
      confidence: 0.5,
      fix_description: text,
      fix_steps: [text.substring(0, 300)],
      fix_patch: '',
    };
  }
}
