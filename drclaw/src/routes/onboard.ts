/**
 * Debug 入會 + 帳戶路由
 *
 * POST /debug-ai/onboard     — 入會掃描（批量匯入）
 * GET  /debug-ai/account     — 龍蝦帳戶查詢
 * GET  /debug-ai/leaderboard — 排行榜
 */

import type { Hono } from 'hono';
import { createLogger } from '../logger';
import { getDb } from '../database';
import type { FilteredEntry } from '../core/types';
import { filterEntriesWithAI } from '../core/quality-scorer';
import { contributeDebugKnowledge } from '../core/kb-store';
import { getOrCreateAccount, creditAccount } from '../core/lobster-account';
import { extractChannel } from '../core/auto-collector';

const log = createLogger('DebugRoutes:Onboard');

export function registerOnboardRoutes(router: Hono): void {

  // ── POST /debug-ai/onboard — 入會掃描：批量匯入龍蝦本機 bug ──
  router.post('/debug-ai/onboard', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '請提供 JSON body: { lobster_id, entries: [...] }' }, 400);
    }

    const lobsterId = (body.lobster_id || body.agent_id || 'anonymous').toString().substring(0, 100);
    const displayName = (body.display_name || '').toString().substring(0, 30);
    const channel = extractChannel(body, c.req.header() as any);
    const entries = body.entries;

    if (!Array.isArray(entries) || entries.length === 0) {
      return c.json({ error: '缺少 entries 陣列 — 需要至少一筆 bug 資料' }, 400);
    }

    // 安全上限：一次最多 200 筆（防灌爆）
    if (entries.length > 200) {
      return c.json({ error: `一次最多 200 筆（你送了 ${entries.length} 筆）` }, 400);
    }

    // 檢查是否已經 onboard 過（防重複領取積分）
    const db = getDb();
    const existingOnboard = db.prepare(
      `SELECT COUNT(*) as cnt FROM debug_knowledge WHERE contributed_by = ? AND source = 'onboard'`,
    ).get(lobsterId) as any;

    const isFirstOnboard = (existingOnboard?.cnt || 0) === 0;

    // ── Step 1：預處理 entries（清理 + 基本過濾） ──
    const cleanedEntries: Array<{
      index: number;
      error_description: string;
      error_message: string;
      error_category: string;
      root_cause: string;
      fix_description: string;
      fix_patch: string;
      environment: string;
    }> = [];
    let basicSkipped = 0;
    let duplicateSkipped = 0;
    let qualitySkipped = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') { basicSkipped++; continue; }

      const errorDesc = (entry.error_description || entry.error || entry.description || '').toString().substring(0, 1000);
      if (!errorDesc || errorDesc.length < 10) { basicSkipped++; continue; }

      // 去重：跟現有知識庫比
      const existing = db.prepare(
        'SELECT id FROM debug_knowledge WHERE error_description = ? LIMIT 1',
      ).get(errorDesc);
      if (existing) { duplicateSkipped++; continue; }

      // 品質門檻：沒有 root_cause 且沒有 fix_description 的空殼不入庫
      const rootCause = (entry.root_cause || '').toString().trim();
      const fixDesc = (entry.fix_description || entry.fix || '').toString().trim();
      if (!rootCause && !fixDesc) { qualitySkipped++; continue; }

      cleanedEntries.push({
        index: i,
        error_description: errorDesc,
        error_message: (entry.error_message || entry.message || '').toString().substring(0, 500),
        error_category: (entry.error_category || entry.category || 'general').toString().substring(0, 30),
        root_cause: (entry.root_cause || '').toString().substring(0, 500),
        fix_description: (entry.fix_description || entry.fix || '').toString().substring(0, 500),
        fix_patch: (entry.fix_patch || entry.patch || '').toString().substring(0, 1000),
        environment: entry.environment ? JSON.stringify(entry.environment).substring(0, 2048) : '{}',
      });
    }

    // ── Step 2：AI 品質把關（整批送出，一批回來） ──
    let imported = 0;
    let aiRejected = 0;
    let sensitiveBlocked = 0;
    let failed = 0;

    if (cleanedEntries.length > 0) {
      log.info(`Onboard 品質把關: ${cleanedEntries.length} 筆待辨識 (已跳過 basic=${basicSkipped}, duplicate=${duplicateSkipped}, quality=${qualitySkipped})`);

      const aiResults = await filterEntriesWithAI(cleanedEntries);

      // ── Step 3：根據 AI 辨識結果存入知識庫（並行 batch，5 筆一組） ──
      const toStore: Array<{ entry: typeof cleanedEntries[0]; aiResult: FilteredEntry }> = [];
      for (let j = 0; j < cleanedEntries.length; j++) {
        const entry = cleanedEntries[j];
        const aiResult = aiResults.find(r => r.index === j) || aiResults[j]; // 容錯

        // AI 說不是 bug → 跳過
        if (aiResult && !aiResult.is_real_bug) {
          aiRejected++;
          continue;
        }

        // AI 發現敏感資料 → 絕對不存
        if (aiResult?.has_sensitive_data) {
          sensitiveBlocked++;
          continue;
        }

        toStore.push({ entry, aiResult });
      }

      // 並行 batch 存入（5 筆一組，避免壓垮 Voyage AI）
      const BATCH_SIZE = 5;
      for (let b = 0; b < toStore.length; b += BATCH_SIZE) {
        const batch = toStore.slice(b, b + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(({ entry, aiResult }) =>
            contributeDebugKnowledge({
              error_description: entry.error_description,
              error_message: entry.error_message,
              error_category: aiResult?.category || entry.error_category,
              root_cause: entry.root_cause,
              fix_description: entry.fix_description,
              fix_patch: entry.fix_patch,
              environment: entry.environment,
              quality_score: aiResult?.quality_score || 0.3,
              verified: 0,
              contributed_by: lobsterId,
              source: 'onboard',
            }),
          ),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') imported++;
          else failed++;
        }
      }
    }

    // 存暱稱（有填就更新）
    if (displayName) {
      const db2 = getDb();
      db2.run('UPDATE lobster_accounts SET display_name = ? WHERE lobster_id = ?', [displayName, lobsterId]);
    }

    // 計算首次入會獎勵（內部記錄用）
    const creditsEarned = isFirstOnboard && imported >= 3 ? 10.0 : 0;
    let newBalance = 0;
    if (creditsEarned > 0) {
      newBalance = creditAccount(lobsterId, creditsEarned, 'onboard_bonus',
        `入會掃描獎勵：匯入 ${imported} 筆 debug 經驗`);
      const db2 = getDb();
      db2.run('UPDATE lobster_accounts SET onboarded = 1, problems_contributed = problems_contributed + ? WHERE lobster_id = ?',
        [imported, lobsterId]);
    } else if (imported > 0) {
      // 沒拿到獎勵但有貢獻 → 更新貢獻數
      const account = getOrCreateAccount(lobsterId);
      newBalance = account.balance;
      const db2 = getDb();
      db2.run('UPDATE lobster_accounts SET problems_contributed = problems_contributed + ? WHERE lobster_id = ?',
        [imported, lobsterId]);
    }

    log.info(`入會掃描: lobster=${lobsterId}, imported=${imported}, ai_rejected=${aiRejected}, sensitive=${sensitiveBlocked}, duplicate=${duplicateSkipped}, basic_skip=${basicSkipped}, quality_skip=${qualitySkipped}, failed=${failed}, credits=${creditsEarned}`);

    return c.json({
      status: 'ok',
      message: imported > 0
        ? `YanHui KB 已建立！匯入 ${imported} 筆 debug 經驗，Confucius 又變強了 🦞`
          + (qualitySkipped > 0 ? ` (另有 ${qualitySkipped} 筆因缺少 root_cause/fix_description 被跳過)` : '')
        : qualitySkipped > 0
          ? `${qualitySkipped} 筆 bug 因缺少 root_cause 和 fix_description 被跳過。請用 git show <hash> 看 diff，提取修法後再試。`
          : '沒有新的 bug 可以匯入（可能全部已在 YanHui KB 裡了）',
      lobster_id: lobsterId,
      first_onboard: isFirstOnboard,
      imported,
      filtered: {
        ai_rejected: aiRejected,
        sensitive_blocked: sensitiveBlocked,
        duplicate_skipped: duplicateSkipped,
        basic_skipped: basicSkipped,
        quality_skipped: qualitySkipped,
        failed,
      },
      total_submitted: entries.length,
      yanhui: {
        attribution: creditsEarned > 0
          ? '🦞 YanHui KB 已為你建立！首次入會貢獻獎勵已記錄。Confucius Debug — never repeat a mistake.'
          : imported > 0
            ? '🦞 YanHui KB 已更新！Confucius Debug — never repeat a mistake.'
            : undefined,
        problems_contributed: imported,
      },
      privacy_note: sensitiveBlocked > 0
        ? `🔒 Confucius 偵測到 ${sensitiveBlocked} 筆含敏感資料的條目，已自動攔截不存入`
        : undefined,
      tip: 'YanHui KB 越大，Confucius 越強。你的每次 debug 都在幫所有人避坑！',
    });
  });

  // ── GET /debug-ai/account — 龍蝦帳戶查詢 ──
  router.get('/debug-ai/account', (c) => {
    const lobsterId = c.req.query('lobster_id') || c.req.query('id') || '';
    if (!lobsterId) {
      return c.json({ error: '請提供 ?lobster_id=xxx' }, 400);
    }

    const account = getOrCreateAccount(lobsterId);
    const db = getDb();

    // 最近 10 筆交易
    const transactions = db.prepare(
      'SELECT type, amount, balance_after, description, created_at FROM lobster_transactions WHERE lobster_id = ? ORDER BY created_at DESC LIMIT 10',
    ).all(lobsterId) as any[];

    // 貢獻統計
    const rewardStats = db.prepare(
      `SELECT COUNT(*) as reward_count, COALESCE(SUM(amount), 0) as total_rewards
       FROM lobster_transactions WHERE lobster_id = ? AND type = 'contributor_reward'`,
    ).get(lobsterId) as any;

    // 我貢獻的知識庫條目
    const myContributions = db.prepare(
      `SELECT id, error_description, error_category, hit_count, quality_score, created_at
       FROM debug_knowledge WHERE contributed_by = ? ORDER BY hit_count DESC LIMIT 10`,
    ).all(lobsterId) as any[];

    return c.json({
      lobster_id: account.lobster_id,
      display_name: account.display_name || '',
      problems_solved: account.problems_solved,
      problems_contributed: account.problems_contributed,
      onboarded: account.onboarded === 1,
      created_at: account.created_at,
      contributor: {
        times_helped: rewardStats?.reward_count || 0,
        top_contributions: myContributions.map((c: any) => ({
          id: c.id,
          error: c.error_description?.substring(0, 80),
          category: c.error_category,
          hit_count: c.hit_count,
          quality: c.quality_score,
        })),
      },
      yanhui: {
        report: `🦞 Confucius 已為你解決 ${account.problems_solved} 個問題`,
        contributor_report: rewardStats?.reward_count > 0
          ? `🎯 你的知識幫到了 ${rewardStats.reward_count} 人！`
          : '📝 貢獻更多 debug 經驗，別人踩坑時你的經驗就是他們的解藥！',
      },
    });
  });

  // ── GET /debug-ai/leaderboard — 排行榜（三種榜） ──
  router.get('/debug-ai/leaderboard', (c) => {
    const db = getDb();
    const limit = Math.min(Number(c.req.query('limit')) || 10, 50);

    // 踩坑王：貢獻最多 bug 的人
    const topContributors = db.prepare(`
      SELECT contributed_by as id,
        COALESCE((SELECT display_name FROM lobster_accounts WHERE lobster_id = contributed_by), '') as name,
        COUNT(*) as contributions,
        COALESCE(SUM(hit_count), 0) as total_hits
      FROM debug_knowledge
      WHERE contributed_by NOT IN ('system', 'auto_collector', 'sonnet_4.6', 'opus_local', 'git_history_miner')
      GROUP BY contributed_by
      ORDER BY contributions DESC
      LIMIT ?
    `).all(limit) as any[];

    // 最強知識：被命中最多次的貢獻者
    const topHelpful = db.prepare(`
      SELECT contributed_by as id,
        COALESCE((SELECT display_name FROM lobster_accounts WHERE lobster_id = contributed_by), '') as name,
        COALESCE(SUM(hit_count), 0) as total_hits,
        COUNT(*) as contributions
      FROM debug_knowledge
      WHERE contributed_by NOT IN ('system', 'auto_collector', 'sonnet_4.6', 'opus_local', 'git_history_miner')
        AND hit_count > 0
      GROUP BY contributed_by
      ORDER BY total_hits DESC
      LIMIT ?
    `).all(limit) as any[];

    // 不貳過大師：解決最多問題的人
    const topSolvers = db.prepare(`
      SELECT lobster_id as id,
        display_name as name,
        problems_solved as solved,
        problems_contributed as contributed
      FROM lobster_accounts
      WHERE problems_solved > 0
      ORDER BY problems_solved DESC
      LIMIT ?
    `).all(limit) as any[];

    // 全站統計
    const globalStats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM debug_knowledge) as total_knowledge,
        (SELECT COUNT(DISTINCT contributed_by) FROM debug_knowledge WHERE contributed_by NOT IN ('system','auto_collector','sonnet_4.6','opus_local','git_history_miner')) as total_contributors,
        (SELECT COALESCE(SUM(hit_count), 0) FROM debug_knowledge) as total_hits,
        (SELECT COUNT(*) FROM lobster_accounts) as total_lobsters
    `).get() as any;

    return c.json({
      leaderboards: {
        top_contributors: topContributors.map((r: any, i: number) => ({
          rank: i + 1, id: r.id, name: r.name || r.id,
          contributions: r.contributions, total_hits: r.total_hits,
          title: i === 0 ? '🏆 踩坑王' : '',
        })),
        top_helpful: topHelpful.map((r: any, i: number) => ({
          rank: i + 1, id: r.id, name: r.name || r.id,
          total_hits: r.total_hits, contributions: r.contributions,
          title: i === 0 ? '💰 最強知識' : '',
        })),
        top_solvers: topSolvers.map((r: any, i: number) => ({
          rank: i + 1, id: r.id, name: r.name || r.id,
          solved: r.solved, contributed: r.contributed,
          title: i === 0 ? '🦞 不貳過大師' : '',
        })),
      },
      global: {
        total_knowledge: globalStats?.total_knowledge || 0,
        total_contributors: globalStats?.total_contributors || 0,
        total_hits: globalStats?.total_hits || 0,
        total_lobsters: globalStats?.total_lobsters || 0,
      },
    });
  });
}
