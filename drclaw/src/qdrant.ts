/**
 * Dr. Claw — Qdrant 向量資料庫客戶端（精簡版）
 * 取代 washin-api 的 qdrant-client（只保留 3 個核心函式）
 */

import { createLogger } from './logger';
import { getEnv, getEnvNum } from './config';

const log = createLogger('Qdrant');

// 預設 Collection 名稱
const COLLECTION_NAME = 'debug_knowledge';
const DIMENSIONS = 1024;

// Qdrant 連線
let qdrantUrl = '';
let qdrantAvailable = false;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 60_000; // 60 秒檢查一次

/** 搜尋結果 */
export interface QdrantSearchResult {
  id: number | string;
  score: number;
  payload: Record<string, unknown>;
}

/** Qdrant HTTP 請求 */
async function qdrantFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!qdrantUrl) {
    qdrantUrl = getEnv('QDRANT_URL', 'http://localhost:6333');
  }
  const timeout = getEnvNum('QDRANT_TIMEOUT_MS', 5000);
  return fetch(`${qdrantUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(timeout),
  });
}

/** 健康檢查 */
async function checkHealth(): Promise<boolean> {
  try {
    const res = await qdrantFetch('/healthz');
    qdrantAvailable = res.ok;
    lastHealthCheck = Date.now();
    if (!qdrantAvailable) {
      log.warn('Qdrant 健康檢查失敗');
    }
    return qdrantAvailable;
  } catch {
    qdrantAvailable = false;
    lastHealthCheck = Date.now();
    return false;
  }
}

/**
 * 初始化 Qdrant Collection（啟動時呼叫）
 */
export async function initQdrant(): Promise<void> {
  const healthy = await checkHealth();
  if (!healthy) {
    log.warn('Qdrant 不可用，向量搜尋功能停用');
    return;
  }

  try {
    // 檢查 collection 是否存在
    const res = await qdrantFetch(`/collections/${COLLECTION_NAME}`);
    if (res.status === 404) {
      // 建立 collection
      const createRes = await qdrantFetch('/collections/' + COLLECTION_NAME, {
        method: 'PUT',
        body: JSON.stringify({
          vectors: { size: DIMENSIONS, distance: 'Cosine' },
        }),
      });
      if (createRes.ok) {
        log.info(`Qdrant collection '${COLLECTION_NAME}' 已建立 (${DIMENSIONS}d, Cosine)`);
      } else {
        log.warn(`建立 collection 失敗: ${await createRes.text()}`);
      }
    } else {
      log.info(`Qdrant collection '${COLLECTION_NAME}' 已存在`);
    }
  } catch (err) {
    log.warn(`Qdrant 初始化異常: ${err}`);
  }
}

/**
 * 檢查 Qdrant 是否可用（帶節流）
 */
export async function isQdrantReady(): Promise<boolean> {
  if (qdrantAvailable && Date.now() - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) {
    return true;
  }
  return await checkHealth();
}

/**
 * 寫入/更新向量
 */
export async function upsertVector(
  collection: string,
  id: number | string,
  vector: number[],
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  if (!qdrantAvailable) return false;

  try {
    const res = await qdrantFetch(`/collections/${collection}/points`, {
      method: 'PUT',
      body: JSON.stringify({
        points: [{
          id,
          vector,
          payload: { ...payload, _indexed_at: new Date().toISOString() },
        }],
      }),
    });
    if (!res.ok) {
      log.warn(`upsertVector 失敗 [${collection}] id=${id}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`upsertVector 異常 [${collection}]: ${err}`);
    return false;
  }
}

/**
 * 向量相似搜尋
 */
export async function searchSimilar(
  collection: string,
  vector: number[],
  limit: number = 3,
  scoreThreshold: number = 0.65,
  filter?: Record<string, unknown>,
): Promise<QdrantSearchResult[]> {
  if (!qdrantAvailable) return [];

  try {
    const body: Record<string, unknown> = {
      vector,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
    };
    if (filter) {
      body.filter = filter;
    }

    const res = await qdrantFetch(`/collections/${collection}/points/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`searchSimilar 失敗 [${collection}]: ${await res.text()}`);
      return [];
    }
    const data = await res.json() as { result: QdrantSearchResult[] };
    return data.result || [];
  } catch (err) {
    log.warn(`searchSimilar 異常 [${collection}]: ${err}`);
    return [];
  }
}
