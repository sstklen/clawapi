// ClawAPI 開源引擎入口

import type { CLAWAPI_VERSION } from '@clawapi/protocol';

export interface EngineOptions {
  port?: number;
  configPath?: string;
  dataDir?: string;
}

export async function start(options?: EngineOptions): Promise<void> {
  // Phase 1+ 實作
  console.log(`ClawAPI Engine starting...`);
}

export async function stop(): Promise<void> {
  // Phase 1+ 實作
  console.log(`ClawAPI Engine stopped.`);
}
