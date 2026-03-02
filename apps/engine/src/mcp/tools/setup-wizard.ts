// MCP Tool: setup_wizard — 首次設定引導
// 掃描環境找 API Key → 驗證 → 匯入 → 產生 Gold Key
// 爽點 1 的入口：秒速上手

import type { KeyPool } from '../../core/key-pool';
import type { AdapterConfig } from '../../adapters/loader';
import type { SubKeyManager } from '../../sharing/sub-key';
import type { GrowthEngine } from '../../growth/engine';
import type { ClawDatabase } from '../../storage/database';
import type {
  EnvScanResult,
  FoundKey,
  KeyValidationResult,
  GoldKeySetupResult,
} from '../../growth/types';
import { SERVICE_RECOMMENDATIONS } from '../../growth/types';
import { scanEnvVars, detectOllama, fullScan } from '../../growth/env-scanner';
import { validateKey } from '../../growth/key-validator';
import { setupAutoGoldKey, getExistingGoldKey } from '../../growth/gold-key-setup';
import { checkTransition, getTeaser, formatTransitionBanner } from '../../growth/phase-relay';

// ===== 型別定義 =====

/** setup_wizard tool 的輸入參數 */
export interface SetupWizardToolInput {
  /** 動作類型（必填） */
  action: 'scan' | 'import' | 'validate' | 'gold' | 'auto';
  /** 服務 ID（import/validate 用） */
  service?: string;
  /** API Key 值（import 用） */
  key?: string;
}

/** setup_wizard 的依賴 */
export interface SetupWizardDeps {
  keyPool: KeyPool;
  adapters: Map<string, AdapterConfig>;
  subKeyManager?: SubKeyManager;
  /** 資料庫（可選，接力棒系統用） */
  db?: ClawDatabase;
  /** 成長引擎（可選，接力棒系統用） */
  growthEngine?: GrowthEngine;
}

/** setup_wizard tool 的 JSON Schema */
export const setupWizardToolSchema = {
  name: 'setup_wizard',
  description:
    '首次設定引導。當用戶剛安裝 ClawAPI、問「怎麼開始」、或 Key 池為空時，請主動呼叫此 tool。action=auto 會自動掃描環境找到 API Key、驗證有效性、匯入管理、產生萬用金鑰匙（Gold Key）。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['scan', 'import', 'validate', 'gold', 'auto'],
        description:
          '動作：scan=掃描環境、import=匯入 Key、validate=驗證 Key、gold=產生 Gold Key、auto=全自動',
      },
      service: {
        type: 'string',
        description: '服務 ID（如 openai, groq, gemini），import/validate 時使用',
      },
      key: {
        type: 'string',
        description: 'API Key 值，import 時使用',
      },
    },
    required: ['action'],
  },
};

// ===== Tool 執行 =====

/**
 * 執行 setup_wizard tool
 */
export async function executeSetupWizardTool(
  input: SetupWizardToolInput,
  deps: SetupWizardDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  switch (input.action) {
    case 'scan':
      return handleScan(deps);

    case 'import':
      return handleImport(input, deps);

    case 'validate':
      return handleValidate(input, deps);

    case 'gold':
      return handleGoldKey(deps);

    case 'auto':
      return handleAuto(deps);

    default:
      return {
        content: [
          {
            type: 'text',
            text: `不支援的動作：${input.action}。可用：scan, import, validate, gold, auto`,
          },
        ],
      };
  }
}

// ===== 各動作處理器 =====

/**
 * scan — 掃描環境，列出找到的 Key
 */
async function handleScan(
  deps: SetupWizardDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const result = await fullScan(deps.keyPool);
  return {
    content: [{ type: 'text', text: formatScanResult(result) }],
  };
}

/**
 * import — 驗證後匯入一把 Key
 */
