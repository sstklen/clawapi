// Backup 路由處理器（Stub）
// PUT /v1/backup — 備份上傳（v1.1 推遲）
// GET /v1/backup — 備份查詢（v1.1 推遲）
// DELETE /v1/backup — 備份刪除（v1.1 推遲）
// 所有端點回傳 501 Not Implemented

import { Hono } from 'hono';
import type { AuthVariables } from '../middleware/auth';

const NOT_IMPLEMENTED_MESSAGE = 'v1.1 推遲';

// 建立 Backup 路由（所有端點為 stub，回傳 501）
export function createBackupRouter(): Hono<{ Variables: AuthVariables }> {
  const router = new Hono<{ Variables: AuthVariables }>();

  // PUT /v1/backup — 上傳備份（stub）
  router.put('/', (c) => {
    return c.json(
      {
        error: 'NOT_IMPLEMENTED',
        message: NOT_IMPLEMENTED_MESSAGE,
        endpoint: 'PUT /v1/backup',
      },
      501,
    );
  });

  // GET /v1/backup — 查詢備份（stub）
  router.get('/', (c) => {
    return c.json(
      {
        error: 'NOT_IMPLEMENTED',
        message: NOT_IMPLEMENTED_MESSAGE,
        endpoint: 'GET /v1/backup',
      },
      501,
    );
  });

  // DELETE /v1/backup — 刪除備份（stub）
  router.delete('/', (c) => {
    return c.json(
      {
        error: 'NOT_IMPLEMENTED',
        message: NOT_IMPLEMENTED_MESSAGE,
        endpoint: 'DELETE /v1/backup',
      },
      501,
    );
  });

  return router;
}
