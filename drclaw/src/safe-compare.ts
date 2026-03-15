/**
 * 時序安全字串比對
 * 用 crypto.timingSafeEqual 防止計時攻擊
 */

import { timingSafeEqual } from 'crypto';

/**
 * 時序安全的字串比對（constant-time comparison）
 * 即使長度不同也不會洩漏長度資訊
 */
export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;

  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen, 0);
  const bufB = Buffer.alloc(maxLen, 0);
  bufA.write(a);
  bufB.write(b);

  const lengthMatch = a.length === b.length;
  return timingSafeEqual(bufA, bufB) && lengthMatch;
}
