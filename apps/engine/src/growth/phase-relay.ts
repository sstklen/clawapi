// 四爽接力棒系統（Phase Transition Relay）
// 偵測成長階段變化，產出慶祝訊息和下一步提示
// 注入到 MCP 工具回應中，讓用戶感受到持續進步
// 支援三語（zh-TW / en / ja），透過 i18n fragment

import type { ClawDatabase } from '../storage/database';
import type { KeyPool } from '../core/key-pool';
import type { GrowthPhase } from './types';
import { getI18n } from '../core/i18n';

// ===== 型別定義 =====

/** 階段轉換結果 */
export interface TransitionResult {
  /** 舊階段 */
  from: GrowthPhase;
  /** 新階段 */
  to: GrowthPhase;
  /** 慶祝訊息（已翻譯） */
  celebration: string;
  /** 下一步提示（已翻譯） */
  next_hint: string;
}

// ===== 階段順序（用於判斷升級 vs 降級） =====

const PHASE_ORDER: Record<GrowthPhase, number> = {
  onboarding: 0,
  awakening: 1,
  scaling: 2,
  mastery: 3,
};

// ===== 核心函式 =====

/**
 * 安全取得翻譯（i18n 未初始化時不會爆炸）
 */
function t(key: string, params?: Record<string, string | number>): string {
  try {
    return getI18n().t(key, params);
  } catch {
    // i18n 未初始化（測試環境等），回傳 key 本身
    return key;
  }
}

/**
 * 檢查是否發生階段轉換
 * 讀 settings 表的 growth_last_phase，與當前階段比較
 * 第一次呼叫時初始化（不觸發慶祝）
 *
 * @returns TransitionResult 如果發生升級，null 如果沒變化
 */
export function checkTransition(
  db: ClawDatabase,
  currentPhase: GrowthPhase
): TransitionResult | null {
  // 讀取上次階段（含合法值驗證）
  const VALID_PHASES = new Set<string>(['onboarding', 'awakening', 'scaling', 'mastery']);
  let lastPhase: GrowthPhase | null = null;
  try {
    const rows = db.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'growth_last_phase'`
    );
    if (rows[0] && VALID_PHASES.has(rows[0].value)) {
      lastPhase = rows[0].value as GrowthPhase;
    } else if (rows[0]) {
      // DB 值不合法（手動改壞或版本遷移），重新初始化
      savePhase(db, currentPhase);
      return null;
    }
  } catch {
    // settings 表可能不存在，忽略
  }

  // 第一次：初始化並回傳 null（不觸發慶祝）
  if (lastPhase === null) {
    savePhase(db, currentPhase);
    return null;
  }

  // 沒有變化
  if (lastPhase === currentPhase) {
    return null;
  }

  // 只處理升級（降級不慶祝，只靜默更新）
  if (PHASE_ORDER[currentPhase] <= PHASE_ORDER[lastPhase]) {
    savePhase(db, currentPhase);
    return null;
  }

  // 升級了！
  savePhase(db, currentPhase);

  // 嘗試取得對應的慶祝訊息（i18n key: relay.celebrate.{from}_{to}）
  const celebKey = `relay.celebrate.${lastPhase}_${currentPhase}`;
  const hintKey = `relay.hint.${lastPhase}_${currentPhase}`;
  const celebration = t(celebKey);
  const hint = t(hintKey);

  // 如果 i18n 有翻譯（key 不等於回傳值 = 有翻譯）
  if (celebration !== celebKey) {
    return {
      from: lastPhase,
      to: currentPhase,
      celebration,
      next_hint: hint !== hintKey ? hint : 'growth_guide(view=overview)',
    };
  }

  // 跳級或 i18n 沒有對應的翻譯，用通用訊息
  const phaseName = t(`relay.phase.${currentPhase}`);
  return {
    from: lastPhase,
    to: currentPhase,
    celebration: t('relay.celebrate.generic', { phase: phaseName }),
    next_hint: t('relay.hint.generic'),
  };
}

/**
 * 取得 teaser 訊息（離下一階段還差多少）
 */
export async function getTeaser(
  currentPhase: GrowthPhase,
  keyPool: KeyPool
): Promise<string> {
  const keys = await keyPool.listKeys();
  const uniqueServices = new Set(keys.map(k => k.service_id));
  const serviceCount = uniqueServices.size;

  switch (currentPhase) {
    case 'onboarding':
      return t('relay.teaser.onboarding');

    case 'awakening': {
      // awakening = 1~2 個不同服務、沒有重複 Key
      // 升級到 scaling 有兩條路：加到 3 個服務 OR 同服務加第 2 把 Key
      const needed = 3 - serviceCount;
      return t('relay.teaser.awakening', { needed, current: serviceCount });
    }

    case 'scaling': {
      // scaling = 3+ 服務或有重複 Key，但 < 5 個不同服務
      const needed = 5 - serviceCount;
      return t('relay.teaser.scaling', { needed, current: serviceCount });
    }

    case 'mastery':
      return t('relay.teaser.mastery');

    default:
      return '';
  }
}

/**
 * 格式化轉換結果為 ASCII banner（用於注入 MCP 回應）
 */
export function formatTransitionBanner(result: TransitionResult): string {
  const nextLabel = t('relay.banner.next');
  const lines: string[] = [];
  lines.push('');
  lines.push('═══════════════════════');
  lines.push(result.celebration);
  lines.push(`${nextLabel}${result.next_hint}`);
  lines.push('═══════════════════════');
  return lines.join('\n');
}

// ===== 內部工具 =====

/** 儲存階段到 settings 表 */
function savePhase(db: ClawDatabase, phase: GrowthPhase): void {
  try {
    db.run(
      `INSERT OR REPLACE INTO settings (key, value, updated_at)
       VALUES ('growth_last_phase', ?, datetime('now'))`,
      [phase]
    );
  } catch {
    // 寫入失敗不影響主流程
  }
}
