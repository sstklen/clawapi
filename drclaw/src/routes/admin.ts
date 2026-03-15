/**
 * Debug 管理員路由
 *
 * POST   /debug-ai/topup                     — 調整龍蝦貢獻額度
 * POST   /debug-ai/backfill                  — 補齊 Qdrant 向量索引
 * GET    /debug-ai/admin/channels             — 通路統計
 * GET    /debug-ai/admin/unsolved             — 未解佇列
 * POST   /debug-ai/admin/unsolved/:id/resolve — 結案
 * DELETE /debug-ai/admin/unsolved/:id         — 刪除單筆
 * DELETE /debug-ai/admin/unsolved             — 批量清理
 * POST   /debug-ai/ask-opus                  — 任意 prompt → Opus relay
 *
 * 所有 admin 端點使用 requireAdmin() 時序安全驗證
 */

import type { Hono } from 'hono';
import { createLogger } from '../logger';
import { getDb } from '../database';
import { isQdrantReady } from '../qdrant';
import type { DebugEntry } from '../core/types';
import { vectorizeAndStore } from '../core/kb-store';
import { creditAccount } from '../core/lobster-account';
import { isOpusRelayOnline, tryOpusRelay } from '../core/opus-bridge';
import { requireAdmin } from './middleware';

const log = createLogger('DebugRoutes:Admin');

