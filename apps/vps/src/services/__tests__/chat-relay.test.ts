// ChatRelay 服務層單元測試
// 測試：訊息廣播、字數限制、5 秒限流、每分鐘 10 則限制、線上人數計算
// 使用 mock wsManager，不測試實際 WebSocket 連線

import { describe, it, expect, beforeEach } from 'bun:test';
import { ChatRelay, ChatRateLimiter } from '../chat-relay';
import { ErrorCode } from '@clawapi/protocol';
import type { WebSocketManager } from '../../ws/manager';

// ===== Mock WebSocketManager =====
// 模擬 wsManager 的公開 API

function createMockWsManager() {
  // 記錄 broadcastToChannel 的呼叫
  const broadcastCalls: Array<{ channel: string; payload: unknown }> = [];
  // 模擬在線人數
  let onlineCount = 5;

  const wsManager = {
    _getBroadcastCalls() { return broadcastCalls; },
    _clearBroadcastCalls() { broadcastCalls.length = 0; },
    _setOnlineCount(n: number) { onlineCount = n; },
    _getLastBroadcast() {
      return broadcastCalls[broadcastCalls.length - 1] ?? null;
    },

    getOnlineCount(): number {
      return onlineCount;
    },

    broadcastToChannel(channel: string, payload: unknown): void {
      broadcastCalls.push({ channel, payload });
    },

    sendToDevice(_deviceId: string, _message: unknown): boolean {
      return true;
    },

    getConnection(_deviceId: string): unknown {
      return null;
    },
  };

  return wsManager as unknown as WebSocketManager & typeof wsManager;
}

// ===== ChatRateLimiter 單元測試 =====

describe('ChatRateLimiter', () => {
  let limiter: ChatRateLimiter;

  beforeEach(() => {
    limiter = new ChatRateLimiter();
  });

  it('首次發訊應通過', () => {
    const result = limiter.check('device_001');
    expect(result).toBeNull();
  });

  it('5 秒內重複發訊應回傳 WS_CHAT_RATE_LIMITED', () => {
    limiter.check('device_001');  // 第一次成功
    const result = limiter.check('device_001');  // 立刻第二次
    expect(result).toBe(ErrorCode.WS_CHAT_RATE_LIMITED);
  });

  it('不同裝置的限流狀態互不影響', () => {
    limiter.check('device_001');  // device_001 已有冷卻
    const result = limiter.check('device_002');  // device_002 應可發訊
    expect(result).toBeNull();
  });

  it('超過 5 秒後應可再次發訊', () => {
    // 注意：直接操控時間不易，這裡用 clear 模擬冷卻過期
    limiter.check('device_001');
    limiter.clear('device_001');  // 清除冷卻狀態
    const result = limiter.check('device_001');
    expect(result).toBeNull();
  });

  it('每分鐘超過 10 則應回傳 WS_CHAT_RATE_LIMITED', () => {
    const deviceId = 'device_burst';

    // 發送 10 則後，每次都要先清 5 秒冷卻（模擬 5 秒後發送）
    // 在測試中透過 clear 模擬時間流逝
    for (let i = 0; i < 10; i++) {
      // 清除 5 秒冷卻但保留分鐘視窗
      (limiter as unknown as { lastMessageTime: Map<string, number> })
        .lastMessageTime.delete(deviceId);
      const result = limiter.check(deviceId);
      expect(result).toBeNull();  // 前 10 則應通過
    }

    // 第 11 則應被分鐘限制擋住
    (limiter as unknown as { lastMessageTime: Map<string, number> })
      .lastMessageTime.delete(deviceId);
    const result = limiter.check(deviceId);
    expect(result).toBe(ErrorCode.WS_CHAT_RATE_LIMITED);
  });

  it('clearAll 後所有裝置應可重新發訊', () => {
    limiter.check('device_a');
    limiter.check('device_b');
    limiter.clearAll();
    expect(limiter.check('device_a')).toBeNull();
    expect(limiter.check('device_b')).toBeNull();
  });
});

// ===== ChatRelay 主類別測試 =====

