// Router — 路由主控
// 解析 model 欄位，判斷走哪一層（L1/L2/L3/L4）
// L3（ask）和 L4（task）均已實作

import type { KeyPool } from './key-pool';
import type { AdapterExecutor } from '../adapters/executor';
import type { AdapterConfig } from '../adapters/loader';
import type { L0Manager } from '../l0/manager';
import type { RoutingStrategy } from '@clawapi/protocol';
import { L1Proxy } from '../layers/l1-proxy';
import { L2Gateway } from '../layers/l2-gateway';
import { L3Concierge } from '../layers/l3-concierge';
import { L4TaskEngine } from '../layers/l4-task';
import { getDatabase } from '../storage/database';

// ===== 型別定義 =====

/** Router 的路由層決定 */
export type RoutingLayer = 'L1' | 'L2' | 'L3' | 'L4';

/** 傳入 Router 的請求 */
export interface RouteRequest {
  /** model 欄位（決定走哪一層） */
  model: string;
  /** 路由策略（L2 適用） */
  strategy?: RoutingStrategy;
  /** 轉發給後端的參數 */
  params: Record<string, unknown>;
}

/** Router 的統一回應 */
export interface RouteResult {
  /** 是否成功 */
  success: boolean;
  /** 走的哪一層 */
  layer: RoutingLayer;
  /** 實際使用的服務 ID */
  serviceId?: string;
  /** 實際使用的模型名稱 */
  modelName?: string;
  /** 後端回應資料 */
  data?: unknown;
  /** 錯誤訊息 */
  error?: string;
  /** HTTP 狀態碼 */
  status?: number;
  /** 延遲時間（ms） */
  latency_ms: number;
  /** Failover 時嘗試過的服務清單（L2 適用） */
  tried?: string[];
}

// ===== 已知模型名稱清單 =====

/**
 * 已知的知名模型名稱
 * 這些名稱在 model 欄位中不含 '/'，但應視為 L2 路由（智慧選服務）
 * 例：'gpt-4o'、'claude-3-5-sonnet'、'gemini-2-flash'
 */
const KNOWN_MODELS = new Set([
  // OpenAI 系列
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1',
  'o1-mini',
  // Anthropic 系列
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-opus',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  // Google 系列
  'gemini-2-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  // Meta 系列
  'llama3',
  'llama-3.1-8b',
  'llama-3.1-70b',
  // Mistral 系列
  'mistral-large',
  'mistral-medium',
  'mixtral-8x7b',
  // 其他
  'deepseek-v3',
  'qwen-72b',
]);

// ===== 路由判斷函式 =====

/**
 * 根據 model 欄位決定路由層
 *
 * 判斷邏輯：
 * - 含 '/' → L1（如 'groq/llama3'，直轉）
 * - 等於 'auto' → L2（智慧路由）
 * - 等於 'ask' → L3（AI 管家，stub）
 * - 等於 'task' → L4（任務引擎，stub）
 * - 已知模型名稱 → L2（讓智慧路由找最佳服務）
 * - 其他（未知名稱）→ L2（預設）
 */
export function determineLayer(model: string): RoutingLayer {
  // 含斜線 → L1 直轉
  if (model.includes('/')) return 'L1';

  // 特殊關鍵字
  if (model === 'auto') return 'L2';
  if (model === 'ask') return 'L3';
  if (model === 'task') return 'L4';

  // 已知模型名稱 → L2（智慧路由選服務）
  if (isKnownModel(model)) return 'L2';

  // 預設 → L2
  return 'L2';
}

/**
 * 判斷是否為已知模型名稱（不含服務前綴）
 */
export function isKnownModel(model: string): boolean {
  return KNOWN_MODELS.has(model);
}

// ===== Router 主類別 =====

/**
 * Router：路由主控
 *
 * 建構時注入依賴，routeRequest 決定走哪一層後分派
 * L3/L4 目前為 stub（throw 尚未實作）
 */
export class Router {
  private readonly l1: L1Proxy;
  private readonly l2: L2Gateway;
  private readonly l3: L3Concierge;
  private readonly l4: L4TaskEngine;

