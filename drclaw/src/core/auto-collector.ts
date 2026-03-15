/**
 * Debug 醫生 — 自動收集器
 *
 * 從 L1/L2/L3/L4 各層 fire-and-forget 自動收集 debug 經驗
 * 包含防洪水（每日上限 100 筆/來源）和去重（同描述 1 小時內不重複）
 */

import { createLogger } from '../logger';
import { getDb } from '../database';
import { isFeatureEnabled } from '../config';
import { AUTO_COLLECT_DAILY_LIMIT, DEDUP_WINDOW_MS } from './constants';
import { contributeDebugKnowledge } from './kb-store';
import { incrementStat, autoCollectCounters } from './stats';
import type { DebugEntry } from './types';

const log = createLogger('AutoCollector');

/**
 * 自動收集 debug 知識（fire-and-forget，從 L1/L4/L3 呼叫）
 * - 每日上限 100 筆/來源
 * - 同服務+同錯誤碼 1 小時內不重複
 */
export async function autoContributeDebugKnowledge(entry: Partial<DebugEntry>): Promise<void> {
  if (!isFeatureEnabled('debug_ai')) return; // 功能關閉時不收集
  try {
    const source = entry.source || 'auto';
    const today = new Date().toISOString().slice(0, 10);

    // ── 防洪水：每日上限 + Map 清理 ──
    const counter = autoCollectCounters.get(source);
    if (counter && counter.date === today) {
      if (counter.count >= AUTO_COLLECT_DAILY_LIMIT) {
        return; // 今天這個來源已滿，靜默跳過
      }
      counter.count++;
    } else {
      // 清理過期 counter（跨日重置）+ 限制 Map 大小（防記憶體洩漏）
      if (autoCollectCounters.size > 100) {
        for (const [key, val] of autoCollectCounters) {
          if (val.date !== today) autoCollectCounters.delete(key);
        }
      }
      if (autoCollectCounters.size > 200) {
        log.warn('autoCollectCounters Map 超過硬上限 200，靜默丟棄');
        return;
      }
      autoCollectCounters.set(source, { count: 1, date: today });
    }

    // ── 去重：同描述 1 小時內不重複 ──
    const db = getDb();
    const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const existing = db.prepare(
      `SELECT id FROM debug_knowledge WHERE error_description = ? AND source = ? AND created_at > ? LIMIT 1`,
    ).get(entry.error_description || '', source, windowStart);

    if (existing) return; // 已有相同紀錄

    await contributeDebugKnowledge({
      ...entry,
      source,
      contributed_by: 'auto_collector',
      quality_score: entry.quality_score ?? 0.5, // 自動收集品質稍低
    });

    incrementStat('autoCollections');
  } catch (err: any) {
    log.warn(`autoContribute 靜默失敗: ${err?.message}`);
  }
}

// ============================================
// 通路追蹤：識別龍蝦從哪個通路進來
// ============================================

/**
 * 從 request body 或 header 提取通路來源
 * 優先順序：body.channel > header x-confucius-channel > 預設 'api'
 */
export function extractChannel(body: any, headers?: Record<string, string>): string {
  const ch = body?.channel
    || headers?.['x-confucius-channel']
    || 'api';
  // 白名單，防止任意值
  const valid = ['api', 'mcp_direct', 'mcp_registry', 'clawhub', 'github_action', 'npm', 'unknown'];
  return valid.includes(ch) ? ch : 'api';
}
