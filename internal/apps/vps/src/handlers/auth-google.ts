// Google OAuth 綁定路由處理器
// MVP 簡化版：不實際驗證 Google token，只做 hash + 防重複綁定
// 完整 Google token 驗證在 v1.1+ 實作

import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { ErrorCode } from '@clawapi/protocol';
import type { VPSDatabase } from '../storage/database';
import type { AuthVariables } from '../middleware/auth';

// 建立 Google OAuth 路由（需要注入 db）
export function createAuthGoogleRouter(db: VPSDatabase): Hono<{ Variables: AuthVariables }> {
  const authGoogleRouter = new Hono<{ Variables: AuthVariables }>();

  // POST /v1/auth/google
  // 綁定 Google 帳號到裝置
  // 需要 device auth middleware 通過
  authGoogleRouter.post('/', async (c) => {
    const device = c.get('device');
    if (!device) {
      return c.json(
        { error: ErrorCode.AUTH_DEVICE_NOT_FOUND, message: '此裝置未認證' },
        401,
      );
    }

    let body: { google_token?: string; nickname?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: ErrorCode.INVALID_REQUEST, message: '請求 body 格式錯誤' },
        400,
      );
    }

    const { google_token, nickname } = body;

    if (!google_token) {
      return c.json(
        { error: ErrorCode.INVALID_REQUEST, message: '缺少 google_token' },
        400,
      );
    }

    // MVP 簡化：計算 google_id_hash = SHA-256(google_token) 保護隱私
    // 注意：實際應驗證 Google ID Token 並取出 sub（使用者 ID）再做 hash
    // 這裡暫用 token 本身做 hash（v1.1+ 改為驗證 JWT 取 sub）
    const googleIdHash = createHash('sha256').update(google_token).digest('hex');

    // 檢查此 google_id_hash 是否已綁定其他裝置
    const existingBinding = db.query<{ device_id: string }>(
      'SELECT device_id FROM devices WHERE google_id_hash = ?',
      [googleIdHash],
    );

    if (existingBinding.length > 0 && existingBinding[0].device_id !== device.device_id) {
      // 已綁定到其他裝置
      return c.json(
        {
          error: ErrorCode.AUTH_GOOGLE_ALREADY_BOUND,
          message: '此 Google 帳號已綁定到其他裝置',
          suggestion: '若要轉移，請先解除舊裝置的綁定',
        },
        409,
      );
    }

    // 更新 device 表：寫入 google_id_hash、google_email_masked、nickname
    // MVP 版：google_email_masked 因無法驗證 token 故暫為 null
    const finalNickname = nickname ?? device.nickname ?? null;

    db.run(
      `UPDATE devices
       SET google_id_hash = ?,
           google_email_masked = NULL,
           nickname = ?,
           updated_at = datetime('now')
       WHERE device_id = ?`,
      [googleIdHash, finalNickname, device.device_id],
    );

    return c.json({
      bound: true,
      nickname: finalNickname,
    });
  });

  return authGoogleRouter;
}
