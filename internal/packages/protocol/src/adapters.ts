// Adapter 型別 + 官方清單（SPEC-C §4.8 + 附錄 B）

// 21 個官方 Adapter（v0.1.11: +mistral, +cohere, +together, +fireworks, +perplexity, +xai）
export const OFFICIAL_ADAPTERS = [
  'groq',
  'gemini',
  'cerebras',
  'sambanova',
  'qwen',
  'ollama',
  'duckduckgo',
  'openai',
  'anthropic',
  'deepseek',
  'brave-search',
  'tavily',
  'serper',
  'openrouter',
  'deepl',
  'mistral',
  'cohere',
  'together',
  'fireworks',
  'perplexity',
  'xai',
] as const;

export type OfficialAdapterId = typeof OFFICIAL_ADAPTERS[number];

export interface AdapterUpdatesResponse {
  updates: Array<{
    adapter_id: string;
    current_version: string;
    latest_version: string;
    is_official: boolean;
    changelog: string;
    download_url: string;
    auto_update: boolean;
  }>;
  new_official_adapters: Array<{
    adapter_id: string;
    version: string;
    description: string;
    download_url: string;
  }>;
}

export interface AdapterListResponse {
  adapters: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    category: string;
    requires_key: boolean;
    free_tier: boolean;
    download_url: string;
  }>;
  last_updated: string;
}

// ===== Adapter 市集（Registry）型別 =====

/** 市集目錄（registry.json 格式） */
export interface RegistryCatalog {
  /** 目錄格式版本 */
  version: number;
  /** 最後更新時間（ISO 8601） */
  updated_at: string;
  /** 可用的社群 Adapter 清單 */
  adapters: RegistryAdapter[];
}

/** 市集中的一個 Adapter */
export interface RegistryAdapter {
  /** Adapter ID（如 'custom-llm'） */
  id: string;
  /** 顯示名稱 */
  name: string;
  /** 語意版本（如 '1.0.0'） */
  version: string;
  /** 作者（GitHub 帳號或暱稱） */
  author: string;
  /** 一句話描述 */
  description: string;
  /** 分類：llm / search / translate / image / audio / tool */
  category: string;
  /** 是否需要 API Key */
  requires_key: boolean;
  /** 是否有免費方案 */
  free_tier: boolean;
  /** YAML 下載 URL（GitHub raw） */
  yaml_url: string;
  /** 累計安裝次數 */
  downloads: number;
  /** 是否已通過官方驗證 */
  verified: boolean;
}

/** 版本更新資訊 */
export interface RegistryUpdateInfo {
  /** Adapter ID */
  id: string;
  /** 目前安裝的版本 */
  current_version: string;
  /** 市集最新版本 */
  latest_version: string;
}
