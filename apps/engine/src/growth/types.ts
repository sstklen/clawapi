// 成長引導系統 — 共享型別定義
//
// 四爽點（體驗設計）：
//   1. 一鍵全自動 — handleAuto 掃描→驗證→全部匯入→Claw Key，用戶什麼都不用做
//   2. 主動推薦   — 加完 Key 後不等你問，直接推薦下一個免費服務
//   3. 碰限額引導 — 429 限速時，L1/L2 主動建議加 Key 翻倍額度
//   4. 群體智慧   — usage_log 記錄→匿名上報 VPS→routing_intel 回灌 L2 路由器
//
// 四成長階段（狀態機）：onboarding → awakening → scaling → mastery
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
  /** 顯示名稱（如 'OpenAI', 'Groq'） */
  display_name?: string;
  /** 服務分類 */
  category?: string;
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

// ===== Claw Key =====

/** Claw Key 設定結果 */
export interface ClawKeySetupResult {
  /** Claw Key Token（sk_live_xxx 格式） */
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

/** 環境變數 → 服務 ID 對照項目 */
export interface EnvKeyMapping {
  /** 環境變數名稱 */
  env_var: string;
  /** 對應的服務 ID */
  service_id: string;
  /** 服務分類（用於分組顯示） */
  category: 'llm' | 'search' | 'image' | 'audio' | 'embedding' | 'translate' | 'code' | 'tool';
  /** 顯示名稱（人話） */
  display_name: string;
  /** 是否有免費方案 */
  free_tier: boolean;
  /** 是否 OpenAI API 相容 */
  openai_compatible: boolean;
}

/** 已知的環境變數 → 服務 ID 對照（掃一片龍蝦，全部都對上） */
export const ENV_KEY_MAP: ReadonlyArray<EnvKeyMapping> = [
  // ===== LLM 提供商 =====
  { env_var: 'OPENAI_API_KEY',      service_id: 'openai',      category: 'llm', display_name: 'OpenAI',           free_tier: false, openai_compatible: true },
  { env_var: 'ANTHROPIC_API_KEY',   service_id: 'anthropic',   category: 'llm', display_name: 'Anthropic',        free_tier: false, openai_compatible: false },
  { env_var: 'GOOGLE_API_KEY',      service_id: 'gemini',      category: 'llm', display_name: 'Google Gemini',    free_tier: true,  openai_compatible: true },
  { env_var: 'GEMINI_API_KEY',      service_id: 'gemini',      category: 'llm', display_name: 'Google Gemini',    free_tier: true,  openai_compatible: true },
  { env_var: 'GROQ_API_KEY',        service_id: 'groq',        category: 'llm', display_name: 'Groq',             free_tier: true,  openai_compatible: true },
  { env_var: 'DEEPSEEK_API_KEY',    service_id: 'deepseek',    category: 'llm', display_name: 'DeepSeek',         free_tier: true,  openai_compatible: true },
  { env_var: 'CEREBRAS_API_KEY',    service_id: 'cerebras',    category: 'llm', display_name: 'Cerebras',         free_tier: true,  openai_compatible: true },
  { env_var: 'SAMBANOVA_API_KEY',   service_id: 'sambanova',   category: 'llm', display_name: 'SambaNova',        free_tier: true,  openai_compatible: true },
  { env_var: 'QWEN_API_KEY',        service_id: 'qwen',        category: 'llm', display_name: 'Qwen (阿里通義)',  free_tier: true,  openai_compatible: true },
  { env_var: 'DASHSCOPE_API_KEY',   service_id: 'qwen',        category: 'llm', display_name: 'Qwen (阿里通義)',  free_tier: true,  openai_compatible: true },
  { env_var: 'OPENROUTER_API_KEY',  service_id: 'openrouter',  category: 'llm', display_name: 'OpenRouter',       free_tier: true,  openai_compatible: true },
  { env_var: 'MISTRAL_API_KEY',     service_id: 'mistral',     category: 'llm', display_name: 'Mistral AI',       free_tier: true,  openai_compatible: true },
  { env_var: 'COHERE_API_KEY',      service_id: 'cohere',      category: 'llm', display_name: 'Cohere',           free_tier: true,  openai_compatible: true },
  { env_var: 'CO_API_KEY',          service_id: 'cohere',      category: 'llm', display_name: 'Cohere',           free_tier: true,  openai_compatible: true },
  { env_var: 'TOGETHER_API_KEY',    service_id: 'together',    category: 'llm', display_name: 'Together AI',      free_tier: true,  openai_compatible: true },
  { env_var: 'TOGETHERAI_API_KEY',  service_id: 'together',    category: 'llm', display_name: 'Together AI',      free_tier: true,  openai_compatible: true },
  { env_var: 'FIREWORKS_API_KEY',   service_id: 'fireworks',   category: 'llm', display_name: 'Fireworks AI',     free_tier: true,  openai_compatible: true },
  { env_var: 'PERPLEXITY_API_KEY',  service_id: 'perplexity',  category: 'llm', display_name: 'Perplexity',       free_tier: true,  openai_compatible: true },
  { env_var: 'PPLX_API_KEY',        service_id: 'perplexity',  category: 'llm', display_name: 'Perplexity',       free_tier: true,  openai_compatible: true },
  { env_var: 'XAI_API_KEY',         service_id: 'xai',         category: 'llm', display_name: 'xAI (Grok)',       free_tier: true,  openai_compatible: true },
  { env_var: 'AI21_API_KEY',        service_id: 'ai21',        category: 'llm', display_name: 'AI21 Labs',        free_tier: true,  openai_compatible: true },

  // ===== 中國 AI 提供商 =====
  { env_var: 'MOONSHOT_API_KEY',    service_id: 'moonshot',    category: 'llm', display_name: 'Moonshot (月之暗面)', free_tier: true, openai_compatible: true },
  { env_var: 'ZHIPU_API_KEY',       service_id: 'zhipu',       category: 'llm', display_name: 'Zhipu (智譜 GLM)',   free_tier: true, openai_compatible: true },
  { env_var: 'ZHIPUAI_API_KEY',     service_id: 'zhipu',       category: 'llm', display_name: 'Zhipu (智譜 GLM)',   free_tier: true, openai_compatible: true },
  { env_var: 'MINIMAX_API_KEY',     service_id: 'minimax',     category: 'llm', display_name: 'MiniMax',            free_tier: true, openai_compatible: true },
  { env_var: 'BAICHUAN_API_KEY',    service_id: 'baichuan',    category: 'llm', display_name: 'Baichuan (百川)',     free_tier: true, openai_compatible: true },
  { env_var: 'YI_API_KEY',          service_id: 'yi',          category: 'llm', display_name: 'Yi (零一萬物)',       free_tier: true, openai_compatible: true },

  // ===== 搜尋 API =====
  { env_var: 'BRAVE_API_KEY',       service_id: 'brave-search', category: 'search', display_name: 'Brave Search',   free_tier: true,  openai_compatible: false },
  { env_var: 'TAVILY_API_KEY',      service_id: 'tavily',       category: 'search', display_name: 'Tavily',         free_tier: true,  openai_compatible: false },
  { env_var: 'SERPER_API_KEY',      service_id: 'serper',       category: 'search', display_name: 'Serper',         free_tier: true,  openai_compatible: false },
  { env_var: 'SERPAPI_API_KEY',     service_id: 'serpapi',       category: 'search', display_name: 'SerpAPI',       free_tier: true,  openai_compatible: false },
  { env_var: 'EXA_API_KEY',         service_id: 'exa',           category: 'search', display_name: 'Exa',          free_tier: true,  openai_compatible: false },
  { env_var: 'JINA_API_KEY',        service_id: 'jina',          category: 'search', display_name: 'Jina AI',      free_tier: true,  openai_compatible: false },

  // ===== 翻譯 =====
  { env_var: 'DEEPL_API_KEY',       service_id: 'deepl',        category: 'translate', display_name: 'DeepL',       free_tier: true,  openai_compatible: false },

  // ===== 圖片生成 =====
  { env_var: 'STABILITY_API_KEY',   service_id: 'stability',    category: 'image', display_name: 'Stability AI',    free_tier: true,  openai_compatible: false },
  { env_var: 'REPLICATE_API_TOKEN', service_id: 'replicate',    category: 'image', display_name: 'Replicate',       free_tier: true,  openai_compatible: false },

  // ===== 語音 =====
  { env_var: 'ELEVENLABS_API_KEY',  service_id: 'elevenlabs',   category: 'audio', display_name: 'ElevenLabs',     free_tier: true,  openai_compatible: false },
  { env_var: 'ASSEMBLYAI_API_KEY',  service_id: 'assemblyai',   category: 'audio', display_name: 'AssemblyAI',     free_tier: true,  openai_compatible: false },

  // ===== Embedding =====
  { env_var: 'VOYAGE_API_KEY',          service_id: 'voyage',       category: 'embedding', display_name: 'Voyage AI',      free_tier: true,  openai_compatible: false },
  { env_var: 'HUGGINGFACE_API_KEY',     service_id: 'huggingface',  category: 'embedding', display_name: 'Hugging Face',   free_tier: true,  openai_compatible: false },
  { env_var: 'HUGGINGFACE_API_TOKEN',   service_id: 'huggingface',  category: 'embedding', display_name: 'Hugging Face',   free_tier: true,  openai_compatible: false },
  { env_var: 'HF_TOKEN',               service_id: 'huggingface',  category: 'embedding', display_name: 'Hugging Face',   free_tier: true,  openai_compatible: false },
];

/** LLM 類服務 ID（用於判斷 L3/L4 解鎖） */
export const LLM_SERVICES = new Set([
  'openai', 'anthropic', 'groq', 'gemini', 'deepseek',
  'cerebras', 'sambanova', 'qwen', 'openrouter', 'ollama',
  'mistral', 'cohere', 'together', 'fireworks', 'perplexity',
  'xai', 'ai21', 'moonshot', 'zhipu', 'minimax', 'baichuan', 'yi',
]);

/** 搜尋類服務 ID */
export const SEARCH_SERVICES = new Set([
  'brave-search', 'tavily', 'serper', 'duckduckgo',
  'serpapi', 'exa', 'jina',
]);

/** 翻譯類服務 ID */
export const TRANSLATE_SERVICES = new Set([
  'deepl',
]);

/** 圖片類服務 ID */
export const IMAGE_SERVICES = new Set([
  'stability', 'replicate',
]);

/** 語音類服務 ID */
export const AUDIO_SERVICES = new Set([
  'elevenlabs', 'assemblyai',
]);

/** Embedding 類服務 ID */
export const EMBEDDING_SERVICES = new Set([
  'voyage', 'huggingface', 'jina', 'cohere',
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
