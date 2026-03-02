// 成長引導系統 — 共享型別定義
// 四爽點：秒速上手 → 路由覺醒 → 額度池 → 群體智慧
//
// 這個檔案是所有 growth 模組的「合約」，
// env-scanner / key-validator / gold-key-setup / engine 都要依賴

import type { KeyPool } from '../core/key-pool';
import type { AdapterConfig } from '../adapters/loader';

// ===== 成長階段 =====

/** 四個成長階段 */
export type GrowthPhase = 'onboarding' | 'awakening' | 'scaling' | 'mastery';

/** 成長階段的中文名稱（用於輸出） */
export const PHASE_NAMES: Record<GrowthPhase, string> = {
  onboarding: '秒速上手',
  awakening: '路由覺醒',
  scaling: '額度擴張',
  mastery: '群體智慧',
};

/** 成長階段的時間範圍描述 */
export const PHASE_DESCRIPTIONS: Record<GrowthPhase, string> = {
  onboarding: '加入第一把 API Key，開始使用',
  awakening: '加入更多 provider，解鎖智慧路由',
  scaling: '同家多把 Key，額度翻倍',
  mastery: '數據驅動，越用越聰明',
};

// ===== 成長狀態（統一輸出格式） =====

/** 成長引擎的完整狀態輸出 */
export interface GrowthState {
  /** 當前成長階段 */
  phase: GrowthPhase;
  /** 已解鎖的路由層 */
  layers_unlocked: string[];
  /** 各層解鎖進度（0.0 ~ 1.0） */
  layer_progress: Record<string, number>;
  /** 推薦的下一步動作 */
  next_actions: GrowthAction[];
  /** 額度池健康摘要 */
  pool_health: PoolHealthSummary;
}

// ===== 推薦動作 =====

/** 推薦動作的努力程度 */
export type EffortLevel = 'free' | 'signup' | 'paid';

/** 推薦動作的優先級 */
export type ActionPriority = 'high' | 'medium' | 'low';

/** 成長引擎推薦的一個具體動作 */
export interface GrowthAction {
  /** 優先級 */
  priority: ActionPriority;
  /** 動作 ID（程式用，如 'add_gemini_key'） */
  action_id: string;
  /** 動作標題（人話，如 '加 Google Gemini（免費！）'） */
  title: string;
  /** 為什麼推薦（如 '解鎖 100 萬 token 上下文'） */
  reason: string;
  /** 努力程度 */
  effort: EffortLevel;
  /** 申請 Key 的 URL（可選） */
  signup_url?: string;
  /** 解鎖什麼（如 '→ L2 進度 +20%'） */
  unlocks?: string;
}

/** 推薦路線偏好 */
export type RecommendRoute = 'free' | 'balanced' | 'full';

// ===== 環境掃描 =====

/** 環境掃描的完整結果 */
export interface EnvScanResult {
  /** 找到的 API Key 清單 */
  found_keys: FoundKey[];
  /** Ollama 偵測結果 */
  ollama: OllamaDetection;
}

/** 掃描到的一把 API Key */
export interface FoundKey {
  /** 服務 ID（如 'openai', 'anthropic'） */
  service_id: string;
  /** 來源環境變數名（如 'OPENAI_API_KEY'） */
  env_var: string;
  /** 遮罩後的 Key 預覽（如 'sk-****abcd'） */
  key_preview: string;
  /** 完整 Key 值（只在匯入時使用，不對外顯示） */
  key_value: string;
  /** 是否已在 KeyPool 中管理 */
  already_managed: boolean;
}

/** Ollama 偵測結果 */
export interface OllamaDetection {
  /** 是否偵測到 Ollama 在跑 */
  detected: boolean;
  /** 可用的模型清單 */
  models: string[];
  /** Ollama 的 URL */
  url: string;
}

// ===== Key 驗證 =====

/** Key 驗證結果 */
export interface KeyValidationResult {
  /** 是否有效 */
  valid: boolean;
  /** 服務 ID */
  service_id: string;
  /** 錯誤訊息（驗證失敗時） */
  error?: string;
  /** 可用模型清單（驗證成功時） */
  models_available?: string[];
}

// ===== Gold Key =====

/** Gold Key 設定結果 */
export interface GoldKeySetupResult {
  /** Gold Key Token（sk_live_xxx 格式） */
  token: string;
  /** 包含的服務清單 */
  services_included: string[];
  /** 使用範例 */
  usage_example: string;
  /** 是否是新產生的（false = 已存在的） */
  is_new: boolean;
}

// ===== 額度池健康 =====

/** 額度池健康摘要 */
export interface PoolHealthSummary {
  /** 各服務的 Key 池資訊 */
  services: ServicePoolInfo[];
  /** Key 總數 */
  total_keys: number;
  /** 服務總數 */
  total_services: number;
  /** 目前限速中的 Key 數 */
  rate_limited_count: number;
}

/** 單一服務的 Key 池資訊 */
export interface ServicePoolInfo {
  /** 服務 ID */
  service_id: string;
  /** 該服務的 Key 總數 */
  key_count: number;
  /** 正常的 Key 數 */
  active_count: number;
  /** 限速中的 Key 數 */
  rate_limited_count: number;
  /** 建議（如 '加第 2 把 Key 可翻倍額度'） */
  suggestion?: string;
}

// ===== 群體智慧（Phase 3） =====

/** 個人化建議 */
export interface PersonalizedSuggestion {
  /** 建議類型 */
  type: 'model_recommendation' | 'cost_saving' | 'quality_upgrade';
  /** 建議標題 */
  title: string;
  /** 建議詳情 */
  detail: string;
  /** 信心度（0.0 ~ 1.0） */
  confidence: number;
}

