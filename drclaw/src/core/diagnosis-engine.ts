/**
 * Debug 醫生 — 望聞問切引擎
 *
 * Dr. Claw 的多輪問診系統：
 * - 望（看症狀）→ 聞（聽脈絡）→ 問（質疑假設）→ 切（開藥）
 * - 根據描述品質自動跳過不必要的階段
 * - 「切」階段走三層瀑布：KB → Opus → Sonnet
 */

import { createLogger } from '../logger';
import { getDb } from '../database';
import { getKeyOrEnv } from '../key-manager';
import { DIAGNOSIS_SKIP_THRESHOLD, DIAGNOSIS_SHORT_THRESHOLD, DIAGNOSIS_SESSION_TTL_MS, DRCLAW_QUALITY_THRESHOLD } from './constants';
import { searchKnowledge } from './kb-store';
import { tryOpusRelay } from './opus-bridge';
import { scoreDescriptionQuality } from './quality-scorer';
import { analyzeWithSonnet } from './sonnet-client';
import type { CollectedInfo, DebugAnalysis, DiagnosisPhase, DiagnosisSession } from './types';
import { analyzeWithKBContext } from './waterfall';

const log = createLogger('DiagnosisEngine');

// ============================================
// Session CRUD
// ============================================

/** 產生 session ID */
export function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `diag_${ts}_${rand}`;
}

/** 建立新的問診 session（含環境資訊保存） */
export function createDiagnosisSession(
  lobsterId: string,
  description: string,
  score: number,
  environment?: Record<string, any>,
): DiagnosisSession {
  const db = getDb();
  const id = generateSessionId();
  const now = new Date().toISOString();

  // 如果有 environment，提前存進 collected_info（避免問診路徑丟失環境資訊）
  const initialCollected: CollectedInfo = environment ? { environment } : {};

  db.run(
    `INSERT INTO debug_sessions (id, lobster_id, phase, round, initial_description, initial_score, collected_info, conversation, status, created_at, updated_at)
     VALUES (?, ?, '望', 1, ?, ?, ?, '[]', 'active', ?, ?)`,
    [id, lobsterId, description, score, JSON.stringify(initialCollected), now, now],
  );

  return db.prepare('SELECT * FROM debug_sessions WHERE id = ?').get(id) as DiagnosisSession;
}

/** 載入 session（含過期檢查） */
export function loadDiagnosisSession(sessionId: string): DiagnosisSession | null {
  const db = getDb();
  const session = db.prepare('SELECT * FROM debug_sessions WHERE id = ?').get(sessionId) as DiagnosisSession | null;
  if (!session) return null;

  // 過期檢查
  if (session.status === 'active') {
    const age = Date.now() - new Date(session.created_at).getTime();
    if (age > DIAGNOSIS_SESSION_TTL_MS) {
      db.run("UPDATE debug_sessions SET status = 'expired', updated_at = ? WHERE id = ?",
        [new Date().toISOString(), sessionId]);
      return null;
    }
  }

  return session;
}

/** 更新 session（白名單防禦 SQL 注入） */
const SESSION_COLUMNS = new Set(['phase', 'round', 'collected_info', 'conversation', 'diagnosis', 'kb_candidates', 'status']);