export function registerAdminRoutes(router: Hono): void {

  // ── POST /debug-ai/topup — 管理員：調整龍蝦貢獻額度 ──
  router.post('/debug-ai/topup', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    let body: any;
    try { body = await c.req.json(); } catch {
      return c.json({ error: '請提供 JSON: { lobster_id, amount, note? }' }, 400);
    }

    const lobsterId = body.lobster_id;
    const amount = Number(body.amount);
    const note = body.note || '管理員調整額度';

    if (!lobsterId || !amount || amount <= 0 || amount > 1000) {
      return c.json({ error: 'lobster_id 和 amount(0-1000) 必填' }, 400);
    }

    const newBalance = creditAccount(lobsterId, amount, 'admin_topup', note);
    log.info(`管理員調整額度: lobster=${lobsterId}, amount=${amount}, new_balance=${newBalance}`);

    return c.json({
      status: 'ok',
      lobster_id: lobsterId,
      amount,
      new_balance: newBalance,
      message: `已為 ${lobsterId} 調整額度 +${amount}`,
    });
  });

  // ── POST /debug-ai/backfill — 管理員：補齊 Qdrant 向量索引 ──
  router.post('/debug-ai/backfill', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    if (!(await isQdrantReady())) {
      return c.json({ error: 'Qdrant 未就緒' }, 503);
    }

    const db = getDb();
    const limit = Math.min(parseInt(c.req.query('limit') || '50') || 50, 100);
    const offset = parseInt(c.req.query('offset') || '0') || 0;

    const allEntries = db.prepare(
      'SELECT id, error_description, error_message, error_category, quality_score FROM debug_knowledge ORDER BY id LIMIT ? OFFSET ?',
    ).all(limit, offset) as DebugEntry[];

    const total = (db.prepare('SELECT COUNT(*) as cnt FROM debug_knowledge').get() as any)?.cnt || 0;

    let indexed = 0;
    let failed = 0;

    // 一次 3 筆並行，避免 OOM
    for (let i = 0; i < allEntries.length; i += 3) {
      const batch = allEntries.slice(i, i + 3);
      await Promise.all(batch.map(async (entry) => {
        try {
          await vectorizeAndStore(entry.id!, entry.error_description, entry.error_message, entry.error_category, entry.quality_score);
          indexed++;
        } catch { failed++; }
      }));
    }

    return c.json({
      status: 'ok',
      message: `向量索引補齊：第 ${offset + 1}～${offset + allEntries.length} 筆`,
      total_in_db: total,
      processed: allEntries.length,
      indexed,
      failed,
      next: offset + limit < total ? `?limit=${limit}&offset=${offset + limit}` : null,
    });
  });

  // ── GET /debug-ai/admin/channels — 通路統計 ──
  router.get('/debug-ai/admin/channels', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const db = getDb();

    const searchByChannel = db.prepare(
      `SELECT channel, COUNT(*) as searches, SUM(hit) as hits
       FROM debug_search_log
       GROUP BY channel ORDER BY searches DESC`
    ).all();

    const usersByChannel = db.prepare(
      `SELECT channel, COUNT(*) as users
       FROM lobster_accounts
       GROUP BY channel ORDER BY users DESC`
    ).all();

    const recentActivity = db.prepare(
      `SELECT channel,
              COUNT(*) as searches_7d,
              SUM(hit) as hits_7d
       FROM debug_search_log
       WHERE created_at > datetime('now', '-7 days')
       GROUP BY channel ORDER BY searches_7d DESC`
    ).all();

    return c.json({
      status: 'ok',
      search_by_channel: searchByChannel,
      users_by_channel: usersByChannel,
      recent_7d: recentActivity,
    });
  });

  // ── GET /debug-ai/admin/unsolved — Unsolved 佇列 ──
  router.get('/debug-ai/admin/unsolved', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const db = getDb();
    const status = (c.req.query('status') || 'pending') as string;
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);

    const items = db.prepare(
      `SELECT * FROM unsolved_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?`
    ).all(status, limit);

    const stats = db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'wontfix' THEN 1 ELSE 0 END) as wontfix
       FROM unsolved_queue`
    ).get() as any;

    return c.json({
      status: 'ok',
      queue_stats: stats,
      items: items,
    });
  });

  // ── POST /debug-ai/admin/unsolved/:id/resolve — Unsolved 結案 ──
  router.post('/debug-ai/admin/unsolved/:id/resolve', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const unsolvedId = parseInt(c.req.param('id'));
    const db = getDb();

    const item = db.prepare('SELECT * FROM unsolved_queue WHERE id = ?').get(unsolvedId) as any;
    if (!item) {
      return c.json({ error: `找不到 unsolved #${unsolvedId}` }, 404);
    }

    let body: any = {};
    try { body = await c.req.json(); } catch {}

    const newStatus = body.status || 'resolved';
    const rootCause = body.root_cause || '';
    const fixDescription = body.fix_description || '';
    const fixPatch = body.fix_patch || '';
    const addToKb = body.add_to_kb !== false; // 預設寫入 KB

    // 更新 unsolved 記錄
    db.run(
      `UPDATE unsolved_queue SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      newStatus, unsolvedId,
    );

    let kbEntryId: number | null = null;

    // 寫入 KB
    if (addToKb && newStatus === 'resolved' && (rootCause || fixDescription)) {
      try {
        const result = db.run(
          `INSERT INTO debug_knowledge (error_description, error_message, error_category, root_cause, fix_description, fix_patch, environment, quality_score, verified, contributed_by, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          item.error_description,
          item.error_message || '',
          body.error_category || 'general',
          rootCause,
          fixDescription,
          fixPatch,
          item.environment || '{}',
          body.quality_score || 0.7,
          1,  // admin 解的就標 verified
          'admin_resolved',
          'unsolved_queue',
        );
        kbEntryId = (result as any).lastInsertRowid || null;

        // 更新 unsolved 記錄的 resolved_entry_id
        if (kbEntryId) {
          db.run('UPDATE unsolved_queue SET resolved_entry_id = ? WHERE id = ?', kbEntryId, unsolvedId);
        }

        log.info(`📋 unsolved #${unsolvedId} 已解決，KB entry #${kbEntryId}`);
      } catch (kbErr: any) {
        log.warn(`📋 unsolved #${unsolvedId} 寫入 KB 失敗: ${kbErr.message}`);
      }
    }

    return c.json({
      status: 'ok',
      message: `unsolved #${unsolvedId} → ${newStatus}`,
      kb_entry_id: kbEntryId,
    });
  });

  // ── DELETE /debug-ai/admin/unsolved/:id — 刪除單筆 ──
  router.delete('/debug-ai/admin/unsolved/:id', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const unsolvedId = parseInt(c.req.param('id'));
    const db = getDb();
    const result = db.run('DELETE FROM unsolved_queue WHERE id = ?', unsolvedId);

    return c.json({
      status: 'ok',
      message: `unsolved #${unsolvedId} 已刪除`,
      changes: (result as any).changes || 0,
    });
  });

  // ── DELETE /debug-ai/admin/unsolved — 批量清理 ──
  router.delete('/debug-ai/admin/unsolved', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const db = getDb();
    const lobsterPattern = c.req.query('lobster_pattern') || 'e2e-test-%';
    const result = db.run('DELETE FROM unsolved_queue WHERE lobster_id LIKE ?', lobsterPattern);

    return c.json({
      status: 'ok',
      message: `已清理 lobster_id LIKE '${lobsterPattern}' 的測試資料`,
      deleted: (result as any).changes || 0,
    });
  });

  // ── POST /debug-ai/ask-opus — 任意 prompt → Opus relay ──
  router.post('/debug-ai/ask-opus', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    let body: any;
    try { body = await c.req.json(); } catch {
      return c.json({ error: '請提供 JSON body: { prompt }' }, 400);
    }
    const prompt = body.prompt as string;
    if (!prompt) return c.json({ error: '缺少 prompt 欄位' }, 400);

    if (!isOpusRelayOnline()) {
      return c.json({ error: 'Opus relay 不在線', online: false }, 503);
    }

    const result = await tryOpusRelay(
      `[RAW_PROMPT] ${prompt}`,
      '',
      {},
    );

    if (!result) {
      return c.json({ error: 'Relay 超時或失敗', online: false }, 503);
    }

    return c.json({
      ok: true,
      text: result.fix_description || JSON.stringify(result),
      raw: result,
    });
  });
}