async function handleImport(
  input: SetupWizardToolInput,
  deps: SetupWizardDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!input.service || !input.key) {
    return {
      content: [
        {
          type: 'text',
          text: '匯入需要指定 service（服務 ID）和 key（API Key 值）',
        },
      ],
    };
  }

  // 先驗證
  const validation = await validateKey(input.service, input.key, deps.adapters);

  if (!validation.valid) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Key 驗證失敗（${input.service}）：${validation.error ?? '未知錯誤'}\n\n請確認 Key 是否正確，或到對應平台重新取得。`,
        },
      ],
    };
  }

  // 驗證通過，匯入
  try {
    const id = await deps.keyPool.addKey(input.service, input.key, 'king');
    const modelInfo = validation.models_available?.length
      ? `\n可用模型：${validation.models_available.slice(0, 5).join(', ')}${validation.models_available.length > 5 ? '...' : ''}`
      : '';

    let text = `✅ 已匯入 ${input.service} 的 API Key（ID: ${id}）${modelInfo}\n\nKey 已加入 King 池，可開始使用。`;

    // 接力棒：偵測階段轉換
    if (deps.db && deps.growthEngine) {
      try {
        const currentPhase = await deps.growthEngine.getPhase();
        const transition = checkTransition(deps.db, currentPhase);
        if (transition) {
          text += formatTransitionBanner(transition);
        } else {
          const teaser = await getTeaser(currentPhase, deps.keyPool);
          if (teaser) {
            text += `\n\n${teaser}`;
          }
        }
      } catch {
        // 接力棒失敗不影響主功能
      }
    }

    // 爽點二：主動推薦下一個服務
    const recommendation = await getProactiveRecommendation(deps);
    if (recommendation) {
      text += `\n\n${recommendation}`;
    }

    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `匯入失敗：${(err as Error).message}`,
        },
      ],
    };
  }
}

/**
 * validate — 只驗證不匯入
 */
async function handleValidate(
  input: SetupWizardToolInput,
  deps: SetupWizardDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!input.service || !input.key) {
    return {
      content: [
        {
          type: 'text',
          text: '驗證需要指定 service（服務 ID）和 key（API Key 值）',
        },
      ],
    };
  }

  const validation = await validateKey(input.service, input.key, deps.adapters);

  if (validation.valid) {
    const modelInfo = validation.models_available?.length
      ? `\n可用模型：${validation.models_available.join(', ')}`
      : '';
    return {
      content: [
        {
          type: 'text',
          text: `✅ Key 有效（${input.service}）${modelInfo}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `❌ Key 無效（${input.service}）：${validation.error ?? '未知錯誤'}`,
      },
    ],
  };
}

/**
 * gold — 產生 Gold Key
 */
async function handleGoldKey(
  deps: SetupWizardDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!deps.subKeyManager) {
    return {
      content: [
        {
          type: 'text',
          text: '⚠️ Sub-Key 管理器未初始化，無法產生 Gold Key。請確認引擎已完整啟動。',
        },
      ],
    };
  }

  try {
    const result = await setupAutoGoldKey(deps.subKeyManager, deps.keyPool);
    return {
      content: [{ type: 'text', text: formatGoldKeyResult(result) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `產生 Gold Key 失敗：${(err as Error).message}`,
        },
      ],
    };
  }
}

/**
 * auto — 一鍵全自動：掃描 → 驗證 → 全部匯入 → 產生 Gold Key
 *
 * 爽點一的核心：用戶什麼都不用做，掃完直接全部搞定，
 * 最後給一把 Gold Key 告訴用戶「以後用這把就好」。
 */
