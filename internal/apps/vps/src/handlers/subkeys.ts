// Sub-Key 路由處理器
// POST /v1/subkeys/validate — Sub-Key 驗證端點（不需要裝置認證）
// 此路徑已在 auth.ts 的 SKIP_AUTH_PATHS 中豁免認證

import { Hono } from 'hono';
import { ErrorCode } from '@clawapi/protocol';
import type { SubKeyValidator, SubKeyValidateError } from '../services/subkey-validator';

// ===== Handler 工廠函式 =====
// 接受 SubKeyValidator 注入，回傳 Hono 路由

export function createSubKeysRouter(validator: SubKeyValidator): Hono {
  const router = new Hono();

  // POST /v1/subkeys/validate
  // 驗證 Sub-Key 是否有效
  // Body: { sub_key: string, service_id: string }
  // 成功 → 200 { valid: true, permissions?: string[] }
  // Sub-Key 無效 → 403 { error: SUBKEY_INVALID }
  // 發行者離線 → 503 { error: SUBKEY_ISSUER_OFFLINE }
  router.post('/validate', async (c) => {
    // ===== 解析請求 body =====
    let body: { sub_key?: string; service_id?: string };

    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '請求 body 格式錯誤，需為 JSON',
        },
        400,
      );
    }

    const { sub_key, service_id } = body;

    // ===== 驗證必填欄位 =====
    if (!sub_key || typeof sub_key !== 'string') {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '缺少必填欄位：sub_key',
        },
        400,
      );
    }

    if (!service_id || typeof service_id !== 'string') {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '缺少必填欄位：service_id',
        },
        400,
      );
    }

    // ===== 執行驗證 =====
    try {
      const result = await validator.validate(sub_key, service_id);

      // 驗證成功（valid 可能是 true 或 false，都是 200）
      return c.json({
        valid: result.valid,
        permissions: result.permissions ?? undefined,
      });
    } catch (err: unknown) {
      // ===== 處理已知錯誤 =====
      const validatorError = err as SubKeyValidateError;

      if (validatorError.errorCode === ErrorCode.SUBKEY_ISSUER_OFFLINE) {
        // 發行者離線 → 503
        return c.json(
          {
            error: ErrorCode.SUBKEY_ISSUER_OFFLINE,
            message: validatorError.message || 'Sub-Key 發行者目前離線',
            suggestion: '請稍後重試，或聯繫 Sub-Key 的發行者',
          },
          503,
        );
      }

      if (validatorError.errorCode === ErrorCode.SUBKEY_INVALID) {
        // Sub-Key 無效 → 403
        return c.json(
          {
            error: ErrorCode.SUBKEY_INVALID,
            message: validatorError.message || 'Sub-Key 無效',
          },
          403,
        );
      }

      // ===== 未知錯誤 → 500 =====
      console.error('[SubKeys] 驗證 Sub-Key 時發生未預期錯誤：', err);
      return c.json(
        {
          error: ErrorCode.INTERNAL_ERROR,
          message: '伺服器內部錯誤，請稍後重試',
        },
        500,
      );
    }
  });

  return router;
}