  constructor(
    keyPool: KeyPool,
    executor: AdapterExecutor,
    adapters: Map<string, AdapterConfig>,
    /** L0 Manager（目前作為 KeyPool 的 fallback，stub 不在 Router 直接呼叫） */
    _l0Manager: L0Manager
  ) {
    this.l1 = new L1Proxy(keyPool, executor, adapters);
    this.l2 = new L2Gateway(keyPool, executor, adapters);
    // L3 AI 管家：依賴 KeyPool、Executor、Adapters、L2Gateway
    this.l3 = new L3Concierge(keyPool, executor, adapters, this.l2);
    // L4 任務引擎：依賴 KeyPool、Executor、Adapters、L2Gateway、Database
    this.l4 = new L4TaskEngine(keyPool, executor, adapters, this.l2, getDatabase());
  }

  /**
   * 路由請求的主入口
   *
   * @param req 包含 model、strategy、params 的請求物件
   * @returns 統一格式的路由結果
   */
  async routeRequest(req: RouteRequest): Promise<RouteResult> {
    const layer = determineLayer(req.model);

    switch (layer) {
      case 'L1':
        return this.handleL1(req);

      case 'L2':
        return this.handleL2(req);

      case 'L3':
        return this.handleL3(req);

      case 'L4':
        return this.handleL4(req);
    }
  }

  // ===== 各層處理器 =====

  /**
   * 處理 L1 直轉請求
   * 解析 'service_id/model_name' 格式後交給 L1Proxy
   */
  private async handleL1(req: RouteRequest): Promise<RouteResult> {
    const result = await this.l1.execute({
      model: req.model,
      params: req.params,
    });

    return {
      success: result.success,
      layer: 'L1',
      serviceId: result.serviceId || undefined,
      modelName: result.modelName || undefined,
      data: result.data,
      error: result.error,
      status: result.status,
      latency_ms: result.latency_ms,
    };
  }

  /**
   * 處理 L2 智慧路由請求
   * 交給 L2Gateway，支援三種策略 + Failover
   */
  private async handleL2(req: RouteRequest): Promise<RouteResult> {
    const result = await this.l2.execute({
      model: req.model,
      strategy: req.strategy ?? 'smart',
      params: req.params,
    });

    return {
      success: result.success,
      layer: 'L2',
      serviceId: result.serviceId,
      modelName: result.modelName,
      data: result.data,
      error: result.error,
      status: result.status,
      latency_ms: result.latency_ms,
      tried: result.tried,
    };
  }

  /**
   * 處理 L3 AI 管家請求
   * 轉交給 L3Concierge 處理意圖解讀、步驟執行、結果整合
   */
  private async handleL3(req: RouteRequest): Promise<RouteResult> {
    // 將 params 中的 messages 轉為 L3 格式
    const messages = req.params['messages'] as Array<{ role: string; content: string }> | undefined;

    const l3Result = await this.l3.execute({
      messages: messages ?? [],
      params: req.params,
    });

    return {
      success: l3Result.success,
      layer: 'L3',
      data: l3Result.answer ?? l3Result.clarification,
      error: l3Result.error,
      latency_ms: l3Result.latency_ms,
    };
  }

  /**
   * 處理 L4 任務引擎請求
   * 轉交給 L4TaskEngine 處理 DAG 任務規劃、並行執行、斷點續作
   */
  private async handleL4(req: RouteRequest): Promise<RouteResult> {
    // 將 params 中的 messages 轉為 L4 格式
    const messages = req.params['messages'] as Array<{ role: string; content: string }> | undefined;

    const l4Result = await this.l4.execute({
      messages: messages ?? [],
      params: req.params,
    });

    return {
      success: l4Result.success,
      layer: 'L4',
      data: l4Result.answer ?? l4Result.cost_estimate,
      error: l4Result.error,
      latency_ms: l4Result.latency_ms,
    };
  }

  /**
   * 更新集體智慧數據（VPS 推送時呼叫）
   * 轉發給 L2Gateway
   */
  updateCollectiveIntel(intel: Record<string, unknown> | null): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.l2.updateCollectiveIntel(intel as any);
  }
}
