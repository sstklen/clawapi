/**
 * Debug 核心路由
 *
 * GET  /debug-ai       — 服務說明 + 統計
 * POST /debug-ai       — 提交 bug → 三層瀑布解坑（含望聞問切）
 */

import type { Hono } from 'hono';
import { createLogger } from '../logger';
import { getDb } from '../database';
import {
  PRICE_ANALYZE, PRICE_KB_HIT, REFUND_ON_HIT,
  CONTRIBUTOR_REWARD, PRICE_KB_AUGMENTED,
  CONFIDENCE_THRESHOLD, DRCLAW_QUALITY_THRESHOLD, DRCLAW_MAX_KB_ENTRIES,
  DIAGNOSIS_SKIP_THRESHOLD, buildVerificationInfo,
} from '../core/constants';
import { debugStats, incrementStat } from '../core/stats';
import { logSearchQuery } from '../core/search-log';
import { scoreDescriptionQuality } from '../core/quality-scorer';
import { getOrCreateAccount, creditAccount, debitAccount, recordProblemSolved } from '../core/lobster-account';
import { detectSilentSignal, cleanExpiredSessions } from '../core/silent-signal';
import { searchKnowledge, contributeDebugKnowledge } from '../core/kb-store';
import { extractChannel } from '../core/auto-collector';
import {
  createDiagnosisSession, loadDiagnosisSession,
  updateDebugMaturity, getDebugMaturity, generateDiagnosticQuestion,
} from '../core/diagnosis-engine';
import { analyzeWithSonnet } from '../core/sonnet-client';
import { analyzeWithKBContext } from '../core/waterfall';
import { isOpusRelayOnline, tryOpusRelay } from '../core/opus-bridge';

const log = createLogger('DebugRoutes:Core');

