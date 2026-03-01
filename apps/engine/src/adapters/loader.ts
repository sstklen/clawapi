// Adapter 載入器模組
// 負責從 YAML 檔案載入、驗證 Adapter 設定

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import yaml from 'js-yaml';

// ===== 型別定義 =====

/** Endpoint 定義 */
export interface EndpointDef {
  /** HTTP 方法 */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** 路徑（附加到 base_url 後） */
  path: string;
  /** 請求體模板（含 {{ 變數 }}） */
  body?: Record<string, unknown>;
  /** 自訂 Headers */
  headers?: Record<string, string>;
  /** 回應格式 */
  response_type?: 'json' | 'sse' | 'text';
}

/** 模型定義 */
export interface ModelDef {
  id: string;
  name: string;
  context_window?: number;
  max_output_tokens?: number;
}

/** Adapter 完整設定 */
export interface AdapterConfig {
  schema_version: number;
  adapter: {
    id: string;
    name: string;
    version: string;
    category: string;
    requires_key: boolean;
    free_tier?: boolean;
  };
  auth: {
    type: 'none' | 'bearer' | 'header' | 'query_param';
    header_name?: string;
    query_param_name?: string;
    key_url?: string;
  };
  base_url: string;
  endpoints: Record<string, EndpointDef>;
  capabilities: {
    chat: boolean;
    streaming: boolean;
    embeddings: boolean;
    images: boolean;
    audio: boolean;
    models: ModelDef[];
  };
  rate_limits?: {
    requests_per_minute?: number;
    cooldown_on_429?: number;
  };
}

// ===== 驗證輔助函式 =====

/**
 * 確認某個欄位存在且類型正確
 * @throws 若欄位缺失或類型不符則拋出錯誤
 */
function assertField(obj: Record<string, unknown>, field: string, type: string): void {
  const val = obj[field];
  if (val === undefined || val === null) {
    throw new Error(`Adapter 設定缺少必填欄位：${field}`);
  }
  if (typeof val !== type) {
    throw new Error(`Adapter 設定欄位 ${field} 型別錯誤：期望 ${type}，實際 ${typeof val}`);
  }
}

// ===== AdapterLoader 主類別 =====

/**
 * Adapter 載入器
 * 支援從目錄批量載入或從單一檔案載入
 */
export class AdapterLoader {

  /**
   * 從目錄載入所有 YAML 檔案
   * @returns Map<adapterId, AdapterConfig>
   */
  async loadFromDirectory(dir: string): Promise<Map<string, AdapterConfig>> {
    const result = new Map<string, AdapterConfig>();

    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      throw new Error(`無法讀取 Adapter 目錄：${dir}`);
    }

    // 只處理 .yaml 和 .yml 檔案
    const yamlFiles = files.filter(f => ['.yaml', '.yml'].includes(extname(f)));

    for (const filename of yamlFiles) {
      const filepath = join(dir, filename);
      try {
        const config = await this.loadFromFile(filepath);
        result.set(config.adapter.id, config);
      } catch (err) {
        throw new Error(`載入 Adapter 失敗（${filename}）：${(err as Error).message}`);
      }
    }

    return result;
  }

  /**
   * 從單一 YAML 檔案載入
   */
  async loadFromFile(path: string): Promise<AdapterConfig> {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      throw new Error(`無法讀取 Adapter 檔案：${path}`);
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new Error(`YAML 解析失敗（${path}）：${(err as Error).message}`);
    }

    return this.validate(parsed);
  }

  /**
   * 驗證 Adapter 設定 schema
   * @throws 如果不合法則拋出含欄位名稱的錯誤
   */
  validate(config: unknown): AdapterConfig {
    if (!config || typeof config !== 'object') {
      throw new Error('Adapter 設定必須是物件');
    }

    const obj = config as Record<string, unknown>;

    // === schema_version ===
    if (typeof obj['schema_version'] !== 'number') {
      throw new Error('Adapter 設定缺少必填欄位：schema_version（應為數字）');
    }

    // === adapter 區塊 ===
    if (!obj['adapter'] || typeof obj['adapter'] !== 'object') {
      throw new Error('Adapter 設定缺少必填區塊：adapter');
    }
    const adapter = obj['adapter'] as Record<string, unknown>;
    assertField(adapter, 'id', 'string');
    assertField(adapter, 'name', 'string');
    assertField(adapter, 'version', 'string');
    assertField(adapter, 'category', 'string');
    if (typeof adapter['requires_key'] !== 'boolean') {
      throw new Error('Adapter 設定欄位 adapter.requires_key 必須是布林值');
    }

    // === auth 區塊 ===
    if (!obj['auth'] || typeof obj['auth'] !== 'object') {
      throw new Error('Adapter 設定缺少必填區塊：auth');
    }
    const auth = obj['auth'] as Record<string, unknown>;
    const validAuthTypes = ['none', 'bearer', 'header', 'query_param'];
    if (!validAuthTypes.includes(auth['type'] as string)) {
      throw new Error(
        `Adapter 設定 auth.type 不合法：${auth['type']}，應為 none | bearer | header | query_param`
      );
    }
    // header 類型需要 header_name
    if (auth['type'] === 'header' && !auth['header_name']) {
      throw new Error('auth.type 為 header 時，必須提供 auth.header_name');
    }

    // === base_url ===
    if (typeof obj['base_url'] !== 'string' || !obj['base_url']) {
      throw new Error('Adapter 設定缺少必填欄位：base_url');
    }

    // === endpoints ===
    if (!obj['endpoints'] || typeof obj['endpoints'] !== 'object') {
      throw new Error('Adapter 設定缺少必填區塊：endpoints');
    }
    const endpoints = obj['endpoints'] as Record<string, unknown>;
    for (const [name, ep] of Object.entries(endpoints)) {
      if (!ep || typeof ep !== 'object') {
        throw new Error(`Adapter endpoint ${name} 必須是物件`);
      }
      const epObj = ep as Record<string, unknown>;
      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
      if (!validMethods.includes(epObj['method'] as string)) {
        throw new Error(`Adapter endpoint ${name}.method 不合法：${epObj['method']}`);
      }
      if (typeof epObj['path'] !== 'string') {
        throw new Error(`Adapter endpoint ${name} 缺少 path`);
      }
    }

    // === capabilities ===
    if (!obj['capabilities'] || typeof obj['capabilities'] !== 'object') {
      throw new Error('Adapter 設定缺少必填區塊：capabilities');
    }
    const cap = obj['capabilities'] as Record<string, unknown>;
    for (const field of ['chat', 'streaming', 'embeddings', 'images', 'audio']) {
      if (typeof cap[field] !== 'boolean') {
        throw new Error(`Adapter capabilities.${field} 必須是布林值`);
      }
    }
    if (!Array.isArray(cap['models'])) {
      throw new Error('Adapter capabilities.models 必須是陣列');
    }

    // 通過所有驗證，強制轉型回傳
    return config as AdapterConfig;
  }
}
