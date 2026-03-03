// MCP Tool: setup_wizard — 首次設定引導
// 掃描環境找 API Key → 驗證 → 匯入 → 產生 Claw Key
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
  ClawKeySetupResult,
} from '../../growth/types';
import { SERVICE_RECOMMENDATIONS } from '../../growth/types';
import { scanEnvVars, detectOllama, fullScan } from '../../growth/env-scanner';
import { validateKey } from '../../growth/key-validator';
import { setupAutoClawKey, getExistingClawKey } from '../../growth/claw-key-setup';
import { checkTransition, getTeaser, formatTransitionBanner } from '../../growth/phase-relay';

// ===== 型別定義 =====

/** setup_wizard tool 的輸入參數 */
export interface SetupWizardToolInput {
  /** 動作類型（必填） */
  action: 'scan' | 'import' | 'validate' | 'gold' | 'claw-key' | 'auto';
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
    '首次設定引導。當用戶剛安裝 ClawAPI、問「怎麼開始」、或 Key 池為空時，請主動呼叫此 tool。action=auto 會自動掃描環境找到 API Key、驗證有效性、匯入管理、產生萬用 Claw Key。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['scan', 'import', 'validate', 'claw-key', 'gold', 'auto'],
        description:
          '動作：scan=掃描環境、import=匯入 Key、validate=驗證 Key、claw-key=產生 Claw Key、auto=全自動（gold 為舊名相容）',
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

    case 'claw-key':
    case 'gold':  // 向後相容舊名稱
      return handleClawKey(deps);

    case 'auto':
      return handleAuto(deps);

