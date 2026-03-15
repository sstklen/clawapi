// L0 公共 Key 路由處理器
// 涵蓋：Key 下發、Key 捐贈、用量回報

import { Hono } from 'hono';
import { ErrorCode } from '@clawapi/protocol';
import type { L0Manager, UsageEntry, DonateBody } from '../services/l0-manager';
import type { VPSDatabase } from '../storage/database';
import type { AuthVariables } from '../middleware/auth';

// L0 路由 context 型別
type L0Variables = AuthVariables;

// 建立 L0 路由（需注入 db 和 l0Manager）
export function createL0Router(
  db: VPSDatabase,
  l0Manager: L0Manager,
): Hono<{ Variables: L0Variables }> {
  const router = new Hono<{ Variables: L0Variables }>();

  // ===== GET /v1/l0/keys =====
  // 下發 L0 Key 列表給已認證裝置
  // Query param: since (optional, ISO 8601)
  // 若無新 key → 204（因 Hono 無法直接 304，改用 204 表示無新內容）
  router.get('/keys', async (c) => {
    const deviceId = c.get('deviceId');
    if (!deviceId) {
      return c.json(
        { error: ErrorCode.AUTH_DEVICE_NOT_FOUND, message: '無法識別裝置身份' },
        401,
      );
    }

    // 解析 since 參數
    const since = c.req.query('since') ?? undefined;

    // 取 Key 列表
    const records = l0Manager.getKeys(since);

    // since 有帶但沒有新 key → 204（客戶端應認定 304 Not Modified）
    if (since && records === null) {
      return c.body(null, 304);
    }

    // 沒有任何 key → 回空列表
    const keyList = records ?? [];

    // 取裝置限額（依 service 分組）
    const deviceLimits = l0Manager.getDeviceLimits(deviceId);

    // 取今日用量
    const today = new Date().toISOString().slice(0, 10);
    const usageRecords = db.query<{ service_id: string; used_count: number; daily_limit: number }>(
      `SELECT service_id, used_count, daily_limit
       FROM l0_device_usage
       WHERE device_id = ? AND date = ?`,
      [deviceId, today],
    );
    const usageMap = new Map(usageRecords.map((r) => [r.service_id, r]));

    // 組裝回應：每個 key 的下發包
    const keys = keyList.map((record) => {
      const pkg = l0Manager.prepareForDownload(record);
      const limit = deviceLimits[record.service_id] ?? 10;
      const usage = usageMap.get(record.service_id);

      return {
        ...pkg,
        daily_quota_per_device: limit,
      };
    });

    // 組裝每個 service 的裝置每日限額 + 用量
    const deviceDailyLimits: Record<string, { limit: number; used: number; reset_at: string }> = {};
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const resetAt = tomorrow.toISOString();

    // 從所有 key 中蒐集 service_id
    const serviceIds = [...new Set(keyList.map((k) => k.service_id))];
    for (const serviceId of serviceIds) {
      const limit = deviceLimits[serviceId] ?? 10;
      const usage = usageMap.get(serviceId);
      deviceDailyLimits[serviceId] = {
        limit,
        used: usage?.used_count ?? 0,
        reset_at: resetAt,
      };
    }

    // 回應格式依 SPEC-C §4.3（L0KeysResponse）
    return c.json({
      schema_version: 1,
      keys,
      l0_encryption_key: 'l0_master_v1',  // 告知客戶端使用的加密 key 版本
      device_daily_limits: deviceDailyLimits,
      cache_ttl: 300,                      // 客戶端可快取 5 分鐘
      server_time: new Date().toISOString(),
    });
  });

  // ===== POST /v1/l0/donate =====
  // 捐贈 Key（需 deviceAuth）
  // Body: { service_id, encrypted_key, ephemeral_public_key, iv, tag, display_name?, anonymous? }
  router.post('/donate', async (c) => {
    const deviceId = c.get('deviceId');
    if (!deviceId) {
      return c.json(
        { error: ErrorCode.AUTH_DEVICE_NOT_FOUND, message: '無法識別裝置身份' },
        401,
      );
    }

    // 解析 body
    let body: DonateBody;
    try {
      body = await c.req.json() as DonateBody;
    } catch {
      return c.json(
        { error: ErrorCode.INVALID_REQUEST, message: '請求 body 格式錯誤' },
        400,
      );
    }

    // 驗證必填欄位
    const { service_id, encrypted_key, ephemeral_public_key, iv, tag } = body;
    if (!service_id || !encrypted_key || !ephemeral_public_key || !iv || !tag) {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '缺少必填欄位：service_id, encrypted_key, ephemeral_public_key, iv, tag',
        },
        400,
      );
    }

    // 執行捐贈流程
    try {
      const result = await l0Manager.handleDonate(deviceId, body);
      return c.json(result, 200);
    } catch (err: unknown) {
      const error = err as Error & { errorCode?: string };
      const code = error.errorCode;

      // 根據錯誤碼回傳對應 HTTP 狀態碼
      if (code === 'L0_DONATE_RATE_LIMITED') {
        return c.json(
          {
            error: ErrorCode.L0_DONATE_RATE_LIMITED,
            message: error.message,
            retry_after: 86400, // 24 小時後重試（秒）
          },
          429,
        );
      }
      if (code === 'L0_DONATE_DUPLICATE') {
        return c.json(
          {
            error: ErrorCode.L0_DONATE_DUPLICATE,
            message: error.message,
          },
          409,
        );
      }
      if (code === 'L0_DONATE_INVALID_KEY') {
        return c.json(
          {
            error: ErrorCode.L0_DONATE_INVALID_KEY,
            message: error.message,
          },
          400,
        );
      }

      // 未預期的錯誤
      console.error('[L0 捐贈] 未預期錯誤：', err);
      return c.json(
        { error: ErrorCode.INTERNAL_ERROR, message: '捐贈處理失敗，請稍後重試' },
        500,
      );
    }
  });

  // ===== POST /v1/l0/usage =====
  // 用量回報（需 deviceAuth）
  // Body: { entries: [{ l0_key_id, service_id, timestamp, tokens_used?, success }] }
  router.post('/usage', async (c) => {
    const deviceId = c.get('deviceId');
    if (!deviceId) {
      return c.json(
        { error: ErrorCode.AUTH_DEVICE_NOT_FOUND, message: '無法識別裝置身份' },
        401,
      );
    }

    // 解析 body
    let body: { entries?: UsageEntry[] };
    try {
      body = await c.req.json() as { entries?: UsageEntry[] };
    } catch {
      return c.json(
        { error: ErrorCode.INVALID_REQUEST, message: '請求 body 格式錯誤' },
        400,
      );
    }

    const { entries } = body;

    // 驗證 entries 格式
    if (!Array.isArray(entries) || entries.length === 0) {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: 'entries 必須是非空陣列',
        },
        400,
      );
    }

    // 驗證每個 entry 的必填欄位
    for (const entry of entries) {
      if (!entry.l0_key_id || !entry.service_id || !entry.timestamp) {
        return c.json(
          {
            error: ErrorCode.INVALID_REQUEST,
            message: 'entry 缺少必填欄位：l0_key_id, service_id, timestamp',
          },
          400,
        );
      }
    }

    // 執行用量回報
    try {
      const result = await l0Manager.reportUsage(deviceId, entries);
      return c.json({
        accepted: true,
        updated: result.updated,
        message: '用量已記錄',
      });
    } catch (err) {
      console.error('[L0 用量] 回報失敗：', err);
      return c.json(
        { error: ErrorCode.INTERNAL_ERROR, message: '用量回報失敗，請稍後重試' },
        500,
      );
    }
  });

  return router;
}
