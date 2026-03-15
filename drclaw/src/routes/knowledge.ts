/**
 * Debug 知識庫路由
 *
 * GET  /debug-ai/knowledge   — 瀏覽知識庫
 * POST /debug-ai/search      — 搜尋知識庫（免費）
 * GET  /debug-ai/trending     — 熱門問題排行
 * POST /debug-ai/feedback     — 驗證飛輪回報
 * POST /debug-ai/contribute   — 貢獻 debug 經驗
 */

import type { Hono } from 'hono';
import { createLogger } from '../logger';
import { getDb } from '../database';
import { CONTRIBUTE_REWARD, buildVerificationInfo } from '../core/constants';
import { incrementStat } from '../core/stats';
import { logSearchQuery } from '../core/search-log';
import { searchKnowledge, contributeDebugKnowledge } from '../core/kb-store';
import { extractChannel } from '../core/auto-collector';
import { creditAccount } from '../core/lobster-account';

const log = createLogger('DebugRoutes:Knowledge');

export function registerKnowledgeRoutes(router: Hono): void {

  // ── GET /debug-ai/knowledge — 瀏覽知識庫 ──
  router.get('/debug-ai/knowledge', (c) => {
    const db = getDb();
    const page = Math.max(1, parseInt(c.req.query('page') || '1') || 1);
    const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20') || 20), 50);
    const category = c.req.query('category');
    const verified = c.req.query('verified');
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const params: any[] = [];

    if (category) {
      whereClause += ' AND error_category = ?';
      params.push(category);
    }
    if (verified === '1' || verified === 'true') {
      whereClause += ' AND verified = 1';
    }

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM debug_knowledge WHERE ${whereClause}`).get(...params) as any)?.cnt || 0;
    const rows = db.prepare(
      `SELECT id, error_description, error_category, root_cause, fix_description, quality_score, verified, hit_count, contributed_by, source, created_at
       FROM debug_knowledge WHERE ${whereClause}
       ORDER BY hit_count DESC, quality_score DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as any[];

    return c.json({
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      entries: rows.map(r => ({
        ...r,
        error_description: r.error_description.substring(0, 200),
        verified: r.verified === 1,
      })),
    });
  });

  // ── POST /debug-ai/search — 搜知識庫（免費） ──
  router.post('/debug-ai/search', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '請提供 JSON body: { query }' }, 400);
    }

    const query = body.query || body.error || '';
    if (!query) {
      return c.json({ error: '缺少 query — 告訴我你想搜什麼' }, 400);
    }

    incrementStat('searches');
    const limit = Math.min(body.limit || 5, 10);
    const hits = await searchKnowledge(query, limit);

    // 記錄搜尋紀錄（含通路追蹤）
    const channel = extractChannel(body, c.req.header() as any);
    logSearchQuery(query, 'search', hits.length > 0, hits[0]?.id, undefined, channel);

    // 偵測是否已 onboard（有傳 lobster_id 才檢查）
    const lobsterId = body.lobster_id || body.agent_id;
    let onboardHint: string | undefined;
    if (lobsterId) {
      const db = getDb();
      const account = db.prepare('SELECT onboarded FROM lobster_accounts WHERE lobster_id = ?').get(lobsterId) as any;
      if (!account || !account.onboarded) {
        onboardHint = '🚀 你還沒跑過 debug_hello！先跑一次，Confucius 會掃你電腦上的歷史 bug，幫你建 YanHui KB。YanHui KB 越大，Confucius 越強！';
      }
    } else {
      // 沒帶 lobster_id → 可能是新手，輕提醒
      onboardHint = '💡 首次使用？跑 debug_hello 建立你的 YanHui KB！';
    }

    // v5.1: 0-hit 保護 — 明確告知 AI 這不是孔子的答案
    const noHitWarning = hits.length === 0
      ? '⚠️ Confucius KB has NO record of this problem. If you (the AI agent) provide a fix below, it is YOUR speculation — NOT a Confucius-verified answer. Please: (1) clearly tell the user this is unverified, (2) suggest backing up before applying, (3) avoid guessing config keys or file paths that you are not certain exist.'
      : undefined;

    // v5.2: 重複搜尋偵測
    let regressionHint: string | undefined;
    if (hits.length === 0) {
      const db2 = getDb();
      const recentSearches = db2.prepare(
        `SELECT query FROM debug_search_log
         WHERE created_at > datetime('now', '-1 hour')
           AND source = 'search'
         ORDER BY created_at DESC LIMIT 10`
      ).all() as any[];

      if (recentSearches.length >= 2) {
        regressionHint = '🔄 It looks like you searched multiple times recently without finding a solution. If a previous Confucius answer caused a NEW problem, please use debug_report_issue to let us know \u2014 we will fix the KB entry and help you directly.';
      }
    }

    return c.json({
      status: 'ok',
      results: hits.map(h => ({
        id: h.id,
        error_description: h.error_description,
        error_category: h.error_category,
        root_cause: h.root_cause,
        fix_description: h.fix_description,
        fix_patch: h.fix_patch,
        quality_score: h.quality_score,
        verified: h.verified === 1,
        hit_count: h.hit_count,
        contributed_by: h.contributed_by,
        verified_count: h.verified_count || 0,
        success_rate: (h.verified_count || 0) >= 1 ? parseFloat(((h.success_count || 0) / h.verified_count).toFixed(3)) : null,
        verification_status: buildVerificationInfo(h).status,
      })),
      total_found: hits.length,
      ...(noHitWarning ? { warning: noHitWarning } : {}),
      ...(onboardHint ? { hint: onboardHint } : {}),
      ...(regressionHint ? { regression_hint: regressionHint } : {}),
    });
  });

  // ── GET /debug-ai/trending — 龍蝦最常問的 bug（搜尋紀錄排行） ──
  router.get('/debug-ai/trending', (c) => {
    const db = getDb();
    const days = Math.min(Math.max(parseInt(c.req.query('days') || '7') || 7, 1), 90);
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20') || 20, 1), 50);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const topQueries = db.prepare(`
      SELECT query, COUNT(*) as ask_count,
             SUM(hit) as hit_count,
             ROUND(100.0 * SUM(hit) / COUNT(*), 1) as hit_rate_pct,
             MAX(created_at) as last_asked
      FROM debug_search_log
      WHERE created_at > ?
      GROUP BY query
      ORDER BY ask_count DESC
      LIMIT ?
    `).all(since, limit) as any[];

    const gaps = db.prepare(`
      SELECT query, COUNT(*) as ask_count, MAX(created_at) as last_asked
      FROM debug_search_log
      WHERE created_at > ? AND hit = 0
      GROUP BY query
      ORDER BY ask_count DESC
      LIMIT 10
    `).all(since) as any[];

    const totalSearches = (db.prepare(
      'SELECT COUNT(*) as cnt FROM debug_search_log WHERE created_at > ?',
    ).get(since) as any)?.cnt || 0;

    const hitRate = totalSearches > 0
      ? ((db.prepare(
          'SELECT COUNT(*) as cnt FROM debug_search_log WHERE created_at > ? AND hit = 1',
        ).get(since) as any)?.cnt || 0) / totalSearches * 100
      : 0;

    return c.json({
      期間: `最近 ${days} 天`,
      總搜尋次數: totalSearches,
      整體命中率: `${hitRate.toFixed(1)}%`,
      熱門問題: topQueries,
      知識缺口: gaps,
      說明: '知識缺口 = 最常被問但知識庫沒答案的 → 優先補這些！',
    });
  });

  // ── POST /debug-ai/feedback — Dr. Claw 驗證飛輪（免費） ──
  router.post('/debug-ai/feedback', async (c) => {
    try {
      const body = await c.req.json();
      const kbEntryId = parseInt(body.kb_entry_id);
      const worked = !!body.worked;
      const lobsterId = (body.lobster_id || 'anonymous').toString().substring(0, 100);
      const notes = (body.notes || '').toString().substring(0, 500);
      const environment = body.environment ? JSON.stringify(body.environment).substring(0, 1000) : '{}';

      if (!kbEntryId || isNaN(kbEntryId)) {
        return c.json({ error: 'kb_entry_id 必填（數字）' }, 400);
      }

      const db = getDb();

      // 確認 KB 條目存在
      const entry = db.prepare('SELECT id, error_description, verified_count, success_count, fail_count FROM debug_knowledge WHERE id = ?').get(kbEntryId) as any;
      if (!entry) {
        return c.json({ error: `KB entry #${kbEntryId} 不存在` }, 404);
      }

      // 防重複：同一 lobster + 同一 entry 只能回報一次
      const existing = db.prepare('SELECT id FROM debug_feedback WHERE kb_entry_id = ? AND lobster_id = ?').get(kbEntryId, lobsterId) as any;
      if (existing) {
        return c.json({
          status: 'already_reported',
          message: '你已經回報過這筆了，感謝！',
          success_rate: entry.verified_count > 0 ? entry.success_count / entry.verified_count : null,
        });
      }

      // 寫入 feedback + 更新 KB 統計（原子操作）
      db.transaction(() => {
        db.run(
          'INSERT INTO debug_feedback (kb_entry_id, lobster_id, worked, notes, environment) VALUES (?, ?, ?, ?, ?)',
          [kbEntryId, lobsterId, worked ? 1 : 0, notes, environment],
        );
        db.run(
          `UPDATE debug_knowledge SET
            verified_count = verified_count + 1,
            ${worked ? 'success_count = success_count + 1' : 'fail_count = fail_count + 1'},
            last_verified_at = ?,
            updated_at = ?
          WHERE id = ?`,
          [new Date().toISOString(), new Date().toISOString(), kbEntryId],
        );
      })();

      // 讀取更新後的數據
      const updated = db.prepare('SELECT verified_count, success_count, fail_count FROM debug_knowledge WHERE id = ?').get(kbEntryId) as any;
      const successRate = updated.verified_count > 0 ? updated.success_count / updated.verified_count : 0;

      log.info(`Dr. Claw feedback: KB#${kbEntryId} ${worked ? '✅' : '❌'} by ${lobsterId} → rate=${successRate.toFixed(2)} (${updated.verified_count} reports)`);

      return c.json({
        status: 'feedback_recorded',
        message: worked
          ? `感謝回報！這個 fix 現在有 ${updated.success_count}/${updated.verified_count} 人驗證成功 ✅`
          : `感謝回報！已記錄。Dr. Claw 會參考這個結果改善未來的建議。`,
        kb_entry_id: kbEntryId,
        verification: {
          verified_count: updated.verified_count,
          success_count: updated.success_count,
          fail_count: updated.fail_count,
          success_rate: parseFloat(successRate.toFixed(3)),
        },
      });
    } catch (err: any) {
      log.error(`Feedback error: ${err.message}`);
      return c.json({ error: '回報失敗，請稍後再試' }, 500);
    }
  });

  // ── POST /debug-ai/contribute — 貢獻 debug 經驗（免費） ──
  router.post('/debug-ai/contribute', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '請提供 JSON body: { error_description, root_cause?, fix_description?, ... }' }, 400);
    }

    const errorDescription = body.error_description || body.error || '';
    if (!errorDescription) {
      return c.json({ error: '缺少 error_description' }, 400);
    }

    // 安全：外部貢獻不信任 verified/quality_score/source（防知識庫投毒）
    const envStr = body.environment ? JSON.stringify(body.environment) : '{}';
    if (envStr.length > 4096) {
      return c.json({ error: 'environment 太大（上限 4096 字元）' }, 400);
    }

    const rowId = await contributeDebugKnowledge({
      error_description: errorDescription,
      error_message: body.error_message || '',
      error_category: body.error_category || body.category || 'general',
      root_cause: body.root_cause || '',
      fix_description: body.fix_description || body.fix || '',
      fix_patch: body.fix_patch || body.patch || '',
      environment: envStr,
      quality_score: Math.min(Math.max(Number(body.quality_score) || 0.5, 0), 0.8), // 外部上限 0.8
      verified: 0,                                              // 外部永遠未驗證
      contributed_by: (body.contributed_by || 'community').substring(0, 50),
      source: 'contribution',                                   // 強制覆蓋
    });

    // 貢獻者獎勵
    const contributedBy = (body.contributed_by || 'community').substring(0, 50);
    let rewardMsg = '';
    if (contributedBy !== 'community' && contributedBy !== 'system' && contributedBy !== 'auto_collector') {
      if (CONTRIBUTE_REWARD > 0) {
        creditAccount(contributedBy, CONTRIBUTE_REWARD, 'contribute_reward',
          `貢獻知識 KB #${rowId}`, `contribute_${rowId}`);
      }
      rewardMsg = ' 感謝你的貢獻！';
      log.info(`🎯 新貢獻: ${contributedBy} (KB #${rowId})`);
    }

    return c.json({
      status: 'ok',
      message: `感謝貢獻！已存入 YanHui KB，Confucius 又變強了 🦞${rewardMsg}`,
      entry_id: rowId,
    });
  });
}
