/**
 * Debug 問題回報 + 升級路由
 *
 * POST /debug-ai/report-issue — 回報孔子答案有問題
 * POST /debug-ai/escalate     — 環境快照補充（unsolved 佇列）
 */

import type { Hono } from 'hono';
import { createLogger } from '../logger';
import { getDb } from '../database';
import { extractChannel } from '../core/auto-collector';

const log = createLogger('DebugRoutes:Escalate');

export function registerEscalateRoutes(router: Hono): void {

  // ── POST /debug-ai/report-issue — 使用者回報孔子答案有問題 ──
  router.post('/debug-ai/report-issue', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { lobster_id, original_query, original_fix_id, what_went_wrong, new_error_message } = body;

    if (!what_went_wrong) {
      return c.json({ error: '請描述哪裡出了問題 (what_went_wrong 必填)' }, 400);
    }

    const db = getDb();

    // 記錄回報
    db.run(
      `INSERT INTO debug_search_log (query, source, hit, caller_info)
       VALUES (?, 'report_issue', 0, ?)`,
      [
        `[REPORT] ${(what_went_wrong as string).slice(0, 200)}`,
        JSON.stringify({ lobster_id, original_query, original_fix_id, new_error_message: (new_error_message || '').slice(0, 500) })
      ]
    );

    // 如果有 original_fix_id，標記該 KB 條目為有問題
    if (original_fix_id) {
      const entry = db.prepare('SELECT * FROM debug_knowledge WHERE id = ?').get(original_fix_id) as any;
      if (entry) {
        // 降低品質分數
        const newScore = Math.max(0, (entry.quality_score || 0.5) - 0.2);
        db.run('UPDATE debug_knowledge SET quality_score = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?', [newScore, original_fix_id]);
      }
    }

    return c.json({
      status: 'ok',
      message: '🙏 感謝回報！我們會檢查這個答案並修正。Confucius Debug 靠社群一起變強 🦞',
      tip: 'Meanwhile, try debug_search with your new error message \u2014 we may have a different solution.',
    });
  });

  // ── POST /debug-ai/escalate — 問診回報：提供環境快照 + logs（免費） ──
  router.post('/debug-ai/escalate', async (c) => {
    try {
      const body = await c.req.json();
      const {
        error_description = '',
        error_message = '',
        lobster_id = 'anonymous',
        environment = {},
        logs = '',
        tried = [],
        project_structure = '',
        unsolved_id,
      } = body;
      const channel = extractChannel(body, c.req.header() as any);

      if (!error_description && !unsolved_id) {
        return c.json({ error: '需要 error_description 或 unsolved_id' }, 400);
      }

      const db = getDb();

      if (unsolved_id) {
        // 更新既有的 unsolved 記錄
        db.run(
          `UPDATE unsolved_queue SET
            environment = ?,
            logs = ?,
            tried = ?,
            project_structure = ?,
            status = 'pending',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
          JSON.stringify(environment),
          typeof logs === 'string' ? logs : JSON.stringify(logs),
          JSON.stringify(tried),
          project_structure,
          unsolved_id,
        );
        log.info(`📋 unsolved #${unsolved_id} 補充了環境資訊`);
      } else {
        // 新建 unsolved 記錄
        db.run(
          `INSERT INTO unsolved_queue (error_description, error_message, lobster_id, environment, logs, tried, project_structure)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          error_description,
          error_message,
          lobster_id,
          JSON.stringify(environment),
          typeof logs === 'string' ? logs : JSON.stringify(logs),
          JSON.stringify(tried),
          project_structure,
        );
        log.info(`📋 新 escalate 工單: lobster=${lobster_id}, channel=${channel}`);
      }

      // 統計 unsolved 佇列
      const stats = db.prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved
         FROM unsolved_queue`
      ).get() as any;

      return c.json({
        status: 'received',
        message: '🙏 收到了！我們會帶回去研究，解出來後自動存入 KB。感謝你提供環境資訊，這對診斷非常有幫助。',
        queue_stats: {
          total: stats?.total || 0,
          pending: stats?.pending || 0,
          resolved: stats?.resolved || 0,
        },
        hint: '我們的團隊會定期處理 unsolved 佇列。解決後，下一個遇到同樣問題的人就能秒解！',
      });
    } catch (err: any) {
      log.error(`escalate 失敗: ${err.message}`);
      return c.json({ error: '提交失敗，請稍後重試' }, 500);
    }
  });
}
