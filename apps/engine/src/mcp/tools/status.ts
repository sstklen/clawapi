// MCP Tool: status — 查看引擎狀態
// 直接讀取引擎內部狀態

import { CLAWAPI_VERSION } from '@clawapi/protocol';
import type { KeyPool } from '../../core/key-pool';

// ===== 型別定義 =====

/** status tool 的輸入參數 */
export interface StatusToolInput {
  // 不需要參數
}

/** 引擎狀態（傳入 status tool 的依賴） */
export interface EngineStatusDeps {
  /** KeyPool 實例 */
  keyPool: KeyPool;
  /** 啟動時間 */
  startedAt: Date;
  /** 已載入的 Adapter 數量 */
  adapterCount: number;
  /** 引擎配置 */
  config?: {
    port: number;
    host: string;
  };
}

/** status tool 的 JSON Schema */
export const statusToolSchema = {
  name: 'status',
  description: '查看 ClawAPI 引擎的運行狀態',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

// ===== Tool 執行 =====

/**
 * 執行 status tool
 */
export async function executeStatusTool(
  _input: StatusToolInput,
  deps: EngineStatusDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const uptime = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
  const uptimeStr = formatUptime(uptime);

  // 取得 Key 統計
  const keys = await deps.keyPool.listKeys();
  const activeKeys = keys.filter(k => k.status === 'active').length;
  const deadKeys = keys.filter(k => k.status === 'dead').length;
  const services = new Set(keys.map(k => k.service_id));

  const lines = [
    `ClawAPI 引擎狀態`,
    `═══════════════════════`,
    `版本：${CLAWAPI_VERSION}`,
    `運行時間：${uptimeStr}`,
    ``,
    `Key 池：`,
    `  總計：${keys.length} 個 Key`,
    `  正常：${activeKeys}`,
    `  失效：${deadKeys}`,
    `  服務數：${services.size}`,
    ``,
    `Adapter 數：${deps.adapterCount}`,
  ];

  if (deps.config) {
    lines.push(``, `監聽位址：${deps.config.host}:${deps.config.port}`);
  }

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
}

/**
 * 格式化運行時間
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小時`);
  if (mins > 0) parts.push(`${mins} 分`);
  parts.push(`${secs} 秒`);

  return parts.join(' ');
}
