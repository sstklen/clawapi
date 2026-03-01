// WebSocket 測試客戶端
import type { WSClientMessage, WSServerMessage } from '@clawapi/protocol';

export class TestWSClient {
  private messages: WSServerMessage[] = [];

  // Phase 1+ 實作
  async connect(url: string): Promise<void> {}
  async send(msg: WSClientMessage): Promise<void> {}
  async waitForMessage(timeoutMs?: number): Promise<WSServerMessage | null> { return null; }
  getMessages(): WSServerMessage[] { return [...this.messages]; }
  async close(): Promise<void> {}
}