async function handleAuto(
  deps: SetupWizardDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const lines: string[] = [];
  lines.push('🔑 一鍵自動設定');
  lines.push('═══════════════════════\n');

  // Step 1: 掃描環境
  lines.push('【Step 1】掃描環境...');
  const scanResult = await fullScan(deps.keyPool);

  const newKeys = scanResult.found_keys.filter(k => !k.already_managed);
  const managedKeys = scanResult.found_keys.filter(k => k.already_managed);

  if (managedKeys.length > 0) {
    lines.push(`  ✅ 已管理：${managedKeys.length} 把 Key`);
  }

  if (newKeys.length === 0 && !scanResult.ollama.detected) {
    lines.push('  ⚠️ 沒有找到新的 API Key。');
    lines.push('');
    lines.push('建議：');
    lines.push('  1. 到 https://console.groq.com/keys 免費申請 Groq Key');
    lines.push('  2. 到 https://aistudio.google.com/apikey 免費申請 Gemini Key');
    lines.push('  3. 設定環境變數後再跑一次 setup_wizard(action=auto)');

    // 如果已有管理的 Key 但沒新 Key，也推薦下一步
    if (managedKeys.length > 0) {
      const recommendation = await getProactiveRecommendation(deps);
      if (recommendation) {
        lines.push('');
        lines.push(recommendation);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // Step 2: 驗證找到的 Key
  const validKeys: Array<{ key: FoundKey; result: KeyValidationResult }> = [];
  if (newKeys.length > 0) {
    lines.push(`  🔑 找到 ${newKeys.length} 把新 Key\n`);

    lines.push('【Step 2】驗證...');
    for (const foundKey of newKeys) {
      const result = await validateKey(
        foundKey.service_id,
        foundKey.key_value,
        deps.adapters
      );

      const status = result.valid ? '✅' : '❌';
      const models = result.models_available?.length
        ? ` (${result.models_available.length} 模型)`
        : '';
      const error = result.error ? ` — ${result.error}` : '';
      lines.push(
        `  ${status} ${foundKey.service_id} [${foundKey.key_preview}]${models}${error}`
      );

      if (result.valid) {
        validKeys.push({ key: foundKey, result });
      }
    }
  }

  // Step 3: 全部匯入（不問用戶，直接做）
  const importedServices: string[] = [];
  if (validKeys.length > 0) {
    lines.push('');
    lines.push('【Step 3】匯入...');
    for (const { key } of validKeys) {
      try {
        const id = await deps.keyPool.addKey(key.service_id, key.key_value, 'king');
        lines.push(`  ✅ ${key.service_id} 已匯入（ID: ${id}）`);
        importedServices.push(key.service_id);
      } catch (err) {
        lines.push(`  ❌ ${key.service_id} 匯入失敗：${(err as Error).message}`);
      }
    }
  }

  // Ollama 資訊
  if (scanResult.ollama.detected) {
    lines.push('');
    lines.push(
      `  🦙 Ollama 已偵測（${scanResult.ollama.models.length} 個模型）`
    );
    if (scanResult.ollama.models.length > 0) {
      lines.push(
        `     模型：${scanResult.ollama.models.slice(0, 5).join(', ')}${scanResult.ollama.models.length > 5 ? '...' : ''}`
      );
    }
  }

  // Step 4: Gold Key（如果有 subKeyManager 且匯入了 Key 或已有 Key）
  let goldKeyToken: string | null = null;
  if (deps.subKeyManager) {
    const existingKeys = await deps.keyPool.listKeys();
    if (existingKeys.length > 0) {
      lines.push('');
      lines.push('【Step 4】Gold Key...');
      try {
        const goldResult = await setupAutoGoldKey(
          deps.subKeyManager,
          deps.keyPool
        );
        goldKeyToken = goldResult.token;
        const status = goldResult.is_new ? '🆕 新產生' : '✅ 已存在';
        lines.push(`  ${status} Gold Key: ${goldResult.token}`);
        lines.push(
          `  包含服務：${goldResult.services_included.join(', ')}`
        );
        lines.push('');
        lines.push(`  ${goldResult.usage_example}`);
      } catch (err) {
        lines.push(`  ⚠️ Gold Key 產生失敗：${(err as Error).message}`);
      }
    }
  }

  // === 結尾訊息 ===
  lines.push('');
  lines.push('═══════════════════════');

  if (importedServices.length > 0 && goldKeyToken) {
    // 最完美的情況：匯入了 Key + 有 Gold Key
    lines.push(`🎉 搞定！已匯入 ${importedServices.length} 把 Key。`);
    lines.push('以後只要用上面那把 Gold Key 就能通吃所有服務。');
    lines.push('不用記每個 API Key，ClawAPI 幫你自動管理和路由。');
  } else if (importedServices.length > 0) {
    // 匯入了 Key 但沒有 Gold Key
    lines.push(`🎉 搞定！已匯入 ${importedServices.length} 把 Key。`);
    lines.push('ClawAPI 開始幫你自動管理額度和路由。');
  } else if (managedKeys.length > 0) {
    // 沒有新 Key 但已有管理的 Key
    lines.push('✅ 你的 Key 都已在管理中，沒有新的需要匯入。');
  }

  // 爽點二：主動推薦下一個服務（不等用戶問）
  const recommendation = await getProactiveRecommendation(deps);
  if (recommendation) {
    lines.push('');
    lines.push(recommendation);
  }

  // 接力棒：偵測階段轉換
  if (deps.db && deps.growthEngine && importedServices.length > 0) {
    try {
      const currentPhase = await deps.growthEngine.getPhase();
      const transition = checkTransition(deps.db, currentPhase);
      if (transition) {
        lines.push(formatTransitionBanner(transition));
      }
    } catch {
      // 接力棒失敗不影響主功能
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ===== 格式化輔助 =====

/**
 * 格式化掃描結果
 */
function formatScanResult(result: EnvScanResult): string {
  const lines: string[] = [];
  lines.push('🔍 環境掃描結果');
  lines.push('═══════════════════════\n');

  if (result.found_keys.length === 0) {
    lines.push('沒有找到 API Key。\n');
    lines.push('你可以設定以下環境變數：');
    lines.push('  GROQ_API_KEY      → Groq（免費 + 超快）');
    lines.push('  GEMINI_API_KEY    → Google Gemini（免費 + 大上下文）');
    lines.push('  OPENAI_API_KEY    → OpenAI（GPT-4o）');
    lines.push('  ANTHROPIC_API_KEY → Anthropic（Claude 4）');
  } else {
    lines.push(`找到 ${result.found_keys.length} 把 API Key：\n`);

    for (const key of result.found_keys) {
      const managed = key.already_managed ? ' [已管理]' : ' [未管理]';
      lines.push(
        `  ${key.service_id.padEnd(12)} ${key.key_preview}  ← ${key.env_var}${managed}`
      );
    }
  }

  if (result.ollama.detected) {
    lines.push('');
    lines.push(`🦙 Ollama 偵測到（${result.ollama.url}）`);
    if (result.ollama.models.length > 0) {
      lines.push(`   模型：${result.ollama.models.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * 格式化 Gold Key 結果
 */
function formatGoldKeyResult(result: GoldKeySetupResult): string {
  const lines: string[] = [];
  const status = result.is_new ? '🆕 新產生' : '✅ 已存在';

  lines.push(`${status} Gold Key`);
  lines.push('═══════════════════════\n');
  lines.push(`Token：${result.token}`);
  lines.push(`包含服務：${result.services_included.join(', ')}`);
  lines.push('');
  lines.push('使用方式：');
  lines.push(`  ${result.usage_example}`);
  lines.push('');
  lines.push(
    '這把 Gold Key 可以存取所有已匯入的 API 服務。'
  );
  lines.push(
    '在 Claude Code 或其他 AI 工具中，把 base_url 指向 ClawAPI，用這把 Key 就能通吃所有服務。'
  );

  return lines.join('\n');
}

// ===== 爽點二：主動推薦 =====

/**
 * 取得主動推薦訊息（爽點二）
 * 根據用戶已有的服務，推薦最有價值的下一個免費/高CP服務
 * 包含具體的 signup URL 和解鎖什麼
 */
export async function getProactiveRecommendation(
  deps: { keyPool: KeyPool; growthEngine?: GrowthEngine }
): Promise<string | null> {
  try {
    const keys = await deps.keyPool.listKeys();
    const existingServices = new Set(keys.map(k => k.service_id));

    // 從推薦清單中找用戶還沒有的，優先免費的
    const nextService = SERVICE_RECOMMENDATIONS.find(
      item => !existingServices.has(item.service_id) && item.effort !== 'paid'
    );

    if (!nextService) return null;

    // 根據階段調整措辭
    const phase = deps.growthEngine ? await deps.growthEngine.getPhase() : null;
    const urgency = phase === 'awakening'
      ? '解鎖智慧路由'
      : phase === 'scaling'
        ? '進入群體智慧'
        : '加速成長';

    return `💡 下一步：加個 ${nextService.title} → ${urgency}\n` +
      `   ${nextService.reason}\n` +
      `   解鎖：${nextService.unlocks}\n` +
      `   申請：${nextService.signup_url}`;
  } catch {
    return null;
  }
}
