// 測試用認證工具
import type { AuthHeaders } from '@clawapi/protocol';
import { randomBytes } from 'crypto';

export function generateTestDeviceId(): string {
  return `clw_${randomBytes(16).toString('hex')}`;
}

export function generateTestToken(): string {
  return randomBytes(32).toString('hex');
}

export function createTestAuthHeaders(
  deviceId?: string,
  token?: string
): AuthHeaders {
  return {
    'X-Device-Id': deviceId ?? generateTestDeviceId(),
    'X-Device-Token': token ?? generateTestToken(),
    'X-Client-Version': '0.1.0',
  };
}
