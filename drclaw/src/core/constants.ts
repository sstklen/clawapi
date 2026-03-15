/**
 * Debug 醫生 — 所有常數和設定值
 * 從 debug-ai.ts 抽取，集中管理門檻值、價格、設定
 */

import type { DebugEntry, VerificationInfo } from './types';

// ─── 向量搜尋 ───

/** 向量搜尋最低相似度（0.6 = 寬鬆，寧可多命中、少漏掉） */
export const SIMILARITY_THRESHOLD = 0.6;

// ─── 內部記錄參數（目前全部為 0，保留結構供未來擴展） ───

export const PRICE_ANALYZE = 0;
export const PRICE_KB_HIT = 0;
export const REFUND_ON_HIT = 0;
export const CONTRIBUTOR_REWARD = 0;
export const CONTRIBUTE_REWARD = 0;
/** KB+LLM 綜合模式 */
export const PRICE_KB_AUGMENTED = 0;

// ─── 信心分 ───

/** 信心分門檻：低於此值 → 誠實說不會，走 escalate 路線 */
export const CONFIDENCE_THRESHOLD = 0.5;

// ─── Dr. Claw 醫生模式 ───

/** 餵給 LLM 的 KB 條目品質門檻（S+A+B 等級）*/
export const DRCLAW_QUALITY_THRESHOLD = 0.6;
/** KB context 最多幾筆條目（防 prompt 太長）*/
export const DRCLAW_MAX_KB_ENTRIES = 3;
/** 每筆 KB 條目最大字元數 */
export const DRCLAW_MAX_ENTRY_CHARS = 600;

// ─── Dr. Claw 驗證飛輪 ───

/** 幾人驗證後才切換到 success_rate 排序 */
export const DRCLAW_VERIFIED_THRESHOLD = 3;
/** 高於此 = community_verified */
export const DRCLAW_SUCCESS_RATE_GOOD = 0.7;
/** 低於此 = low_success */
export const DRCLAW_SUCCESS_RATE_BAD = 0.5;

// ─── 望聞問切 ───

/** 品質分數門檻：高於此值跳過問診，直接走現有流程 */
export const DIAGNOSIS_SKIP_THRESHOLD = 75;
/** 品質分數門檻：50~74 走短問診（望聞 2 輪），<50 走完整 4 輪 */
export const DIAGNOSIS_SHORT_THRESHOLD = 50;
/** Session 過期時間（1 小時） */
export const DIAGNOSIS_SESSION_TTL_MS = 60 * 60 * 1000;

// ─── 自動收集 ───

/** 每日自動收集上限（防洪水） */
export const AUTO_COLLECT_DAILY_LIMIT = 100;
/** 自動收集去重時間窗口（1 小時） */
export const DEDUP_WINDOW_MS = 60 * 60 * 1000;

// ─── 系統 Prompt ───

/** 顏回系統 prompt（用於 Sonnet 分析） */
export const DEBUG_SYSTEM_PROMPT = `You are 顏回 (Yan Hui) — Confucius's most diligent student. Your master praised you for "不貳過" (never repeating a mistake).

You are a debugging specialist. You ONLY help with real software bugs, errors, and technical problems.

IMPORTANT — REJECT non-debug requests:
If the input is NOT a real error/bug/technical problem (e.g. "write me code", "explain X", "help me with Y", general questions, creative requests), respond with:
{"category":"not_a_bug","root_cause":"This is not a debugging question","severity":0,"confidence":1.0,"fix_description":"Confucius Debug only helps with debugging. Please describe an actual error or bug.","fix_steps":[],"fix_patch":""}

For REAL bugs, respond with valid JSON (no markdown):
{
  "root_cause": "Brief description of why this error occurs",
  "category": "One of: api_error, config_error, logic_error, dependency_error, network_error, permission_error, data_error, general",
  "severity": 1-5 (1=trivial, 5=critical),
  "confidence": 0.0-1.0 (how confident you are),
  "fix_description": "How to fix it",
  "fix_steps": ["Step 1", "Step 2", ...],
  "fix_patch": "Code patch or config change (if applicable, otherwise empty string)"
}

Focus on:
- AI Agent issues (API rate limits, token counting, context overflow, tool calling errors)
- Node.js/Bun/TypeScript runtime errors
- Docker/deployment issues
- Database (SQLite/Postgres) issues
- API integration problems (Anthropic, OpenAI, Google, etc.)

Be concise, accurate, and practical. Always provide actionable fix steps.`;

// ─── 共用工具函數 ───

/**
 * 清理 LLM 回傳的 JSON 文本（移除 markdown code fences）
 * 三處使用：quality-scorer / sonnet-client / waterfall
 */
export function cleanLLMJsonText(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

/** 建構 verification info（給回覆用） */
export function buildVerificationInfo(entry: DebugEntry): VerificationInfo {
  const vc = entry.verified_count || 0;
  const sc = entry.success_count || 0;
  const rate = vc > 0 ? sc / vc : null;
  let status: VerificationInfo['status'] = 'unverified';
  if (vc >= DRCLAW_VERIFIED_THRESHOLD && rate !== null && rate >= DRCLAW_SUCCESS_RATE_GOOD) {
    status = 'community_verified';
  } else if (vc >= DRCLAW_VERIFIED_THRESHOLD && rate !== null && rate < DRCLAW_SUCCESS_RATE_BAD) {
    status = 'low_success';
  } else if (vc >= 1) {
    status = 'partially_verified';
  }
  return {
    kb_entry_id: entry.id || 0,
    verified_count: vc,
    success_rate: rate !== null ? parseFloat(rate.toFixed(3)) : null,
    last_verified: entry.last_verified_at || null,
    status,
  };
}