// ===== 環境變數 → 服務 ID 對照表 =====

/** 已知的環境變數 → 服務 ID 對照 */
export const ENV_KEY_MAP: ReadonlyArray<{ env_var: string; service_id: string }> = [
  { env_var: 'OPENAI_API_KEY', service_id: 'openai' },
  { env_var: 'ANTHROPIC_API_KEY', service_id: 'anthropic' },
  { env_var: 'GOOGLE_API_KEY', service_id: 'gemini' },
  { env_var: 'GEMINI_API_KEY', service_id: 'gemini' },
  { env_var: 'GROQ_API_KEY', service_id: 'groq' },
  { env_var: 'DEEPSEEK_API_KEY', service_id: 'deepseek' },
  { env_var: 'CEREBRAS_API_KEY', service_id: 'cerebras' },
  { env_var: 'SAMBANOVA_API_KEY', service_id: 'sambanova' },
  { env_var: 'QWEN_API_KEY', service_id: 'qwen' },
  { env_var: 'DASHSCOPE_API_KEY', service_id: 'qwen' },
  { env_var: 'OPENROUTER_API_KEY', service_id: 'openrouter' },
  { env_var: 'BRAVE_API_KEY', service_id: 'brave-search' },
  { env_var: 'TAVILY_API_KEY', service_id: 'tavily' },
  { env_var: 'SERPER_API_KEY', service_id: 'serper' },
  { env_var: 'DEEPL_API_KEY', service_id: 'deepl' },
];

/** LLM 類服務 ID（用於判斷 L3/L4 解鎖） */
export const LLM_SERVICES = new Set([
  'openai', 'anthropic', 'groq', 'gemini', 'deepseek',
  'cerebras', 'sambanova', 'qwen', 'openrouter', 'ollama',
]);

/** 搜尋類服務 ID */
export const SEARCH_SERVICES = new Set([
  'brave-search', 'tavily', 'serper', 'duckduckgo',
]);

/** 翻譯類服務 ID */
export const TRANSLATE_SERVICES = new Set([
  'deepl',
]);

// ===== 推薦服務資訊（三路線） =====

/** 服務推薦資訊 */
export interface ServiceRecommendation {
  service_id: string;
  title: string;
  reason: string;
  effort: EffortLevel;
  signup_url: string;
  routes: RecommendRoute[];
  /** 解鎖什麼路由功能 */
  unlocks: string;
}

/** 推薦服務清單（順序即優先級） */
export const SERVICE_RECOMMENDATIONS: ServiceRecommendation[] = [
  // === 免費路線 ===
  {
    service_id: 'groq',
    title: 'Groq（免費 + 超快）',
    reason: '免費額度、推論速度最快，適合日常對話',
    effort: 'signup',
    signup_url: 'https://console.groq.com/keys',
    routes: ['free', 'balanced', 'full'],
    unlocks: 'L1 直轉 + L2 智慧路由',
  },
  {
    service_id: 'gemini',
    title: 'Google Gemini（免費 + 大上下文）',
    reason: '免費額度大、100 萬 token 上下文窗口',
    effort: 'signup',
    signup_url: 'https://aistudio.google.com/apikey',
    routes: ['free', 'balanced', 'full'],
    unlocks: 'L2 智慧路由 + 長文處理',
  },
  {
    service_id: 'cerebras',
    title: 'Cerebras（免費 + 極速）',
    reason: '免費推論，速度極快（專用晶片）',
    effort: 'signup',
    signup_url: 'https://cloud.cerebras.ai/',
    routes: ['free', 'balanced', 'full'],
    unlocks: 'L2 多路由選項',
  },
  // === 性價比路線 ===
  {
    service_id: 'deepseek',
    title: 'DeepSeek（超便宜 + 強推理）',
    reason: '價格是 GPT-4 的 1/10，推理能力強',
    effort: 'signup',
    signup_url: 'https://platform.deepseek.com/',
    routes: ['balanced', 'full'],
    unlocks: 'L2 便宜路由',
  },
  {
    service_id: 'deepl',
    title: 'DeepL（免費 50 萬字/月）',
    reason: '專業翻譯品質，免費額度足夠日常使用',
    effort: 'signup',
    signup_url: 'https://www.deepl.com/pro#developer',
    routes: ['balanced', 'full'],
    unlocks: 'L4 任務引擎（翻譯步驟）',
  },
  {
    service_id: 'tavily',
    title: 'Tavily（免費 1000 次/月）',
    reason: 'AI 最佳化的搜尋 API，免費額度足夠',
    effort: 'signup',
    signup_url: 'https://tavily.com/',
    routes: ['balanced', 'full'],
    unlocks: 'L3 AI 管家 + L4 任務引擎',
  },
  // === 全開路線 ===
  {
    service_id: 'openai',
    title: 'OpenAI（GPT-4o + DALL·E）',
    reason: '最全面的 AI 生態系：對話、圖片、語音',
    effort: 'paid',
    signup_url: 'https://platform.openai.com/api-keys',
    routes: ['full'],
    unlocks: 'GPT-4o + 圖片生成 + 語音轉文字',
  },
  {
    service_id: 'anthropic',
    title: 'Anthropic（Claude 4）',
    reason: '最強推理能力，程式碼生成品質最高',
    effort: 'paid',
    signup_url: 'https://console.anthropic.com/',
    routes: ['full'],
    unlocks: '頂級推理 + 長上下文',
  },
  {
    service_id: 'brave-search',
    title: 'Brave Search API',
    reason: '隱私優先的搜尋 API，品質高',
    effort: 'paid',
    signup_url: 'https://brave.com/search/api/',
    routes: ['full'],
    unlocks: 'L3/L4 搜尋能力',
  },
];
