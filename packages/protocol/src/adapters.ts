// Adapter 型別 + 官方清單（SPEC-C §4.8 + 附錄 B）

// 15 個官方 Adapter
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