export function updateDiagnosisSession(
  sessionId: string,
  updates: Partial<Pick<DiagnosisSession, 'phase' | 'round' | 'collected_info' | 'conversation' | 'diagnosis' | 'kb_candidates' | 'status'>>,
): void {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const params: any[] = [new Date().toISOString()];

  for (const [key, val] of Object.entries(updates)) {
    if (!SESSION_COLUMNS.has(key)) {
      log.warn(`updateDiagnosisSession: 非法欄位名 "${key}"，已忽略`);
      continue;
    }
    sets.push(`${key} = ?`);
    params.push(val);
  }

  params.push(sessionId);
  db.run(`UPDATE debug_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
}

// ============================================
// 龍蝦成熟度
// ============================================

/** 更新龍蝦的 debug_maturity 等級 */
export function updateDebugMaturity(lobsterId: string, newLevel: number): void {
  const db = getDb();
  try {
    db.run('UPDATE lobster_accounts SET debug_maturity = MAX(debug_maturity, ?), updated_at = ? WHERE lobster_id = ?',
      [newLevel, new Date().toISOString(), lobsterId]);
  } catch { /* 遷移尚未跑的舊 DB → 忽略 */ }
}

/** 取得龍蝦的 debug_maturity */
export function getDebugMaturity(lobsterId: string): number {
  const db = getDb();
  try {
    const row = db.prepare('SELECT debug_maturity FROM lobster_accounts WHERE lobster_id = ?').get(lobsterId) as any;
    return row?.debug_maturity || 0;
  } catch { return 0; }
}

// ============================================
// 核心：多輪問診
// ============================================

/**
 * 產生問診問題（望聞問切）
 * 望/聞：模板問題（不花 LLM 成本）
 * 問：用 Haiku 生成蘇格拉底式挑戰（幾乎免費）
 * 切：綜合診斷（走三層瀑布）
 */
export async function generateDiagnosticQuestion(
  session: DiagnosisSession,
  answer?: string,
): Promise<{
  status: 'diagnosing' | 'diagnosed';
  phase: string;
  round: number;
  question?: string;
  action?: string;
  diagnosis?: any;
  lesson?: string;
}> {
  const collected: CollectedInfo = JSON.parse(session.collected_info || '{}');
  const conversation: Array<{ phase: string; question: string; answer: string }> = JSON.parse(session.conversation || '[]');
  const currentPhase = session.phase as DiagnosisPhase;

  // 如果有 answer，先存進去
  if (answer && conversation.length > 0) {
    conversation[conversation.length - 1].answer = answer;
  }

  // 根據 initial_score 決定最大輪數
  const maxRounds = session.initial_score < DIAGNOSIS_SHORT_THRESHOLD ? 4 : 2;

  // 決定下一個階段
  let nextPhase: DiagnosisPhase;
  let nextRound = session.round;

  if (!answer) {
    // 第一輪（剛建立 session），直接問望
    nextPhase = '望';
    nextRound = 1;
  } else {
    // 根據當前階段收集資訊
    switch (currentPhase) {
      case '望':
        collected.error_message = answer;
        nextPhase = maxRounds >= 3 ? '聞' : '問';
        nextRound = session.round + 1;
        break;
      case '聞':
        collected.context = answer;
        collected.changes = answer; // 聞同時收集 context 和 changes
        nextPhase = '問';
        nextRound = session.round + 1;
        break;
      case '問':
        collected.assumptions = answer;
        nextPhase = '切';
        nextRound = session.round + 1;
        break;
      default:
        nextPhase = '切';
        nextRound = session.round + 1;
    }
  }

  // 檢查是否要提前結束（龍蝦回答太完整了）
  if (answer && nextPhase !== '切') {
    const reScore = scoreDescriptionQuality(
      `${session.initial_description} ${answer}`,
      collected.error_message,
      collected.environment,
    );
    if (reScore.score >= DIAGNOSIS_SKIP_THRESHOLD) {
      nextPhase = '切';
      log.info(`望聞問切: 龍蝦回答充分 (score=${reScore.score})，提前進入「切」`);
    }
  }

  // 更新 session
  const updatedConversation = JSON.stringify(conversation);
  const updatedCollected = JSON.stringify(collected);

  if (nextPhase === '切') {
    // 切 = 開藥 → 走三層瀑布
    updateDiagnosisSession(session.id, {
      phase: '切',
      round: nextRound,
      collected_info: updatedCollected,
      conversation: updatedConversation,
      status: 'diagnosed',
    });

    // 組合所有收集到的資訊，送去分析
    const enrichedDescription = [
      session.initial_description,
      collected.error_message ? `Error: ${collected.error_message}` : '',
      collected.context ? `Context: ${collected.context}` : '',
      collected.changes ? `Recent changes: ${collected.changes}` : '',
      collected.assumptions ? `Additional info: ${collected.assumptions}` : '',
    ].filter(Boolean).join('\n');

    const enrichedErrorMessage = collected.error_message || '';

    // 搜尋 KB
    const kbHits = await searchKnowledge(`${enrichedDescription} ${enrichedErrorMessage}`.trim(), 5);
    const qualityHits = kbHits.filter(h => h.quality_score >= DRCLAW_QUALITY_THRESHOLD);

    let diagnosis: DebugAnalysis;
    if (qualityHits.length > 0) {
      // 有 KB 命中 → KB + LLM 綜合（裡面會先試 Opus）
      try {
        diagnosis = await analyzeWithKBContext(enrichedDescription, enrichedErrorMessage, collected.environment || {}, qualityHits);
      } catch {
        diagnosis = await analyzeWithSonnet(enrichedDescription, enrichedErrorMessage, collected.environment || {});
      }
    } else {
      // 沒 KB 命中 → 先問住院醫生（Opus），不在才叫門診（Sonnet）
      const opusResult = await tryOpusRelay(enrichedDescription, enrichedErrorMessage, collected.environment || {});
      if (opusResult && opusResult.category !== 'not_a_bug') {
        diagnosis = opusResult;
      } else {
        diagnosis = await analyzeWithSonnet(enrichedDescription, enrichedErrorMessage, collected.environment || {});
      }
    }

    // 生成 lesson（教龍蝦下次怎麼描述）
    const lesson = generateLesson(session, collected, diagnosis);

    // 更新 session 的 diagnosis
    updateDiagnosisSession(session.id, {
      diagnosis: JSON.stringify(diagnosis),
      kb_candidates: JSON.stringify(kbHits.map(h => h.id)),
    });

    return {
      status: 'diagnosed',
      phase: '切',
      round: nextRound,
      diagnosis: {
        root_cause: diagnosis.root_cause,
        category: diagnosis.category,
        severity: diagnosis.severity,
        confidence: diagnosis.confidence,
        fix_description: diagnosis.fix_description,
        fix_steps: diagnosis.fix_steps,
        fix_patch: diagnosis.fix_patch,
      },
      lesson,
    };
  }

  // 生成問題
  let question: string;
  let action: string;

  switch (nextPhase) {
    case '望':
      // 望（看症狀）— 收集 error_message
      question = 'Show me the exact error message or stack trace. If it\'s an API error, include the status code and response body.';
      action = 'Run the failing command again and capture the full output. If possible, include the complete stack trace.';
      break;

    case '聞':
      // 聞（聽脈絡）— 收集 context + recent_changes
      question = 'When did this start happening? What was the last thing you changed before this broke? Run `git log --oneline -5` or check your recent deployment/config changes.';
      action = 'Compare current behavior with the previous working state. Identify the exact moment it started failing.';
      break;

    case '問':
      // 問（質疑假設）— 用 Haiku 生成蘇格拉底式挑戰
      question = await generateSocraticChallenge(session, collected, conversation);
      action = 'Run the verification command suggested above and share the results. This helps rule out false assumptions.';
      break;

    default:
      question = 'Please provide any additional information about this error.';
      action = 'Share logs, configuration, or environment details.';
  }

  // 把新問題加入對話
  conversation.push({ phase: nextPhase, question, answer: '' });

  updateDiagnosisSession(session.id, {
    phase: nextPhase,
    round: nextRound,
    collected_info: updatedCollected,
    conversation: JSON.stringify(conversation),
  });

  return {
    status: 'diagnosing',
    phase: nextPhase,
    round: nextRound,
    question,
    action,
  };
}

// ============================================
// 輔助函數
// ============================================

/**
 * 用 Haiku 生成蘇格拉底式挑戰（「問」階段）
 * 根據前兩輪收集的資訊，挑戰龍蝦的假設
 */
export async function generateSocraticChallenge(
  session: DiagnosisSession,
  collected: CollectedInfo,
  conversation: Array<{ phase: string; question: string; answer: string }>,
): Promise<string> {
  try {
    const claudeKey = getKeyOrEnv('anthropic', 'ANTHROPIC_API_KEY');
    if (!claudeKey) throw new Error('no key');

    const conversationSummary = conversation
      .filter(c => c.answer)
      .map(c => `[${c.phase}] Q: ${c.question}\nA: ${c.answer}`)
      .join('\n\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-20250514',
        max_tokens: 300,
        temperature: 0.4,
        system: `You are Dr. Claw, a debugging specialist. Based on the diagnostic conversation so far, generate ONE Socratic question that challenges the lobster's (AI agent's) assumptions about their bug.

Rules:
- Challenge a specific assumption the lobster made
- Include a concrete verification command they can run
- Keep it under 3 sentences
- Be specific, not generic
- Write in English (the lobster is an AI agent)`,
        messages: [{
          role: 'user',
          content: `Original problem: ${session.initial_description}

Diagnostic conversation so far:
${conversationSummary}

Generate ONE Socratic challenge question with a verification command.`,
        }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const json = await res.json() as any;
      const text = json.content?.[0]?.text;
      if (text) return text.trim();
    }
  } catch (err: any) {
    log.warn(`望聞問切「問」Haiku 生成失敗: ${err.message}，用模板替代`);
  }

  // Fallback：模板問題
  return `You described: "${session.initial_description.substring(0, 80)}". What assumption are you making about the root cause? Try isolating the failing component — does the error persist if you test that component alone?`;
}

/**
 * 生成 lesson（教龍蝦下次怎麼描述 bug）
 */
export function generateLesson(
  session: DiagnosisSession,
  collected: CollectedInfo,
  diagnosis: any,
): string {
  const missing: string[] = [];
  if (!collected.error_message) missing.push('error message/stack trace');
  if (!collected.context) missing.push('context (when did it start)');
  if (!collected.changes) missing.push('recent changes');

  if (missing.length === 0) {
    return `Great job describing this bug! Next time you see a ${diagnosis.category || 'similar'} error, check ${diagnosis.root_cause?.substring(0, 50) || 'the root cause'} first.`;
  }

  return `Next time, include: ${missing.join(', ')} in your initial description. This saves ${missing.length} round(s) of questioning and gets you a fix faster.`;
}