export function registerCoreRoutes(router: Hono): void {

  // ── GET /debug-ai — 服務說明 + 統計 ──
  router.get('/debug-ai', (c) => {
    const db = getDb();

    // 順便清理過期 sessions + 偵測沈默訊號
    const expired = cleanExpiredSessions();
    if (expired > 0) log.info(`清理 ${expired} 個過期問診 session`);
    const silentSignals = detectSilentSignal();

    const totalKnowledge = (db.prepare('SELECT COUNT(*) as cnt FROM debug_knowledge').get() as any)?.cnt || 0;
    const verifiedCount = (db.prepare('SELECT COUNT(*) as cnt FROM debug_knowledge WHERE verified = 1').get() as any)?.cnt || 0;
    const clawCount = (db.prepare('SELECT COUNT(*) as cnt FROM lobster_accounts').get() as any)?.cnt || 0;
    const topCategories = db.prepare(
      'SELECT error_category, COUNT(*) as cnt FROM debug_knowledge GROUP BY error_category ORDER BY cnt DESC LIMIT 5',
    ).all() as any[];

    // 望聞問切統計
    let diagnosisStats: any = {};
    try {
      const active = (db.prepare("SELECT COUNT(*) as cnt FROM debug_sessions WHERE status = 'active'").get() as any)?.cnt || 0;
      const diagnosed = (db.prepare("SELECT COUNT(*) as cnt FROM debug_sessions WHERE status = 'diagnosed'").get() as any)?.cnt || 0;
      const total = (db.prepare('SELECT COUNT(*) as cnt FROM debug_sessions').get() as any)?.cnt || 0;
      diagnosisStats = { active_sessions: active, diagnosed_total: diagnosed, total_sessions: total };
    } catch { /* debug_sessions 表尚未建立 */ }

    return c.json({
      service: 'Confucius Debug — YanHui KB (不貳過知識庫) 🦞🔧',
      description: 'Confucius Debug — never repeat a mistake. YanHui KB 越大，Confucius 越強。你的每一次 debug 都在幫所有人避坑。',
      version: '1.0.0',
      服務模式: '全部免費，社群共建 — 你的每一次 debug 都在幫所有人避坑',
      端點: {
        'POST /debug-ai': '提交 bug → 取得解法',
        'GET /debug-ai/knowledge': '瀏覽共享知識庫',
        'POST /debug-ai/search': '搜知識庫找相似坑',
        'POST /debug-ai/feedback': '回報 fix 是否有效（Dr. Claw 驗證飛輪）',
        'POST /debug-ai/contribute': '貢獻 debug 經驗',
        'GET /debug-ai/trending': '龍蝦最常問的 bug 排行',
        'POST /debug-ai/onboard': '入會掃描：批量匯入龍蝦本機 bug',
        'GET /debug-ai/account': '查詢龍蝦帳戶（解題數、貢獻數）',
        'GET /debug-ai/leaderboard': '排行榜：踩坑王 / 最強知識 / 不貳過大師',
        'POST /debug-ai/topup': '管理員：調整龍蝦貢獻額度（需 admin 密碼）',
      },
      知識庫: {
        總筆數: totalKnowledge,
        已驗證: verifiedCount,
        Claw數: clawCount,
        分類排行: topCategories,
      },
      驗證飛輪: {
        本次未回診偵測: silentSignals,
        說明: '24h 未回診 = 可能沒出問題，但不等於成功。獨立追蹤，不計入正式驗證。',
      },
      運行統計: debugStats,
      望聞問切: diagnosisStats,
      opus_relay: {
        online: isOpusRelayOnline(),
        說明: '孔夫子（Opus 4.6）在線時親自出手，品質最高',
      },
      mcp: {
        端點: '/mcp/debug',
        工具: ['debug_analyze', 'debug_search', 'debug_contribute', 'debug_hello', 'debug_feedback'],
      },
    });
  });

  // ── POST /debug-ai — 提交 bug → 三層瀑布解坑 ──
  router.post('/debug-ai', async (c) => {
    const startTime = Date.now();
    incrementStat('totalRequests');

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '請提供 JSON body: { error_description, error_message?, environment?, lobster_id? }' }, 400);
    }

    const errorDescription = body.error_description || body.error || body.description || '';
    const errorMessage = body.error_message || body.message || '';
    const environment = body.environment || {};
    const lobsterId = (body.lobster_id || body.agent_id || 'anonymous').toString().substring(0, 100);
    const channel = extractChannel(body, c.req.header() as any);

    if (!errorDescription && !body.session_id) {
      return c.json({ error: '缺少 error_description — 告訴我你遇到什麼問題' }, 400);
    }

    // ══════════════════════════════════════════════
    // Dr. Claw 望聞問切：多輪問診分支
    // ══════════════════════════════════════════════
    const sessionId = body.session_id as string | undefined;
    const answer = body.answer as string | undefined;

    // ── 分支 A：繼續問診（帶 session_id） ──
    if (sessionId) {
      try {
        const session = loadDiagnosisSession(sessionId);
        if (!session) {
          return c.json({
            error: 'Session 不存在或已過期',
            hint: '重新呼叫 debug_analyze（不帶 session_id）開始新問診',
          }, 404);
        }
        if (session.status !== 'active') {
          return c.json({
            error: `Session 狀態為 ${session.status}，無法繼續`,
            hint: session.status === 'diagnosed' ? '此 session 已診斷完畢' : '請開始新問診',
          }, 400);
        }
        if (!answer) {
          return c.json({
            error: '繼續問診需要提供 answer（回答上一輪問題）',
            session_id: sessionId,
            current_phase: session.phase,
            current_round: session.round,
          }, 400);
        }

        const result = await generateDiagnosticQuestion(session, answer);
        const elapsed = Date.now() - startTime;

        if (result.status === 'diagnosed') {
          // 問診完成 → 開藥
          incrementStat('totalRequests');
          const account = getOrCreateAccount(lobsterId);
          recordProblemSolved(lobsterId, 0);

          // 根據問診過程更新 debug_maturity
          const conversation: any[] = JSON.parse(session.conversation || '[]');
          const answeredRounds = conversation.filter(c => c.answer).length;
          // 龍蝦回答了幾輪就有幾級成熟度（最高 3）
          const maturityGain = Math.min(answeredRounds, 3);
          updateDebugMaturity(lobsterId, maturityGain);

          // 把分析結果存 KB（品質夠的話）
          const diagnosis = result.diagnosis;
          const confidence = Math.min(Math.max(diagnosis?.confidence || 0, 0), 1);
          const qualityScore = confidence * 0.8;
          if (qualityScore >= DRCLAW_QUALITY_THRESHOLD && diagnosis) {
            contributeDebugKnowledge({
              error_description: session.initial_description,
              error_message: JSON.parse(session.collected_info || '{}').error_message || '',
              error_category: diagnosis.category,
              root_cause: diagnosis.root_cause,
              fix_description: diagnosis.fix_description,
              fix_patch: diagnosis.fix_patch,
              environment: JSON.stringify(JSON.parse(session.collected_info || '{}').environment || {}),
              quality_score: qualityScore,
              contributed_by: 'drclaw_diagnosis',
              source: 'diagnosis_session',
            }).catch(() => {});
          }

          log.info(`望聞問切完成 🏥 lobster=${lobsterId}, session=${sessionId}, rounds=${session.round}, maturity→${maturityGain}, ${elapsed}ms`);

          return c.json({
            status: 'diagnosed',
            phase: '切',
            session_id: sessionId,
            round: result.round,
            message: 'Dr. Claw 已完成診斷，開藥！',
            result: result.diagnosis,
            lesson: result.lesson,
            debug_maturity: getDebugMaturity(lobsterId),
            yanhui: {
              attribution: '🏥 Dr. Claw 望聞問切完成！問診讓診斷更準確。',
              problems_solved: account.problems_solved + 1,
            },
            elapsed_ms: elapsed,
          });
        } else {
          // 還在問診中 → 回傳下一個問題
          log.info(`望聞問切進行中 🏥 lobster=${lobsterId}, session=${sessionId}, phase=${result.phase}, round=${result.round}`);

          return c.json({
            status: 'diagnosing',
            phase: result.phase,
            session_id: sessionId,
            round: result.round,
            question: result.question,
            action: result.action,
            message: `Dr. Claw 問診中（${result.phase}）— 回答此問題以繼續診斷`,
            hint: `帶 session_id="${sessionId}" 和 answer="你的回答" 繼續問診`,
            elapsed_ms: elapsed,
          });
        }
      } catch (err: any) {
        log.error(`望聞問切錯誤: ${err.message}`);
        return c.json({
          error: '問診過程出錯',
          hint: '重新呼叫 debug_analyze（不帶 session_id）開始新問診',
          // 安全：不洩漏內部錯誤訊息給客戶端
        }, 500);
      }
    }

    // ── 分支 B：新請求 → 評估品質，決定是否需要問診 ──
    const { score: qualityScore, missing } = scoreDescriptionQuality(errorDescription, errorMessage, environment);
    const maturity = getDebugMaturity(lobsterId);

    // v5.3: 批次客戶繞過問診（流水線送 skip_diagnosis=true 或 agent_type='kb-scraper'）
    const skipDiagnosis = body.skip_diagnosis === true
      || environment?.agent_type === 'kb-scraper'
      || environment?.agent_type === 'batch';

    // 高品質描述（≥75）或高成熟度龍蝦（level 3）或批次客戶 → 跳過問診
    if (qualityScore >= DIAGNOSIS_SKIP_THRESHOLD || maturity >= 3 || skipDiagnosis) {
      log.info(`望聞問切跳過: score=${qualityScore}, maturity=${maturity}, skip=${skipDiagnosis}, 直接走現有流程`);
      // 繼續走下面的現有流程
    } else {
      // 需要問診 → 建立 session，回傳第一個問題
      try {
        const session = createDiagnosisSession(lobsterId, errorDescription, qualityScore, environment);
        const result = await generateDiagnosticQuestion(session);
        const elapsed = Date.now() - startTime;

        log.info(`望聞問切啟動 🏥 lobster=${lobsterId}, session=${session.id}, score=${qualityScore}, missing=[${missing.join(',')}]`);

        return c.json({
          status: 'diagnosing',
          phase: result.phase,
          session_id: session.id,
          round: result.round,
          quality_score: qualityScore,
          missing_info: missing,
          question: result.question,
          action: result.action,
          message: `Dr. Claw 需要更多資訊才能精準診斷（描述完整度 ${qualityScore}/100）`,
          hint: `帶 session_id="${session.id}" 和 answer="你的回答" 繼續問診`,
          elapsed_ms: elapsed,
        });
      } catch (err: any) {
        // 問診建立失敗 → 降級走現有流程
        log.warn(`望聞問切建立失敗，降級走現有流程: ${err.message}`);
      }
    }

    // ══════════════════════════════════════════════
    // 現有流程（品質夠高 or 問診降級）
    // ══════════════════════════════════════════════

    const account = getOrCreateAccount(lobsterId);

    try {
      // ── Dr. Claw 隱性回報：同一龍蝦短時間內重複問類似問題 = 上次的 fix 沒用 ──
      try {
        const recentTx = getDb().prepare(
          `SELECT ref_id FROM lobster_transactions
           WHERE lobster_id = ? AND type IN ('analyze_kb_hit', 'analyze_kb_augmented')
           AND created_at > datetime('now', '-1 hour')
           ORDER BY created_at DESC LIMIT 1`
        ).get(lobsterId) as any;
        if (recentTx?.ref_id) {
          const prevEntryId = parseInt(recentTx.ref_id);
          if (prevEntryId > 0) {
            // 同一龍蝦 1 小時內又來問 → 上次的 fix 可能沒用（隱性失敗）
            const alreadyFeedback = getDb().prepare(
              'SELECT id FROM debug_feedback WHERE kb_entry_id = ? AND lobster_id = ?'
            ).get(prevEntryId, lobsterId) as any;
            if (!alreadyFeedback) {
              getDb().run(
                'INSERT OR IGNORE INTO debug_feedback (kb_entry_id, lobster_id, worked, notes) VALUES (?, ?, 0, ?)',
                [prevEntryId, lobsterId, 'implicit: lobster came back within 1hr'],
              );
              getDb().run(
                `UPDATE debug_knowledge SET verified_count = verified_count + 1, fail_count = fail_count + 1,
                 last_verified_at = ?, updated_at = ? WHERE id = ?`,
                [new Date().toISOString(), new Date().toISOString(), prevEntryId],
              );
              log.info(`Dr. Claw 隱性回報: KB#${prevEntryId} 可能無效（${lobsterId} 1hr 內又來問）`);
            }
          }
        }
      } catch { /* 隱性回報失敗不影響主流程 */ }

      // ── 第 1 層：知識庫搜尋 ──
      const searchQuery = `${errorDescription} ${errorMessage}`.trim();
      const kbHits = await searchKnowledge(searchQuery, 5);  // Drclaw: 多取幾筆

      if (kbHits.length > 0) {
        const qualityHits = kbHits.filter(h => h.quality_score >= DRCLAW_QUALITY_THRESHOLD);

        if (qualityHits.length > 0) {
          // ── Drclaw 醫生模式：KB + LLM 綜合 ──
          try {
            const augmented = await analyzeWithKBContext(errorDescription, errorMessage, environment, qualityHits);
            incrementStat('knowledgeHits');

            // 記錄使用（KB+LLM 綜合模式）
            const bestHit = qualityHits[0];
            debitAccount(lobsterId, PRICE_KB_AUGMENTED, 'analyze_kb_augmented',
              `Drclaw 綜合: ${errorDescription.substring(0, 60)}`, `drclaw_${bestHit.id}`);

            // 更新所有用到的 KB entries 的 hit_count
            const db = getDb();
            for (const hit of qualityHits.slice(0, DRCLAW_MAX_KB_ENTRIES)) {
              db.run('UPDATE debug_knowledge SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?',
                [new Date().toISOString(), hit.id]);
            }
            recordProblemSolved(lobsterId, 0);

            // ── 貢獻者回饋 ──
            let contributorRewarded = false;
            const contributor = bestHit.contributed_by;
            let contributorName = contributor;
            if (contributor && contributor !== lobsterId && contributor !== 'system' && contributor !== 'auto_collector') {
              const contributorAccount = db.prepare('SELECT display_name FROM lobster_accounts WHERE lobster_id = ?').get(contributor) as any;
              if (contributorAccount?.display_name) contributorName = contributorAccount.display_name;
              if (CONTRIBUTOR_REWARD > 0) {
                creditAccount(contributor, CONTRIBUTOR_REWARD, 'contributor_reward',
                  `你的知識幫到了 ${lobsterId}！KB #${bestHit.id} 被 Drclaw 引用`, `reward_${bestHit.id}_${Date.now()}`);
              }
              contributorRewarded = true;
              log.info(`💰 貢獻者回饋: ${contributorName}(${contributor}) +$${CONTRIBUTOR_REWARD} (Drclaw 引用 KB #${bestHit.id})`);
            }

            logSearchQuery(searchQuery, 'api', true, bestHit.id, environment);

            const elapsed = Date.now() - startTime;
            log.info(`Drclaw 醫生模式 🏥 lobster=${lobsterId}, kb_entries=${qualityHits.length}, validated=${augmented.validated_by_kb}, ${elapsed}ms`);

            return c.json({
              status: 'knowledge_augmented',
              message: 'Confucius 讀完 YanHui KB，為你的具體狀況量身調配解法。',
              source: augmented.validated_by_kb ? 'kb_validated' : 'kb_guided',
              yanhui: {
                attribution: contributorRewarded
                  ? `🦞 ${contributorName} 的經驗 + 顏回的腦袋 = 量身解法！感謝 ${contributorName} 的貢獻。`
                  : `🦞 YanHui KB 有 ${qualityHits.length} 筆相關經驗，顏回讀完後為你量身調配。`,
                problems_solved: account.problems_solved + 1,
              },
              result: {
                root_cause: augmented.root_cause,
                category: augmented.category,
                severity: augmented.severity,
                confidence: augmented.confidence,
                fix_description: augmented.fix_description,
                fix_steps: augmented.fix_steps,
                fix_patch: augmented.fix_patch,
                validated_by_kb: augmented.validated_by_kb,
                kb_entry_ids: augmented.kb_entry_ids,
              },
              verification: buildVerificationInfo(qualityHits[0]),
              next_step: {
                action: `After applying the fix, call debug_feedback(kb_entry_id=${qualityHits[0]?.id}, worked=true/false)`,
                reason: 'Your feedback trains Confucius — the more verified fixes, the better everyone gets helped.',
                command: `debug_feedback(kb_entry_id=${qualityHits[0]?.id}, worked=<true|false>)`,
              },
              similar_issues: qualityHits.slice(0, 3).map(h => ({
                id: h.id,
                error_description: h.error_description.substring(0, 100),
                category: h.error_category,
                quality_score: h.quality_score,
                verified: h.verified === 1,
                verified_count: h.verified_count || 0,
                success_rate: h.verified_count >= 1 ? parseFloat(((h.success_count || 0) / h.verified_count).toFixed(3)) : null,
              })),
              elapsed_ms: elapsed,
            });
          } catch (drclawErr: any) {
            // Drclaw 失敗 → 降級為舊的直接貼答案
            log.warn(`Drclaw 失敗，降級為 KB 直接回傳: ${drclawErr.message?.substring(0, 100)}`);
          }
        }

        // ── 降級路徑：低品質 KB 直接貼答案（舊行為）或 Drclaw 失敗 ──
        const bestHit = kbHits[0];
        incrementStat('knowledgeHits');

        debitAccount(lobsterId, PRICE_KB_HIT, 'analyze_kb_hit',
          `知識庫命中: ${errorDescription.substring(0, 60)}`, `kb_${bestHit.id}`);

        const db = getDb();
        db.run('UPDATE debug_knowledge SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?',
          [new Date().toISOString(), bestHit.id]);
        recordProblemSolved(lobsterId, REFUND_ON_HIT);

        let contributorRewarded = false;
        const contributor = bestHit.contributed_by;
        let contributorName = contributor;
        if (contributor && contributor !== lobsterId && contributor !== 'system' && contributor !== 'auto_collector') {
          const contributorAccount = db.prepare('SELECT display_name FROM lobster_accounts WHERE lobster_id = ?').get(contributor) as any;
          if (contributorAccount?.display_name) contributorName = contributorAccount.display_name;
          if (CONTRIBUTOR_REWARD > 0) {
            creditAccount(contributor, CONTRIBUTOR_REWARD, 'contributor_reward',
              `你的知識幫到了 ${lobsterId}！KB #${bestHit.id} 被命中`, `reward_${bestHit.id}_${Date.now()}`);
          }
          contributorRewarded = true;
        }

        logSearchQuery(searchQuery, 'api', true, bestHit.id, environment);
        const elapsed = Date.now() - startTime;

        return c.json({
          status: 'knowledge_hit',
          message: '不貳過！這個坑有人踩過了，Confucius 記得怎麼解。',
          source: 'knowledge_base',
          yanhui: {
            attribution: contributorRewarded
              ? `🦞 這個解法由 ${contributorName} 貢獻！YanHui KB 越大，大家都受益。`
              : '🦞 Confucius 從 YanHui KB 中找到了解法 — never repeat a mistake!',
            problems_solved: account.problems_solved + 1,
          },
          result: {
            root_cause: bestHit.root_cause,
            category: bestHit.error_category,
            fix_description: bestHit.fix_description,
            fix_patch: bestHit.fix_patch,
            quality_score: bestHit.quality_score,
            verified: bestHit.verified === 1,
            hit_count: bestHit.hit_count + 1,
            contributed_by: bestHit.contributed_by,
          },
          verification: buildVerificationInfo(bestHit),
          next_step: {
            action: `After applying the fix, call debug_feedback(kb_entry_id=${bestHit.id}, worked=true/false)`,
            reason: 'Your feedback trains Confucius — the more verified fixes, the better everyone gets helped.',
            command: `debug_feedback(kb_entry_id=${bestHit.id}, worked=<true|false>)`,
          },
          similar_issues: kbHits.length > 1
            ? kbHits.slice(1).map(h => ({
                id: h.id,
                error_description: h.error_description.substring(0, 100),
                category: h.error_category,
              }))
            : [],
          elapsed_ms: elapsed,
        });
      }

      // 記錄搜尋（未命中）
      logSearchQuery(searchQuery, 'api', false, undefined, environment);

      // ── 第 2 層：本機 Opus Relay ──
      const opusResult = await tryOpusRelay(errorDescription, errorMessage, environment);

      if (opusResult) {
        // 🛡️ Opus 也可能判定不是 debug → 不記錄
        if (opusResult.category === 'not_a_bug') {
          const elapsed = Date.now() - startTime;
          log.warn(`非 debug 問題被 Opus 擋 🛡️ lobster=${lobsterId}`);
          return c.json({
            status: 'rejected',
            message: 'Confucius Debug 只幫忙 debug。這不是一個錯誤或 bug。',
            yanhui: { attribution: '🦞 Confucius Debug 專攻「不貳過」—— 只處理 debug 問題。' },
            elapsed_ms: elapsed,
          });
        }
        // Opus 成功！記錄 + 存入知識庫
        incrementStat('opusAnalyses');
        debitAccount(lobsterId, PRICE_ANALYZE, 'analyze_opus',
          `Opus 分析: ${errorDescription.substring(0, 60)}`);

        const confidence = Math.min(Math.max(opusResult.confidence || 0, 0), 1);
        const severity = Math.min(Math.max(opusResult.severity || 3, 1), 5);
        recordProblemSolved(lobsterId, 0);

        // Opus 品質更高 → quality_score = 0.95
        contributeDebugKnowledge({
          error_description: errorDescription,
          error_message: errorMessage,
          error_category: opusResult.category,
          root_cause: opusResult.root_cause,
          fix_description: opusResult.fix_description,
          fix_patch: opusResult.fix_patch,
          environment: JSON.stringify(environment),
          quality_score: 0.95,
          contributed_by: 'opus_local',
          source: 'debug_request',
        }).catch(() => {});

        const elapsed = Date.now() - startTime;
        log.info(`Opus 分析完成 🧠 lobster=${lobsterId}, severity=${opusResult.severity}, ${elapsed}ms`);

        return c.json({
          status: 'analyzed',
          message: '孔夫子（Opus 4.6）親自出手，品質最高！',
          source: 'opus_local',
          yanhui: {
            attribution: '🧠 孔夫子（Opus 4.6）親自出手！解法已存入 YanHui KB，Confucius 又變強了。',
            problems_solved: account.problems_solved + 1,
          },
          result: {
            root_cause: opusResult.root_cause,
            category: opusResult.category,
            severity,
            confidence,
            fix_description: opusResult.fix_description,
            fix_steps: opusResult.fix_steps,
            fix_patch: opusResult.fix_patch,
          },
          next_step: {
            action: 'After applying the fix, call debug_contribute with the outcome to strengthen the KB.',
            reason: 'Opus just created a fresh diagnosis. Your confirmation makes it a verified cure.',
          },
          elapsed_ms: elapsed,
        });
      }

      // ── 第 3 層：Sonnet 4.6 + Prompt Caching ──
      const analysis = await analyzeWithSonnet(errorDescription, errorMessage, environment);
      incrementStat('sonnetAnalyses');

      // 🛡️ 防濫用：Sonnet 判定不是 debug 問題 → 不存知識庫
      if (analysis.category === 'not_a_bug') {
        const elapsed = Date.now() - startTime;
        log.warn(`非 debug 問題被擋 🛡️ lobster=${lobsterId}: ${errorDescription.substring(0, 60)}`);
        return c.json({
          status: 'rejected',
          message: 'Confucius Debug 只幫忙 debug。這不是一個錯誤或 bug，請描述一個實際的技術問題。',
          yanhui: {
            attribution: '🦞 Confucius Debug 專攻「不貳過」—— 只處理 debug 問題。',
            problems_solved: account.problems_solved,
          },
          hint: '請描述你遇到的錯誤訊息、stack trace、或具體的技術問題。',
          elapsed_ms: elapsed,
        });
      }

      // clamp AI 回傳值（防幻覺）
      const confidence = Math.min(Math.max(analysis.confidence || 0, 0), 1);
      const severity = Math.min(Math.max(analysis.severity || 3, 1), 5);

      // 🆕 A+D: 低信心 → 誠實說不會，存入 unsolved 佇列
      if (confidence < CONFIDENCE_THRESHOLD) {
        // 記錄使用（低信心分析）
        debitAccount(lobsterId, PRICE_ANALYZE, 'analyze_sonnet_low_confidence',
          `Sonnet 低信心分析: ${errorDescription.substring(0, 60)}`);

        // 存入 unsolved 佇列
        try {
          const db = getDb();
          db.run(
            `INSERT INTO unsolved_queue (error_description, error_message, lobster_id, environment, original_confidence, original_analysis)
             VALUES (?, ?, ?, ?, ?, ?)`,
            errorDescription,
            errorMessage,
            lobsterId,
            JSON.stringify(environment),
            confidence,
            JSON.stringify(analysis),
          );
          log.info(`📋 低信心問題存入 unsolved 佇列: lobster=${lobsterId}, confidence=${confidence}`);
        } catch (dbErr: any) {
          log.warn(`📋 unsolved 佇列寫入失敗: ${dbErr.message}`);
        }

        const elapsed = Date.now() - startTime;
        return c.json({
          status: 'unsolved',
          message: '這個問題目前沒有人遇過，我們會帶回去研究。請提供更多環境資訊幫助我們診斷（使用 debug_escalate）。',
          source: 'sonnet_4.6',
          yanhui: {
            attribution: '🦞 孔子誠實說：這題我沒把握。已收件，我們會研究後補進 KB。',
            problems_solved: account.problems_solved,
          },
          result: {
            root_cause: analysis.root_cause,
            category: analysis.category,
            severity,
            confidence,
            fix_description: analysis.fix_description,
            fix_steps: analysis.fix_steps,
            fix_patch: analysis.fix_patch,
            note: '⚠️ 以上分析信心分偏低，建議使用 debug_escalate 提供更多環境資訊，我們會重新分析。',
          },
          next_step: {
            tool: 'debug_escalate',
            description: '請提供環境快照、logs、已嘗試的方法，幫助我們更準確地診斷。',
          },
          elapsed_ms: elapsed,
        });
      }

      // 正常路徑：記錄使用
      debitAccount(lobsterId, PRICE_ANALYZE, 'analyze_sonnet',
        `Sonnet 分析: ${errorDescription.substring(0, 60)}`);

      // 記錄解決問題
      recordProblemSolved(lobsterId, 0);

      // Drclaw 入口把關：品質夠才存 KB
      const qualityScore2 = confidence * 0.8;
      if (qualityScore2 >= DRCLAW_QUALITY_THRESHOLD) {
        contributeDebugKnowledge({
          error_description: errorDescription,
          error_message: errorMessage,
          error_category: analysis.category,
          root_cause: analysis.root_cause,
          fix_description: analysis.fix_description,
          fix_patch: analysis.fix_patch,
          environment: JSON.stringify(environment),
          quality_score: qualityScore2,
          contributed_by: 'sonnet_4.6',
          source: 'debug_request',
        }).catch(() => {});
      } else {
        log.info(`Drclaw 入口把關：品質 ${qualityScore2.toFixed(2)} < ${DRCLAW_QUALITY_THRESHOLD}，不存 KB`);
      }

      const elapsed = Date.now() - startTime;
      log.info(`Sonnet 分析完成 🤖 lobster=${lobsterId}, severity=${analysis.severity}, ${elapsed}ms`);

      return c.json({
        status: 'analyzed',
        message: '顏回（Sonnet 4.6）已分析你的問題，解法存入 YanHui KB。',
        source: 'sonnet_4.6',
        yanhui: {
          attribution: '🦞 顏回（Sonnet 4.6）解完了！解法已存入 YanHui KB，下次誰問都秒解。',
          problems_solved: account.problems_solved + 1,
        },
        result: {
          root_cause: analysis.root_cause,
          category: analysis.category,
          severity,
          confidence,
          fix_description: analysis.fix_description,
          fix_steps: analysis.fix_steps,
          fix_patch: analysis.fix_patch,
        },
        next_step: {
          action: 'After applying the fix, call debug_contribute with the outcome to strengthen the KB.',
          reason: 'Sonnet just diagnosed this. Your confirmation makes it a verified cure.',
        },
        elapsed_ms: elapsed,
      });
    } catch (err: any) {
      log.error(`Confucius Debug 分析失敗: ${err.message}`);
      return c.json({
        error: '分析失敗，請稍後重試',
        hint: '可能是 Anthropic API 暫時不可用，請稍後重試',
      }, 500);
    }
  });
}
