/**
 * Dr. Claw — 向量嵌入（簡化版）
 * 取代 washin-api 的 smart-embed（只保留 Voyage AI）
 *
 * washin-api 的 smart-embed 有 4 級 fallback（Voyage→Cohere→Gemini→Jina）
 * Dr. Claw 獨立後只用 Voyage AI（品質最強），失敗就回空
 */

import { createLogger } from './logger';
import { getKeyOrEnv } from './key-manager';

const log = createLogger('Embed');

const DEFAULT_DIMENSIONS = 1024;
const VOYAGE_MODEL = 'voyage-3';
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

/** 嵌入結果 */
export interface EmbedResult {
  embeddings: number[][];
  model: string;
  dimensions: number;
  source: string;
  inputCount: number;
}

/** 策略結果（帶 fallback 資訊） */
export interface EmbedStrategyResult {
  result: EmbedResult;
  sourcesTried: string[];
  fallbackUsed: boolean;
  fallbackChain: { provider: string; success: boolean; error?: string; responseTimeMs: number }[];
}

/**
 * 品質嵌入（Voyage AI）
 * 向後相容 washin-api 的 embedQuality() 介面
 */
export async function embedQuality(
  texts: string[],
  dimensions?: number,
  inputType?: string,
  _isFreeTier = false,
): Promise<EmbedStrategyResult> {
  const dims = dimensions ?? DEFAULT_DIMENSIONS;
  const iType = inputType ?? 'document';
  const fallbackChain: EmbedStrategyResult['fallbackChain'] = [];

  // 驗證輸入
  if (!texts || texts.length === 0) {
    return {
      result: { embeddings: [], model: 'none', dimensions: 0, source: 'none', inputCount: 0 },
      sourcesTried: [],
      fallbackUsed: false,
      fallbackChain: [],
    };
  }

  const validTexts = texts.slice(0, 128); // Voyage AI 最大批次 128

  const apiKey = getKeyOrEnv('voyageai', 'VOYAGE_API_KEY');
  if (!apiKey) {
    log.warn('缺少 VOYAGE_API_KEY，向量嵌入不可用');
    return {
      result: { embeddings: [], model: 'none', dimensions: 0, source: 'none', inputCount: validTexts.length },
      sourcesTried: ['voyageai'],
      fallbackUsed: false,
      fallbackChain: [{ provider: 'voyageai', success: false, error: 'no API key', responseTimeMs: 0 }],
    };
  }

  const t0 = Date.now();
  try {
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: validTexts,
        input_type: iType,
        output_dimension: dims,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Voyage API ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data = await res.json() as { data: { embedding: number[] }[] };
    const embeddings = data.data.map((d: { embedding: number[] }) => d.embedding);

    fallbackChain.push({ provider: 'voyageai', success: true, responseTimeMs: Date.now() - t0 });

    return {
      result: {
        embeddings,
        model: VOYAGE_MODEL,
        dimensions: dims,
        source: 'voyageai',
        inputCount: validTexts.length,
      },
      sourcesTried: ['voyageai'],
      fallbackUsed: false,
      fallbackChain,
    };
  } catch (err) {
    const elapsed = Date.now() - t0;
    log.warn(`Voyage AI 嵌入失敗 (${elapsed}ms): ${err}`);
    fallbackChain.push({ provider: 'voyageai', success: false, error: String(err).slice(0, 100), responseTimeMs: elapsed });

    return {
      result: { embeddings: [], model: 'none', dimensions: 0, source: 'none', inputCount: validTexts.length },
      sourcesTried: ['voyageai'],
      fallbackUsed: false,
      fallbackChain,
    };
  }
}
