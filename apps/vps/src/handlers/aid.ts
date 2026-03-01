// 互助配對路由 Handler
// 涵蓋：發起互助、更新設定、查詢設定、密文轉發
// 依據 SPEC-B §4.5 + SPEC-C §4.5 實作

import { Hono } from 'hono';
import { ErrorCode } from '@clawapi/protocol';
import type { AidEngine, AidRequestBody, AidConfigBody, AidRelayBody } from '../services/aid-engine';
import type { AuthVariables } from '../middleware/auth';

// Aid 路由 context 型別（繼承 AuthVariables，含 deviceId 和 device）
type AidVariables = AuthVariables;

/**
 * createAidRouter — 建立 Aid 路由
 * 所有路由需要 deviceAuth（由外層掛載）
 *
 * @param aidEngine — AidEngine 實例（含配對邏輯）
 */
export function createAidRouter(
  aidEngine: AidEngine,
): Hono<{ Variables: AidVariables }> {
  const router = new Hono<{ Variables: AidVariables }>();

  // ===== POST /v1/aid/request =====
  // 發起互助請求
  // Body: { service_id, request_type, requester_public_key }
  // Response: 202 + { aid_id, status: 'matching' }
  router.post('/request', async (c) => {
    const deviceId = c.get('deviceId');
    if (!deviceId) {
      return c.json(
        {
          error: ErrorCode.AUTH_DEVICE_NOT_FOUND,
          message: '無法識別裝置身份',
        },
        401,
      );
    }

    // 解析 request body
    let body: AidRequestBody;
    try {
      body = (await c.req.json()) as AidRequestBody;
    } catch {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '請求 body 格式錯誤，請使用 JSON',
        },
        400,
      );
    }

    // 驗證必填欄位
    const { service_id, request_type, requester_public_key } = body;
    if (!service_id || !request_type || !requester_public_key) {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '缺少必填欄位：service_id, request_type, requester_public_key',
        },
        400,
      );
    }

    // 委派給 AidEngine 處理
    const result = await aidEngine.handleRequest(deviceId, {
      service_id,
      request_type,
      requester_public_key,
    });

    if (!result.ok) {
      // 依錯誤碼回傳對應 HTTP 狀態碼
      const httpStatus =
        result.errorCode === ErrorCode.AID_COOLDOWN ? 429
        : result.errorCode === ErrorCode.AID_DAILY_LIMIT_REACHED ? 429
        : result.errorCode === ErrorCode.AID_NOT_ENABLED ? 400
        : 500;

      return c.json(
        {
          error: result.errorCode,
          message: result.message,
          ...(result.retry_after !== undefined ? { retry_after: result.retry_after } : {}),
        },
        httpStatus,
      );
    }

    // 202 Accepted：配對中，結果透過 WebSocket 推送
    return c.json(
      {
        aid_id: result.aid_id,
        status: 'matching',
        message: '互助請求已受理，正在尋找幫助者，請保持 WebSocket 連線',
        estimated_wait_ms: 30_000,
      },
      202,
    );
  });

  // ===== PUT /v1/aid/config =====
  // 更新互助設定
  // Body: { enabled?, allowed_services?, daily_limit?, blackout_hours?, helper_public_key? }
  // Response: 200 + { updated: true, config }
  router.put('/config', async (c) => {
    const deviceId = c.get('deviceId');
    if (!deviceId) {
      return c.json(
        {
          error: ErrorCode.AUTH_DEVICE_NOT_FOUND,
          message: '無法識別裝置身份',
        },
        401,
      );
    }

    // 解析 request body
    let body: AidConfigBody;
    try {
      body = (await c.req.json()) as AidConfigBody;
    } catch {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '請求 body 格式錯誤，請使用 JSON',
        },
        400,
      );
    }

    // 基本驗證：若 daily_limit 有帶，必須是合理數字
    if (
      body.daily_limit !== undefined &&
      (typeof body.daily_limit !== 'number' || body.daily_limit < 1 || body.daily_limit > 200)
    ) {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: 'daily_limit 必須是 1-200 之間的整數',
        },
        400,
      );
    }

    // 委派給 AidEngine 處理
    const result = await aidEngine.updateConfig(deviceId, body);

    if (!result.ok) {
      return c.json(
        {
          error: result.errorCode,
          message: result.message,
        },
        400,
      );
    }

    return c.json(
      {
        updated: true,
        config: result.config,
        message: '互助設定已更新',
      },
      200,
    );
  });

  // ===== GET /v1/aid/config =====
  // 取得目前的互助設定
  // Response: 200 + AidConfig（或 200 + 預設設定）
  router.get('/config', (c) => {
    const deviceId = c.get('deviceId');
    if (!deviceId) {
      return c.json(
        {
          error: ErrorCode.AUTH_DEVICE_NOT_FOUND,
          message: '無法識別裝置身份',
        },
        401,
      );
    }

    const config = aidEngine.getConfig(deviceId);

    if (!config) {
      // 尚未設定過，回傳預設值
      return c.json(
        {
          enabled: false,
          allowed_services: null,
          daily_limit: 50,
          daily_given: 0,
          blackout_hours: [],
          helper_public_key: null,
          message: '尚未設定互助，回傳預設值',
        },
        200,
      );
    }

    return c.json(config, 200);
  });

  // ===== POST /v1/aid/relay =====
  // 密文轉發（內部用）
  // Body: { aid_id, from_device_id, encrypted_payload, iv, tag, kind, helper_public_key? }
  // Response: 200 + { relayed: true } 或 錯誤
  //
  // 注意：此端點在生產環境應只允許內部呼叫（service-to-service）
  // 目前仍需 deviceAuth，由呼叫方帶上有效的 X-Device-Id + X-Device-Token
  router.post('/relay', async (c) => {
    const deviceId = c.get('deviceId');
    if (!deviceId) {
      return c.json(
        {
          error: ErrorCode.AUTH_DEVICE_NOT_FOUND,
          message: '無法識別裝置身份',
        },
        401,
      );
    }

    // 解析 request body
    let body: AidRelayBody;
    try {
      body = (await c.req.json()) as AidRelayBody;
    } catch {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '請求 body 格式錯誤，請使用 JSON',
        },
        400,
      );
    }

    // 驗證必填欄位
    const { aid_id, from_device_id, encrypted_payload, iv, tag, kind } = body;
    if (!aid_id || !from_device_id || !encrypted_payload || !iv || !tag || !kind) {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: '缺少必填欄位：aid_id, from_device_id, encrypted_payload, iv, tag, kind',
        },
        400,
      );
    }

    // kind 只允許兩種值
    if (kind !== 'encrypted_request' && kind !== 'encrypted_response') {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: 'kind 只能是 encrypted_request 或 encrypted_response',
        },
        400,
      );
    }

    // 驗證 from_device_id 與認證的 deviceId 一致（防止偽冒）
    if (from_device_id !== deviceId) {
      return c.json(
        {
          error: ErrorCode.INVALID_REQUEST,
          message: 'from_device_id 必須與認證裝置 ID 一致',
        },
        400,
      );
    }

    // 委派給 AidEngine 處理轉發
    const result = await aidEngine.relayAidData(aid_id, deviceId, body);

    if (!result.ok) {
      const httpStatus =
        result.errorCode === ErrorCode.AID_PAYLOAD_TOO_LARGE ? 413
        : result.errorCode === ErrorCode.SERVICE_UNAVAILABLE ? 503
        : 400;

      return c.json(
        {
          error: result.errorCode,
          message: result.message,
        },
        httpStatus,
      );
    }

    return c.json(
      {
        relayed: true,
        aid_id,
        message: '密文已轉發至對方',
      },
      200,
    );
  });

  return router;
}
