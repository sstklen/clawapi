/**
 * Debug 醫生 — 品質評分系統
 * 1. scoreDescriptionQuality：描述品質 0-100 分（純函數，零依賴）
 * 2. filterEntriesWithAI：Onboard 批次品質把關（Haiku AI 辨識）
 */

import { createLogger } from '../logger';
import { getKeyOrEnv, reportKeyResult } from '../key-manager';
import { cleanLLMJsonText } from './constants';
import type { FilteredEntry } from './types';

const log = createLogger('QualityScorer');

// ============================================
// 描述品質評分（純函數）
// ============================================

/**
 * 評估描述品質（0-100 分）
 * 決定要不要啟動問診、問幾輪
 */
export function scoreDescriptionQuality(
  errorDescription: string,
  errorMessage?: string,
  environment?: Record<string, any>,
): { score: number; missing: string[] } {
  let score = 0;
  const missing: string[] = [];

  // +25：有 error_message（完整錯誤訊息或 stack trace）
  if (errorMessage && errorMessage.length > 10) {
    score += 25;
  } else {
    missing.push('error_message');
  }

  // +25：有 context（描述中包含脈絡詞）
  const contextWords = /when|doing|after|before|during|while|tried|trying|happens|started|suddenly|used to work|worked before|停止|開始|之後|之前|當|嘗試/i;
  if (contextWords.test(errorDescription)) {
    score += 25;
  } else {
    missing.push('context');
  }

  // +25：有 change_info（描述中包含變更詞）
  const changeWords = /upgrade|deploy|update|change|install|migrate|config|version|新版|升級|部署|更新|改了|換了|安裝/i;
  if (changeWords.test(errorDescription)) {
    score += 25;
  } else {
    missing.push('recent_changes');
  }

  // +15：有 environment 資訊
  if (environment && Object.keys(environment).length > 0) {
    score += 15;
  } else {
    missing.push('environment');
  }

  // +10：描述長度 > 100 字元
  if (errorDescription.length > 100) {
    score += 10;
  } else {
    missing.push('more_detail');
  }

  return { score: Math.min(score, 100), missing };
}

// ============================================
// Onboard 品質把關：整批 AI 辨識（一批進一批出）
// ============================================

/**
 * 整批送 AI 辨識 onboard entries 品質
 * 一次 API call 處理所有條目（一批進一批出）
 * 用 Prompt Caching 省 90%
 */
export async function filterEntriesWithAI(
  entries: Array<{ error_description: string; error_message?: string; error_category?: string; root_cause?: string; fix_description?: string; }>,
): Promise<FilteredEntry[]> {
  const claudeKey = getKeyOrEnv('anthropic', 'ANTHROPIC_API_KEY');
  if (!claudeKey) {
    // 沒有 key → 全部給 0.3 分直接過（降級模式）
    log.warn('Onboard 品質把關：無 API key，降級為全部通過（quality=0.3）');
    return entries.map((_, i) => ({
      index: i, is_real_bug: true, quality_score: 0.3,
      category: 'general', has_sensitive_data: false, reason: 'no_api_key_fallback',
    }));
  }

  // 組裝批次 prompt：把所有 entries 編號列出
  const entrySummaries = entries.map((e, i) => {
    const parts = [`[${i}] ${e.error_description}`];
    if (e.error_message) parts.push(`  Error: ${e.error_message.substring(0, 200)}`);
    if (e.root_cause) parts.push(`  Cause: ${e.root_cause.substring(0, 150)}`);
    if (e.fix_description) parts.push(`  Fix: ${e.fix_description.substring(0, 150)}`);
    return parts.join('\n');
  }).join('\n\n');

  const systemPrompt = `You are a quality filter for a debug knowledge base. Your job is to classify a batch of bug entries.

For EACH entry, determine:
1. is_real_bug: Is this a genuine software bug/error? (false for: feature additions, refactoring, documentation, non-bugs)
2. quality_score: 0.0-1.0 (0.9=excellent bug report with root cause+fix, 0.7=good, 0.5=okay, 0.3=minimal, <0.3=not useful)
3. category: api_error|config_error|logic_error|dependency_error|network_error|permission_error|data_error|build_error|type_error|general
4. has_sensitive_data: Does the entry contain API keys, passwords, tokens, personal info, or secrets?
5. reason: Brief explanation (10 words max)

IMPORTANT RULES:
- Entries with sensitive data (API keys, passwords, tokens) must be REJECTED (is_real_bug=false)
- Entries that are just "added feature X" or "updated docs" are NOT bugs
- Be strict: only real bugs that would help other developers should pass

Respond with ONLY a JSON array, no markdown, no explanation:
[{"index":0,"is_real_bug":true,"quality_score":0.7,"category":"config_error","has_sensitive_data":false,"reason":"Valid config bug with fix"}]`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        temperature: 0.1,
        system: [{
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{
          role: 'user',
          content: `Classify these ${entries.length} entries:\n\n${entrySummaries}`,
        }],
      }),
      signal: AbortSignal.timeout(60000), // 大批量給多一點時間
    });

    if (!res.ok) {
      reportKeyResult('anthropic', claudeKey, false, res.status === 429 ? 'rate-limit' : 'error');
      log.warn(`Onboard AI 辨識失敗 HTTP ${res.status}，降級為全部通過`);
      return entries.map((_, i) => ({
        index: i, is_real_bug: true, quality_score: 0.3,
        category: 'general', has_sensitive_data: false, reason: 'ai_filter_failed',
      }));
    }

    reportKeyResult('anthropic', claudeKey, true);
    const json = await res.json() as any;
    const text = json.content?.[0]?.text || '';

    // 記錄 cache 使用情況
    const cacheInfo = json.usage?.cache_read_input_tokens
      ? `cache_hit=${json.usage.cache_read_input_tokens} (省 90%!)`
      : json.usage?.cache_creation_input_tokens
        ? `cache_created=${json.usage.cache_creation_input_tokens}`
        : 'no_cache';
    log.info(`Onboard AI 辨識完成: ${entries.length} 筆, ${cacheInfo}`);

    // 解析 JSON + 防 LLM 幻覺
    const cleaned = cleanLLMJsonText(text);
    const raw = JSON.parse(cleaned) as any[];

    // 用 index map 容錯：LLM 可能少回、多回、亂序
    const resultMap = new Map<number, any>(raw.map(r => [r.index, r]));
    return entries.map((_, i) => {
      const r = resultMap.get(i);
      return {
        index: i,
        is_real_bug: typeof r?.is_real_bug === 'boolean' ? r.is_real_bug : true,
        quality_score: typeof r?.quality_score === 'number' ? r.quality_score : 0.3,
        category: typeof r?.category === 'string' ? r.category : 'general',
        has_sensitive_data: typeof r?.has_sensitive_data === 'boolean' ? r.has_sensitive_data : false,
        reason: typeof r?.reason === 'string' ? r.reason : 'ai_missing_result',
      };
    });
  } catch (err: any) {
    log.warn(`Onboard AI 辨識例外: ${err.message}，降級為全部通過`);
    return entries.map((_, i) => ({
      index: i, is_real_bug: true, quality_score: 0.3,
      category: 'general', has_sensitive_data: false, reason: 'ai_filter_exception',
    }));
  }
}
