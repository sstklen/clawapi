// 認證 Middleware
// 裝置認證（deviceAuth）+ 管理員認證（adminAuth）

import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { ErrorCode } from '@clawapi/protocol';
import type { VPSDatabase, Device } from '../storage/database';

// 安全比較（防 timing attack）
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Hono context 型別變數（存放認證通過後的裝置資料）
export type AuthVariables = {
  deviceId: string;
  device: Device;
};

// 不需要裝置認證的路徑（v1.3 修訂：改為精確匹配 + 前綴匹配分離）
// 精確匹配的路徑
const SKIP_AUTH_EXACT = [
  '/v1/aid/leaderboard',  // 感謝榜：公開端點，不需要認證
  '/health',
] as const;

// 前綴匹配的路徑（這些路徑底下有子路由）
const SKIP_AUTH_PREFIX = [
  '/v1/devices/register',
  '/v1/subkeys/validate',
  '/v1/ws',        // WebSocket 端點：認證透過 ?token= 參數，不是 HTTP header
] as const;

// 裝置認證中介層
// 驗證 X-Device-Id + X-Device-Token，通過後將 device 存入 context
export function deviceAuth(db: VPSDatabase): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    // 跳過不需要認證的端點
    const reqPath = c.req.path;
    if (
      SKIP_AUTH_EXACT.some((p) => reqPath === p) ||
      SKIP_AUTH_PREFIX.some((p) => reqPath.startsWith(p))
    ) {
      return next();
    }

    const deviceId = c.req.header('X-Device-Id');
    const deviceToken = c.req.header('X-Device-Token');

    // 缺少必要 header
    if (!deviceId || !deviceToken) {
      return c.json(
        {
          error: ErrorCode.AUTH_MISSING_HEADERS,
          message: '缺少 X-Device-Id 或 X-Device-Token',
          suggestion: '請先 POST /v1/devices/register',
        },
        401,
      );
    }

    // 查詢裝置是否存在
    const device = db.getDevice(deviceId);
    if (!device) {
      return c.json(
        {
          error: ErrorCode.AUTH_DEVICE_NOT_FOUND,
          message: '此裝置未註冊',
          suggestion: 'POST /v1/devices/register',
        },
        401,
      );
    }

    // 驗證 token 是否匹配
    if (!safeCompare(device.device_token, deviceToken)) {
      return c.json(
        {
          error: ErrorCode.AUTH_INVALID_TOKEN,
          message: 'Token 無效',
        },
        401,
      );
    }

    // 檢查 token 是否過期
    if (new Date(device.token_expires_at) < new Date()) {
      return c.json(
        {
          error: ErrorCode.AUTH_TOKEN_EXPIRED,
          message: 'Token 已過期',
          suggestion: 'POST /v1/devices/refresh',
        },
        401,
      );
    }

    // 檢查 fingerprint（若請求帶了 X-Device-Fingerprint）
    const requestFingerprint = c.req.header('X-Device-Fingerprint');
    if (requestFingerprint && requestFingerprint !== device.device_fingerprint) {
      return c.json(
        {
          error: ErrorCode.DEVICE_FINGERPRINT_MISMATCH,
          message: '裝置指紋不符',
          suggestion: '請重新註冊此裝置',
        },
        403,
      );
    }

    // 檢查裝置是否被暫停
    if (device.status === 'suspended') {
      return c.json(
        {
          error: ErrorCode.DEVICE_SUSPENDED,
          message: `此裝置因異常行為被暫停: ${device.suspended_reason ?? '未知原因'}`,
          suggestion: '請聯繫支援',
        },
        403,
      );
    }

    // 更新最後活動時間（非同步，不阻塞請求）
    db.updateDeviceLastSeen(deviceId);

    // 將裝置資料存入 context 供後續 handler 使用
    c.set('deviceId', deviceId);
    c.set('device', device);

    return next();
  };
}

// 管理員認證中介層
// 驗證 Authorization: Bearer {ADMIN_TOKEN}
export function adminAuth(): MiddlewareHandler {
  return async (c, next) => {
    const adminToken = process.env['ADMIN_TOKEN'];

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json(
        {
          error: ErrorCode.AUTH_MISSING_HEADERS,
          message: '缺少 Authorization header',
        },
        401,
      );
    }

    const token = authHeader.slice('Bearer '.length);
    if (!adminToken || !safeCompare(token, adminToken)) {
      return c.json(
        {
          error: ErrorCode.AUTH_INVALID_TOKEN,
          message: '管理員 token 無效',
        },
        401,
      );
    }

    return next();
  };
}
