/**
 * Debug 醫生 — Opus Relay 橋接
 *
 * 管理本機 Opus 4.6 的 WebSocket 連線
 * 所有 Opus Relay 狀態（ws、心跳、pending 請求）封裝在此模組內
 *
 * 生命週期（由 http-server.ts 呼叫）：
 *   WebSocket upgrade → handleRelayOpen → handleRelayMessage → handleRelayClose
 *
 * 分析流程（由 waterfall.ts / diagnosis-engine.ts 呼叫）：
 *   isOpusRelayOnline() → tryOpusRelay() → Promise<DebugAnalysis | null>
 */

import { createLogger } from '../logger';
import type { DebugAnalysis } from './types';

const log = createLogger('OpusBridge');

// ============================================
// 模組內部狀態（不 export，只透過函數操作）
// ============================================

/** 當前 Opus Relay WebSocket 實例 */
let opusRelayWs: any = null;
/** 最後心跳時間戳（ms） */
let opusRelayLastHeartbeat = 0;
/** 伺服器端主動 ping 定時器（穿透 Caddy/Cloudflare 保活） */
let opusRelayPingTimer: ReturnType<typeof setInterval> | null = null;

/** 等待 Opus 回覆的請求 Map */
const opusPendingRequests = new Map<string, {
  resolve: (analysis: DebugAnalysis) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// ============================================
// 狀態查詢
// ============================================

/** Relay 是否在線（60 秒內有心跳） */
export function isOpusRelayOnline(): boolean {
  return opusRelayWs !== null && (Date.now() - opusRelayLastHeartbeat) < 60000;
}

// ============================================
// WebSocket 生命週期（給 http-server.ts 用）
// ============================================

/** WebSocket 連線開啟 */
export function handleRelayOpen(ws: any): void {
  // 靜默替換：直接用新的，不踢舊的
  // 踢舊的會觸發 close→reconnect→又來一條→無限循環
  // 舊的會自然因為收不到心跳而超時斷掉
  if (opusRelayWs && opusRelayWs !== ws) {
    log.info('🔄 新 relay 取代舊連線');
  }

  opusRelayWs = ws;
  opusRelayLastHeartbeat = Date.now();

  // 伺服器端主動 ping（穿透 Caddy/Cloudflare 保活）
  if (opusRelayPingTimer) clearInterval(opusRelayPingTimer);
  opusRelayPingTimer = setInterval(() => {
    if (opusRelayWs) {
      try { opusRelayWs.ping(); } catch { /* 連線已斷，下次 close 會清理 */ }
    }
  }, 30000);

  log.info('🔗 Opus Relay 已連線！本機 Opus 上線');
}

/** WebSocket 連線關閉 */
export function handleRelayClose(closingWs: any): void {
  // 關鍵：只有「正在用的」那條連線斷了才清理
  // 如果是被踢掉的舊連線斷了，不影響新連線
  if (opusRelayWs !== null && opusRelayWs !== closingWs) {
    log.info('🔌 舊 relay 連線已關閉（不影響新連線）');
    return;
  }

  // 清理 ping timer
  if (opusRelayPingTimer) {
    clearInterval(opusRelayPingTimer);
    opusRelayPingTimer = null;
  }
  opusRelayWs = null;

  // 拒絕所有等待中的請求 → resolve(null) 讓瀑布降級
  for (const [id, pending] of opusPendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Opus Relay 斷線'));
    opusPendingRequests.delete(id);
  }
  log.info('🔌 Opus Relay 已斷線');
}

/** WebSocket 訊息處理 */
export function handleRelayMessage(data: string): void {
  try {
    const msg = JSON.parse(data);
    if (msg.type === 'heartbeat') {
      opusRelayLastHeartbeat = Date.now();
      opusRelayWs?.send(JSON.stringify({ type: 'heartbeat_ack' }));
      return;
    }
    if (msg.type === 'debug_response' && msg.id) {
      const pending = opusPendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        opusPendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.analysis);
        }
      }
      return;
    }
  } catch (err: any) {
    log.warn(`Relay 訊息解析失敗: ${err.message}`);
  }
}

// ============================================
// 分析請求（給 waterfall.ts / diagnosis-engine.ts 用）
// ============================================

/**
 * 嘗試透過本機 Opus Relay 分析（免費，品質最高）
 * 回傳 null 表示 Relay 不在線或超時（讓呼叫者降級到 Sonnet）
 */
export async function tryOpusRelay(
  errorDescription: string,
  errorMessage: string,
  environment: Record<string, any> = {},
  kbContext?: { text: string; entryIds: number[] },
): Promise<DebugAnalysis | null> {
  if (!isOpusRelayOnline()) return null;

  const requestId = `opus_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<DebugAnalysis | null>((resolve) => {
    // 90 秒超時（Opus 比 Sonnet 慢但更準）
    const timer = setTimeout(() => {
      opusPendingRequests.delete(requestId);
      log.warn('Opus Relay 超時 (90s)，fallback 到 Sonnet');
      resolve(null);
    }, 90000);

    opusPendingRequests.set(requestId, {
      resolve: (analysis) => resolve(analysis),
      reject: () => resolve(null), // reject 也 resolve(null) 讓瀑布降級
      timer,
    });

    // 發送請求給本機
    try {
      opusRelayWs.send(JSON.stringify({
        type: 'debug_request',
        id: requestId,
        error_description: errorDescription,
        error_message: errorMessage,
        environment,
        ...(kbContext ? { kb_context: kbContext.text, kb_entry_ids: kbContext.entryIds } : {}),
      }));
      log.info(`📡 已轉發給本機 Opus: ${requestId}`);
    } catch {
      clearTimeout(timer);
      opusPendingRequests.delete(requestId);
      resolve(null);
    }
  });
}