describe('ChatRelay', () => {
  let mockWs: ReturnType<typeof createMockWsManager>;
  let relay: ChatRelay;

  beforeEach(() => {
    mockWs = createMockWsManager();
    relay = new ChatRelay(mockWs);
  });

  // ===== 驗收標準 1：聊天廣播不含 sender_device_id =====
  describe('訊息廣播匿名化', () => {
    it('廣播 payload 不應包含 sender_device_id（匿名）', () => {
      const result = relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '大家好！',
      });

      expect(result.ok).toBe(true);
      const lastBroadcast = mockWs._getLastBroadcast();
      expect(lastBroadcast).not.toBeNull();

      // 確認廣播 payload 不含 sender_device_id
      const payload = lastBroadcast!.payload as Record<string, unknown>;
      expect(payload.sender_device_id).toBeNull();
      // 確認序列化後的 JSON 不含 device_001（使用 includes 而非 in 運算子）
      expect(JSON.stringify(payload).includes('device_001')).toBe(false);
    });

    it('廣播的頻道格式應為 chat:{channelName}', () => {
      relay.handleChatMessage('device_001', {
        channel: 'help',
        text: '需要協助',
      });

      const lastBroadcast = mockWs._getLastBroadcast();
      expect(lastBroadcast!.channel).toBe('chat:help');
    });

    it('無暱稱時應使用「匿名龍蝦」作為預設', () => {
      relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '測試訊息',
        // 沒有提供 nickname
      });

      const payload = mockWs._getLastBroadcast()!.payload as Record<string, unknown>;
      expect(payload.nickname).toBe('匿名龍蝦');
    });

    it('有暱稱時應使用提供的暱稱', () => {
      relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '測試',
        nickname: '測試龍蝦',
      });

      const payload = mockWs._getLastBroadcast()!.payload as Record<string, unknown>;
      expect(payload.nickname).toBe('測試龍蝦');
    });

    it('reply_to 欄位應正確傳遞', () => {
      relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '回覆測試',
        reply_to: 'msg_abc123',
      });

      const payload = mockWs._getLastBroadcast()!.payload as Record<string, unknown>;
      expect(payload.reply_to).toBe('msg_abc123');
    });

    it('成功時應回傳 ok: true 和相關資訊', () => {
      const result = relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '測試',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.messageId).toBeTruthy();
        expect(result.channel).toBe('chat:general');
        expect(result.serverTime).toBeTruthy();
      }
    });
  });

  // ===== 驗收標準 2：500 字限制 =====
  describe('訊息長度限制', () => {
    it('剛好 500 字的訊息應通過', () => {
      const text = 'A'.repeat(500);
      const result = relay.handleChatMessage('device_001', {
        channel: 'general',
        text,
      });
      expect(result.ok).toBe(true);
    });

    it('501 字的訊息應回傳 WS_CHAT_MESSAGE_TOO_LONG', () => {
      const text = 'A'.repeat(501);
      const result = relay.handleChatMessage('device_001', {
        channel: 'general',
        text,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe(ErrorCode.WS_CHAT_MESSAGE_TOO_LONG);
      }
    });

    it('超長訊息不應觸發廣播', () => {
      const text = 'B'.repeat(1000);
      mockWs._clearBroadcastCalls();
      relay.handleChatMessage('device_001', { channel: 'general', text });
      expect(mockWs._getBroadcastCalls().length).toBe(0);
    });

    it('空訊息應回傳 WS_INVALID_MESSAGE_FORMAT', () => {
      const result = relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe(ErrorCode.WS_INVALID_MESSAGE_FORMAT);
      }
    });
  });

  // ===== 驗收標準 3：5 秒冷卻 =====
  describe('Rate Limiting', () => {
    it('5 秒內第二則訊息應回傳 WS_CHAT_RATE_LIMITED', () => {
      // 第一則成功
      const first = relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '第一則',
      });
      expect(first.ok).toBe(true);

      // 立刻第二則：應被限流
      const second = relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '第二則',
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.errorCode).toBe(ErrorCode.WS_CHAT_RATE_LIMITED);
      }
    });

    it('被限流時不應觸發廣播', () => {
      relay.handleChatMessage('device_001', { channel: 'general', text: '第一則' });
      const countBefore = mockWs._getBroadcastCalls().length;
      relay.handleChatMessage('device_001', { channel: 'general', text: '被限流' });
      const countAfter = mockWs._getBroadcastCalls().length;

      // 第二則被限流，廣播次數不變
      expect(countAfter).toBe(countBefore);
    });

    it('不同裝置的限流不互相影響', () => {
      relay.handleChatMessage('device_001', { channel: 'general', text: '裝置 A' });
      const result = relay.handleChatMessage('device_002', {
        channel: 'general',
        text: '裝置 B',
      });
      expect(result.ok).toBe(true);
    });

    it('清除限流狀態後應可再次發訊', () => {
      relay.handleChatMessage('device_001', { channel: 'general', text: '第一則' });
      relay.getRateLimiter().clear('device_001');
      const result = relay.handleChatMessage('device_001', {
        channel: 'general',
        text: '冷卻後',
      });
      expect(result.ok).toBe(true);
    });
  });

  // ===== 線上人數計算 =====
  describe('getOnlineCount', () => {
    it('應回傳 wsManager 線上人數', () => {
      mockWs._setOnlineCount(42);
      expect(relay.getOnlineCount()).toBe(42);
    });

    it('應取 WS 線上數與近期活躍數的最大值', () => {
      mockWs._setOnlineCount(3);

      // 模擬 10 個裝置有近期活動（超過 WS 線上數）
      for (let i = 0; i < 10; i++) {
        relay.setLastActivity(`device_${i}`, Date.now());
      }

      expect(relay.getOnlineCount()).toBe(10);
    });

    it('超過 15 分鐘的活動紀錄不計入', () => {
      mockWs._setOnlineCount(2);

      const sixteenMinsAgo = Date.now() - 16 * 60 * 1000;
      relay.setLastActivity('device_old', sixteenMinsAgo);

      // 只有 WS 線上數（2），舊活動不計入
      expect(relay.getOnlineCount()).toBe(2);
    });
  });

  // ===== 到場通知廣播 =====
  describe('broadcastPresenceChange', () => {
    it('join 通知應廣播到正確頻道', () => {
      mockWs._clearBroadcastCalls();
      relay.broadcastPresenceChange('general', 'join');

      const lastBroadcast = mockWs._getLastBroadcast();
      expect(lastBroadcast).not.toBeNull();
      expect(lastBroadcast!.channel).toBe('chat:general');

      const payload = lastBroadcast!.payload as Record<string, unknown>;
      expect(payload.event).toBe('join');
    });

    it('leave 通知應包含正確的 event 類型', () => {
      mockWs._clearBroadcastCalls();
      relay.broadcastPresenceChange('help', 'leave');

      const payload = mockWs._getLastBroadcast()!.payload as Record<string, unknown>;
      expect(payload.event).toBe('leave');
      expect(payload.channel).toBe('help');
    });

    it('通知應包含 online_count', () => {
      mockWs._setOnlineCount(7);
      relay.broadcastPresenceChange('general', 'join');

      const payload = mockWs._getLastBroadcast()!.payload as Record<string, unknown>;
      expect(typeof payload.online_count).toBe('number');
    });
  });
});
