// L1 Proxy — 直轉路由層
// 解析 'service_id/model_name' 格式，直接從對應服務 Key 池選 Key 並執行請求
// 不跨服務 Failover，同服務多 Key 輪流重試（每把試一次）

import type { KeyPool, DecryptedKey } from '../core/key-pool';
import type { AdapterExecutor, AdapterResponse } from '../adapters/executor';
import type { AdapterConfig } from '../adapters/loader';

// ===== 型別定義 =====

/** L1 Proxy 請求參數 */
export interface L1Request {
  /** 原始 model 欄位，格式：'service_id/model_name'（如 'groq/llama3'） */
  model: string;
  /** 轉發給後端的參數（含 messages、temperature 等） */
  params: Record<string, unknown>;
}

/** L1 Proxy 回應 */
export interface L1Response {
  /** 是否成功 */
  success: boolean;
  /** 實際使用的服務 ID */
  serviceId: string;
  /** 實際使用的模型名稱 */
  modelName: string;
  /** 後端回應資料 */
  data?: unknown;
  /** 錯誤訊息 */
  error?: string;
  /** HTTP 狀態碼 */
  status?: number;
  /** 延遲時間（ms） */
  latency_ms: number;
  /** 嘗試的 Key 數量 */
  keysAttempted: number;
}

// ===== L1Proxy 主類別 =====

/**
 * L1 Proxy：直轉路由層
 *
 * 流程：
 * 1. 解析 model 欄位：'groq/llama3' → serviceId='groq', modelName='llama3'
 * 2. 從 KeyPool 取得所有可用 Key
 * 3. 依 Round-Robin 順序逐一嘗試（每把試一次）
 * 4. 任一成功 → 回傳
 * 5. 全部失敗 → 回傳友善錯誤（含已嘗試的 Key 數量）
 *
 * 注意：L1 不跨服務 Failover，只在同一服務的多個 Key 間重試
 */
export class L1Proxy {
  constructor(
    private readonly keyPool: KeyPool,
    private readonly executor: AdapterExecutor,
    /** Adapter 設定 Map（adapterId → AdapterConfig） */
    private readonly adapters: Map<string, AdapterConfig>
  ) {}

  /**
   * 執行 L1 直轉請求
   *
   * @param req L1 請求物件
   * @returns L1 回應（含成功/失敗資訊）
   */
  async execute(req: L1Request): Promise<L1Response> {
    const startTime = Date.now();

    // === 解析 model 欄位 ===
    const parsed = this.parseModel(req.model);
    if (!parsed) {
      return {
        success: false,
        serviceId: '',
        modelName: '',
        error: `model 格式錯誤：'${req.model}'，L1 需要 'service_id/model_name' 格式`,
        latency_ms: Date.now() - startTime,
        keysAttempted: 0,
      };
    }
    const { serviceId, modelName } = parsed;

    // === 找 Adapter 設定 ===
    const adapter = this.adapters.get(serviceId);
    if (!adapter) {
      return {
        success: false,
        serviceId,
        modelName,
        error: `找不到服務 '${serviceId}' 的 Adapter，請確認 Adapter 已正確載入`,
        latency_ms: Date.now() - startTime,
        keysAttempted: 0,
      };
    }

    // === 取得所有可用 Key ===
    const availableKeys = await this.getAllAvailableKeys(serviceId);

    if (availableKeys.length === 0) {
      return {
        success: false,
        serviceId,
        modelName,
        error: `服務 '${serviceId}' 沒有可用的 API Key，請新增或檢查現有 Key 的狀態`,
        latency_ms: Date.now() - startTime,
        keysAttempted: 0,
      };
    }

    // === 逐一嘗試每把 Key ===
    let keysAttempted = 0;
    let lastError: string = '';
    let lastStatus: number | undefined;

    // 構建包含 model 的請求參數
    const requestParams: Record<string, unknown> = {
      ...req.params,
      model: modelName,
    };

    for (const key of availableKeys) {
      keysAttempted++;

      // 動態選擇 endpoint：search tool 傳 type='search'，其餘預設 'chat'
      const requestType = req.params?.type as string | undefined;
      const endpointName = (requestType && adapter.endpoints[requestType])
        ? requestType
        : adapter.endpoints['chat'] ? 'chat' : Object.keys(adapter.endpoints)[0] ?? 'chat';

      const result = await this.executor.execute(
        adapter,
        endpointName,
        requestParams,
        key
      );

      if (result.success) {
        // 成功，直接回傳
        return {
          success: true,
          serviceId,
          modelName,
          data: result.data,
          status: result.status,
          latency_ms: Date.now() - startTime,
          keysAttempted,
        };
      }

      // 記錄錯誤後繼續嘗試下一把 Key
      lastError = result.error ?? `HTTP ${result.status}`;
      lastStatus = result.status;

      // 401/403：Key 已標記 dead，繼續嘗試其他 Key
      // 429：Key 已標記 rate_limited，繼續嘗試其他 Key
      // 5xx：consecutive_failures++，繼續嘗試其他 Key
    }

    // === 所有 Key 都嘗試過，全部失敗 ===
    let errorMsg = `服務 '${serviceId}' 所有 ${keysAttempted} 個 Key 均嘗試失敗，最後錯誤：${lastError}`;

    // 爽點三：碰限額時建議加 Key
    if (lastStatus === 429) {
      const totalKeys = await this.keyPool.listKeys(serviceId);
      const keyCount = totalKeys.length;
      if (keyCount <= 2) {
        errorMsg += `\n\n💡 ${serviceId} 只有 ${keyCount} 把 Key，加更多可以翻倍額度、減少限速。`;
        errorMsg += `\n   使用 keys_add(service=${serviceId}, key=YOUR_KEY) 新增。`;
      }
    }

    return {
      success: false,
      serviceId,
      modelName,
      error: errorMsg,
      status: lastStatus,
      latency_ms: Date.now() - startTime,
      keysAttempted,
    };
  }

  // ===== 輔助方法 =====

  /**
   * 解析 model 欄位
   * 格式：'service_id/model_name'
   * 例：'groq/llama3' → { serviceId: 'groq', modelName: 'llama3' }
   * 例：'openai/gpt-4o' → { serviceId: 'openai', modelName: 'gpt-4o' }
   *
   * @returns null 若格式不正確
   */
  parseModel(model: string): { serviceId: string; modelName: string } | null {
    const slashIndex = model.indexOf('/');
    if (slashIndex < 0) return null;

    const serviceId = model.substring(0, slashIndex).trim();
    const modelName = model.substring(slashIndex + 1).trim();

    if (!serviceId || !modelName) return null;

    return { serviceId, modelName };
  }

  /**
   * 取得某服務所有可用的 Key（非 dead、冷卻結束）
   * 為了讓每把 Key 都能嘗試到，不透過 RoundRobin 的 selectKey，
   * 直接從 Pool 取全量可用 Key
   */
  private async getAllAvailableKeys(serviceId: string): Promise<DecryptedKey[]> {
    const keys: DecryptedKey[] = [];

    // 使用 selectKey 輪流取，直到取到重複的為止
    // 方法：連續呼叫 selectKey，最多取 100 次（避免無窮迴圈）
    // 當取到已見過的 Key 時停止
    const seenIds = new Set<number>();
    const MAX_ATTEMPTS = 100;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const key = await this.keyPool.selectKey(serviceId);
      if (!key) break;
      if (seenIds.has(key.id)) break;  // 輪了一圈，停止
      seenIds.add(key.id);
      keys.push(key);
    }

    return keys;
  }
}
