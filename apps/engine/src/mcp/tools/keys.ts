// MCP Tool: keys_list + keys_add — API Key 池管理
// 直接呼叫 KeyPool 模組
// 加 Key 後自動偵測成長階段轉換，注入接力訊息

import type { KeyPool, KeyListItem } from '../../core/key-pool';
import type { GrowthEngine } from '../../growth/engine';
import type { ClawDatabase } from '../../storage/database';
import { SERVICE_RECOMMENDATIONS } from '../../growth/types';
import { checkTransition, getTeaser, formatTransitionBanner } from '../../growth/phase-relay';

// ===== 型別定義 =====

/** keys_list tool 的輸入參數 */
export interface KeysListToolInput {
  // 不需要參數
}

/** keys_add tool 的輸入參數 */
export interface KeysAddToolInput {
  /** 服務 ID（必填，如 'groq', 'openai', 'gemini'） */
  service: string;
  /** API Key 值（必填） */
  key: string;
  /** Key 池（king=自己的，friend=朋友的） */
  pool?: 'king' | 'friend';
  /** Key 標籤 */
  label?: string;
}

/** keys_list tool 的 JSON Schema */
export const keysListToolSchema = {
  name: 'keys_list',
  description: '列出所有 API Key 池狀態（Key 值已遮罩）',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

/** keys_add tool 的 JSON Schema */
export const keysAddToolSchema = {
  name: 'keys_add',
  description: '新增一個 API Key 到 Key 池',
  inputSchema: {
    type: 'object' as const,
    properties: {
      service: { type: 'string', description: '服務 ID（如 groq, openai, gemini）' },
      key: { type: 'string', description: 'API Key 值' },
      pool: {
        type: 'string',
        enum: ['king', 'friend'],
        description: 'Key 池類型（預設 king）',
      },
      label: { type: 'string', description: 'Key 標籤（備註用）' },
    },
    required: ['service', 'key'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 keys_list tool
 */
export async function executeKeysListTool(
  _input: KeysListToolInput,
  keyPool: KeyPool
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const keys = await keyPool.listKeys();

  if (keys.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'Key 池為空。使用 keys_add 來新增 API Key。',
      }],
    };
  }

  // 按服務分組
  const grouped = groupByService(keys);
  const lines: string[] = ['API Key 池狀態：\n'];

  for (const [serviceId, serviceKeys] of Object.entries(grouped)) {
    lines.push(`【${serviceId}】`);
    for (const k of serviceKeys) {
      const status = k.status === 'active' ? '正常' : k.status === 'rate_limited' ? '限速中' : '失效';
      const pool = k.pool_type === 'king' ? '自己' : '朋友';
      const label = k.label ? ` (${k.label})` : '';
      const pinned = k.pinned ? ' 📌' : '';
      lines.push(
        `  ${k.key_masked} [${pool}] ${status} | 今日用量: ${k.daily_used}${label}${pinned}`
      );
    }
    lines.push('');
  }

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
}

/** keys_add 的接力棒依賴（可選，向後相容） */
export interface KeysAddRelayDeps {
  db: ClawDatabase;
  growthEngine: GrowthEngine;
}

/**
 * 執行 keys_add tool
 * 成功後自動偵測成長階段轉換，注入慶祝或 teaser 訊息
 */
export async function executeKeysAddTool(
  input: KeysAddToolInput,
  keyPool: KeyPool,
  relayDeps?: KeysAddRelayDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const poolType = input.pool ?? 'king';

  try {
    const id = await keyPool.addKey(input.service, input.key, poolType, input.label);
    let text = `已新增 API Key（ID: ${id}）到 ${input.service} 的 ${poolType} 池。`;

    // 接力棒：偵測階段轉換
    if (relayDeps) {
      try {
        const currentPhase = await relayDeps.growthEngine.getPhase();
        const transition = checkTransition(relayDeps.db, currentPhase);

        if (transition) {
          // 升級了！加慶祝 banner
          text += formatTransitionBanner(transition);
        } else {
          // 沒升級，加 teaser（離下一階段還差多少）
          const teaser = await getTeaser(currentPhase, keyPool);
          if (teaser) {
            text += `\n\n${teaser}`;
          }
        }
      } catch {
        // 接力棒失敗不影響主功能
      }
    }

    // 爽點二：主動推薦下一個服務
    if (relayDeps) {
      try {
        const allKeys = await keyPool.listKeys();
        const existingServices = new Set(allKeys.map(k => k.service_id));
        const nextService = SERVICE_RECOMMENDATIONS.find(
          item => !existingServices.has(item.service_id) && item.effort !== 'paid'
        );
        if (nextService) {
          text += `\n\n💡 下一步：加個 ${nextService.title}\n`;
          text += `   ${nextService.reason}\n`;
          text += `   解鎖：${nextService.unlocks}\n`;
          text += `   申請：${nextService.signup_url}`;
        }
      } catch {
        // 推薦失敗不影響主功能
      }
    }

    return {
      content: [{
        type: 'text',
        text,
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `新增 API Key 失敗：${(err as Error).message}`,
      }],
    };
  }
}

/**
 * 按服務 ID 分組
 */
function groupByService(keys: KeyListItem[]): Record<string, KeyListItem[]> {
  const grouped: Record<string, KeyListItem[]> = {};
  for (const key of keys) {
    if (!grouped[key.service_id]) {
      grouped[key.service_id] = [];
    }
    grouped[key.service_id]!.push(key);
  }
  return grouped;
}
