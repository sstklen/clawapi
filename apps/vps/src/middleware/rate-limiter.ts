// Rate Limiter Middleware
// 基於 @clawapi/protocol 的 RATE_LIMITS 常數（21 個端點）
// 滑動窗口實作（記憶體內），支援 device_id 或 IP hash 作為 key

import type { Context, Next } from 'hono';
import { RATE_LIMITS, DEVICE_MAX_PER_IP } from '@clawapi/protocol';
import { createHash } from 'node:crypto';

// 滑動窗口計數紀錄
interface RateLimitEntry {
  count: number;
  windowStart: number;  // 窗口開始時間（ms）
}

// 記憶體內 Rate Limit 計數（device/IP → endpoint → 計數）
const rateLimitStore = new Map<string, RateLimitEntry>();

// IP 裝置計數（ip_hash → Set<device_id>），用於同 IP 最多 5 個 device 限制
const ipDeviceRegistry = new Map<string, Set<string>>();

// 對 IP 字串做 SHA-256 hash（不存明文 IP）
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// 取得請求來源 IP（支援 Cloudflare + X-Forwarded-For）
function getClientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

// 取得 Rate Limit store key
// 已認證請求用 device_id，未認證用 IP hash
function getRateLimitKey(c: Context, endpointKey: string): string {
  const deviceId = c.req.header('X-Device-Id');
  if (deviceId) {
    return `${deviceId}:${endpointKey}`;
  }
  const ipHash = hashIp(getClientIp(c));
  return `ip:${ipHash}:${endpointKey}`;
}

// 將 store 中過期的 key 清理（每 1000 次請求清一次，避免記憶體無限成長）
let cleanupCounter = 0;
function maybeCleanup(): void {
  cleanupCounter++;
  if (cleanupCounter < 1000) return;
  cleanupCounter = 0;

  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    // 找出此 key 對應的端點設定，計算窗口大小
    // 找不到對應設定的 key 一律視為過期清除
    const parts = key.split(':');
    // key 格式：{deviceId/ip:ipHash}:{METHOD /path}
    // 找出端點部分（最後兩段用空格拼合）
    const endpointKey = parts.slice(parts.length >= 3 ? (key.startsWith('ip:') ? 2 : 1) : 1).join(':');
    const config = RATE_LIMITS[endpointKey];
    if (!config) {
      rateLimitStore.delete(key);
      continue;
    }
    const windowMs = config.windowSeconds * 1000;
    if (now - entry.windowStart > windowMs) {
      rateLimitStore.delete(key);
    }
  }
}

// 檢查並記錄此 IP 是否可以再新增 device（同 IP 最多 DEVICE_MAX_PER_IP 個）
// 回傳 true = 允許，false = 超過限制
export function checkIpDeviceLimit(ip: string, deviceId: string): boolean {
  const ipHash = hashIp(ip);
  const devices = ipDeviceRegistry.get(ipHash) ?? new Set<string>();
  // 已存在的 device_id 不算新增
  if (devices.has(deviceId)) return true;
  if (devices.size >= DEVICE_MAX_PER_IP) return false;
  return true;
}

// 登記 IP + device_id 組合（成功註冊後呼叫）
export function registerIpDevice(ip: string, deviceId: string): void {
  const ipHash = hashIp(ip);
  const devices = ipDeviceRegistry.get(ipHash) ?? new Set<string>();
  devices.add(deviceId);
  ipDeviceRegistry.set(ipHash, devices);
}

// Rate Limiter Middleware
// 依照 RATE_LIMITS 設定，對每個端點套用滑動窗口限流
export function rateLimiter() {
  return async (c: Context, next: Next) => {
    const method = c.req.method;
    const path = c.req.path;
    // RATE_LIMITS key 格式：'METHOD /path'（空格分隔）
    const endpointKey = `${method} ${path}`;
    const config = RATE_LIMITS[endpointKey];

    // 此端點沒有設定 rate limit，直接放行
    if (!config) {
      return next();
    }

    const storeKey = getRateLimitKey(c, endpointKey);
    const now = Date.now();
    const windowMs = config.windowSeconds * 1000;

    maybeCleanup();

    const entry = rateLimitStore.get(storeKey);

    if (!entry || now - entry.windowStart >= windowMs) {
      // 新窗口開始
      rateLimitStore.set(storeKey, {
        count: 1,
        windowStart: now,
      });
    } else if (entry.count >= config.limit) {
      // 超過限制
      const windowResetTimestamp = Math.floor((entry.windowStart + windowMs) / 1000);
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);

      c.header('X-RateLimit-Limit', config.limit.toString());
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', windowResetTimestamp.toString());

      return c.json(
        {
          error: 'RATE_LIMIT_EXCEEDED',
          message: '請求太頻繁，請稍後再試',
          retry_after: retryAfter,
        },
        429,
      );
    } else {
      // 窗口內，計數 +1
      entry.count++;
    }

    // 設定 Rate Limit Headers（正常放行時也要帶）
    const currentEntry = rateLimitStore.get(storeKey)!;
    const remaining = Math.max(0, config.limit - currentEntry.count);
    const windowResetTimestamp = Math.floor(
      (currentEntry.windowStart + windowMs) / 1000,
    );

    c.header('X-RateLimit-Limit', config.limit.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', windowResetTimestamp.toString());

    return next();
  };
}

// 測試用：清空所有 rate limit 記錄
export function clearRateLimitStore(): void {
  rateLimitStore.clear();
}

// 測試用：清空 IP 裝置登記
export function clearIpDeviceRegistry(): void {
  ipDeviceRegistry.clear();
}
