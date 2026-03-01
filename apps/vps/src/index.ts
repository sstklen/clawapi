// ClawAPI VPS 服務入口

export interface VPSOptions {
  port?: number;
  dbPath?: string;
}

export async function start(options?: VPSOptions): Promise<void> {
  // Phase 1+ 實作
  console.log(`ClawAPI VPS starting...`);
}
