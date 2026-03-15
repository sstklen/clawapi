/**
 * Debug 路由共用 middleware
 *
 * - requireAdmin：時序安全的管理員密碼驗證
 * - 其他共用 helper 日後可加在這裡
 */

import type { Context } from 'hono';
import { safeCompare } from '../safe-compare';

/**
 * 驗證管理員密碼（時序安全）
 * 回傳 null 表示驗證通過，否則回傳 403/401 Response
 *
 * 用法：
 * ```ts
 * const denied = requireAdmin(c);
 * if (denied) return denied;
 * // ... 正常邏輯
 * ```
 */
export function requireAdmin(c: Context): Response | null {
  const adminPw = c.req.header('x-admin-password') || '';
  const expected = process.env.ADMIN_PASSWORD || '';

  if (!expected) {
    // 伺服器沒設定 ADMIN_PASSWORD → 拒絕所有 admin 請求
    return c.json({ error: 'ADMIN_PASSWORD 未設定' }, 500) as unknown as Response;
  }

  if (!safeCompare(adminPw, expected)) {
    return c.json({ error: '需要管理員密碼' }, 403) as unknown as Response;
  }

  return null; // 通過
}