    default:
      return {
        content: [
          {
            type: 'text',
            text: `不支援的動作：${input.action}。可用：scan, import, validate, claw-key, auto`,
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
    // 查找對應服務的申請連結
    const rec = SERVICE_RECOMMENDATIONS.find(r => r.service_id === input.service);
    const signupHint = rec?.signup_url
      ? `\n\n→ 重新取得：${rec.signup_url}`
      : '\n\n請確認 Key 是否正確，或到對應平台重新取得。';
    return {
      content: [
        {
          type: 'text',
          text: `❌ Key 驗證失敗（${input.service}）：${validation.error ?? '未知錯誤'}${signupHint}`,
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
 * gold — 產生 Claw Key
 */
async function handleClawKey(
  deps: SetupWizardDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!deps.subKeyManager) {
    return {
      content: [
        {
          type: 'text',
          text: '⚠️ Sub-Key 管理器尚未就緒，無法產生 Claw Key。引擎初始化中，請稍後重試。',
        },
      ],
    };
  }

  try {
    const result = await setupAutoClawKey(deps.subKeyManager, deps.keyPool);
    return {
      content: [{ type: 'text', text: formatClawKeyResult(result) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `產生 Claw Key 失敗：${(err as Error).message}`,
        },
      ],
    };
  }
}

/**
 * auto — 一鍵全自動：掃描 → 驗證 → 全部匯入 → 產生 Claw Key
 *
 * 爽點一的核心：用戶什麼都不用做，掃完直接全部搞定，
 * 最後給一把 Claw Key 告訴用戶「以後用這把就好」。
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

      const statusIcon = result.valid ? '✅' : '❌';
      const models = result.models_available?.length
        ? ` (${result.models_available.length} 模型)`
        : '';
      const errorMsg = result.error ? ` — ${result.error}` : '';
      lines.push(
        `  ${statusIcon} ${foundKey.service_id} [${foundKey.key_preview}]${models}${errorMsg}`
      );

      // 爽點③ 碰壁引導：驗證失敗時告訴用戶下一步
      if (!result.valid) {
        const hint = getValidationFailHint(result.error ?? '', foundKey.service_id);
        if (hint) {
          lines.push(`     → ${hint}`);
        }
      }

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

  // Step 4: Claw Key（如果有 subKeyManager 且匯入了 Key 或已有 Key）
  let clawKeyToken: string | null = null;
  if (deps.subKeyManager) {
    const existingKeys = await deps.keyPool.listKeys();
    if (existingKeys.length > 0) {
      lines.push('');
      lines.push('【Step 4】產生 Claw Key（萬用鑰匙）...');
      try {
        const clawResult = await setupAutoClawKey(
          deps.subKeyManager,
          deps.keyPool
        );
        clawKeyToken = clawResult.token;
        // 爽點① 一鍵全自動的高潮：用明顯的框框顯示 Claw Key
        lines.push(...formatClawKeyBox(clawResult.token, clawResult.services_included));
      } catch (err) {
        lines.push(`  ⚠️ Claw Key 產生失敗：${(err as Error).message}`);
      }
    }
  }

  // === 結尾訊息：以四爽點為引導框架 ===
  lines.push('');
  lines.push('═══════════════════════');
  lines.push('🎉 設定完成！');
  lines.push('');

  // 爽點① 一鍵全自動
  if (importedServices.length > 0 && clawKeyToken) {
    lines.push(`✅ ① 一鍵全自動 — 已匯入 ${importedServices.length} 把 Key + Claw Key 已就緒`);
  } else if (importedServices.length > 0) {
    lines.push(`✅ ① 一鍵全自動 — 已匯入 ${importedServices.length} 把 Key`);
  } else if (managedKeys.length > 0) {
    lines.push(`✅ ① 一鍵全自動 — ${managedKeys.length} 把 Key 已在管理中`);
  }

  // 爽點② 主動推薦（用既有的 getProactiveRecommendation）
  const recommendation = await getProactiveRecommendation(deps);
  if (recommendation) {
    lines.push(`💡 ② 主動推薦 — ${recommendation}`);
  } else {
    lines.push('💡 ② 主動推薦 — 匯入後 ClawAPI 自動推薦下一個最值得加的服務');
  }

  // 爽點③ 碰壁引導
  lines.push('🛟 ③ 碰壁引導 — 額度用完時，ClawAPI 即時告訴你怎麼補');

  // 爽點④ 群體智慧
  lines.push('🌐 ④ 群體智慧 — 匿名路由數據共享，越多人用越聰明');

  // L2/L3/L4 指引和多 Key 輪換提示
  const totalKeys = importedServices.length + managedKeys.length;
  if (totalKeys > 0) {
    lines.push(...formatClawKeyGuide(totalKeys));
  }

  // 多人分發提示（爽點② 主動推薦的延伸）
  if (clawKeyToken) {
    lines.push('');
    lines.push('💡 想分享給朋友或團隊？');
    lines.push('   用 Sub-Key 分發：每把可設用量上限、有效期、隨時撤銷。');
    lines.push('   告訴我「幫我發一把 Sub-Key」即可。');
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
 * 格式化 Claw Key 結果
 */
function formatClawKeyResult(result: ClawKeySetupResult): string {
  const lines: string[] = [];
  const statusLabel = result.is_new ? '🆕 新產生' : '✅ 已存在';

  lines.push(`${statusLabel} Claw Key`);
  lines.push('═══════════════════════');

  // 用同樣的視覺框框顯示
  lines.push(...formatClawKeyBox(result.token, result.services_included));

  lines.push('');
  lines.push('在 Claude Code 或其他 AI 工具中，把 base_url 指向 ClawAPI，用這把 Key 就能通吃所有服務。');
  lines.push(...formatClawKeyGuide(result.services_included.length));

  return lines.join('\n');
}

/**
 * Claw Key 產生後的 L2/L3/L4 指引和多 Key 輪換提示
 * 讓用戶知道：
 *   1. 這把 Key 現在能做什麼（L2 智慧路由）
 *   2. 同一服務可以加多把 Key 輪換（突破額度限制）
 *   3. L3/L4 的進階可能
 */
function formatClawKeyGuide(serviceCount: number): string[] {
  const lines: string[] = [];

  lines.push('');
  lines.push('───── 你的 Claw Key 能做什麼 ─────');
  lines.push('');

  // L2: 智慧路由（只要 2+ 服務就自動啟用）
  if (serviceCount >= 2) {
    lines.push('🧠 L2 智慧路由（已啟用）');
    lines.push('   ClawAPI 自動選最佳服務回應，你不用管哪把 Key 對哪個 API。');
  } else {
    lines.push('🧠 L2 智慧路由（加第 2 個服務即解鎖）');
    lines.push('   多加一個免費服務（如 Groq），ClawAPI 就能自動選最佳路由。');
  }

  // 多 Key 輪換提示
  lines.push('');
  lines.push('🔄 額度翻倍秘訣');
  lines.push('   同一服務可以加 5 把 Key！額度不夠時 ClawAPI 自動輪換。');
  lines.push('   例：5 把 Gemini Key = 5 倍免費額度，用完一把自動跳下一把。');
  lines.push('   用 setup_wizard(action=import) 或 keys add 來加更多 Key。');

  // L3/L4 展望
  lines.push('');
  lines.push('🚀 進階架構（加更多 Key 解鎖）');
  lines.push('   L3 AI 管家 — 搜尋 + 翻譯 + LLM 串起來，一句話完成複雜任務');
  lines.push('   L4 任務引擎 — 多步驟自動化，例如「翻譯 + 摘要 + 寄信」一鍵搞定');
  lines.push('   Key 越多 → 路由越靈活 → 功能越強大');

  return lines;
}

// ===== 爽點三：碰壁引導（驗證失敗時的行動建議） =====

/**
 * 根據驗證失敗的錯誤訊息，給出具體的行動建議
 * 讓用戶不會卡住不知道怎麼辦
 */
function getValidationFailHint(error: string, serviceId: string): string | null {
  if (error.includes('405') || error.includes('Method Not Allowed')) {
    return `驗證端點不支援，但 Key 可能有效。試試：setup_wizard(action=import, service="${serviceId}", key="你的Key")`;
  }
  if (error.includes('不支援的服務') || error.includes('不支援')) {
    return '此版本尚不支援此服務，預計未來版本加入。';
  }
  if (error.includes('未提供可驗證端點') || error.includes('未提供')) {
    return `無法自動驗證，可手動匯入：setup_wizard(action=import, service="${serviceId}", key="你的Key")`;
  }
  return null;
}

/**
 * 格式化 Claw Key 的視覺區塊（明顯的框框，不會被文字淹沒）
 */
function formatClawKeyBox(token: string, servicesIncluded: string[]): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════╗');
  lines.push('║  🔑 你的 Claw Key（萬用鑰匙，請複製保存）           ║');
  lines.push('║                                                      ║');
  lines.push(`║  ${token}`);
  lines.push('║                                                      ║');
  lines.push('║  Base URL：http://localhost:4141/v1                  ║');
  lines.push(`║  包含服務：${servicesIncluded.join(', ')}`);
  lines.push('║  一把通吃所有已匯入的 API 服務                      ║');
  lines.push('╚══════════════════════════════════════════════════════╝');
  lines.push('（Claw Key = 萬用鑰匙，背後 ClawAPI 自動路由到最佳服務）');
  return lines;
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
