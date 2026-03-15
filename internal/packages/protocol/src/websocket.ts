// WebSocket 型別（SPEC-C §5 + 附錄 B）

import type { NotificationKind } from './aid';

export interface WSClientMessage {
  type: string;
  channel: string;
  id: string;
  payload: unknown;
}

export interface WSServerMessage {
  type: string;
  channel: string;
  id: string;
  payload: unknown;
  server_time: string;
}

export interface SubscribeAckPayload {
  subscribed: string[];
  online_count?: number;
}

export interface RoutingRecommendation {
  service_id: string;
  region: 'asia' | 'europe' | 'americas' | 'other';
  status: 'preferred' | 'degraded' | 'avoid';
  confidence: number;
  metrics: {
    success_rate: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    sample_size: number;
  };
  note: string | null;
}

export interface RoutingUpdate {
  schema_version: number;
  generated_at: string;
  valid_until: string;
  recommendations: RoutingRecommendation[];
  alerts: ServiceAlert[];
}

export interface ServiceAlert {
  severity: 'info' | 'warning' | 'critical';
  service_id: string;
  message: string;
  started_at: string;
}

export interface Notification {
  type: 'notification';
  channel: 'notifications';
  id: string;
  payload: {
    kind: NotificationKind;
    message?: string;
    action?: string;
    [key: string]: unknown;
  };
  server_time: string;
}

// 聊天室訊息型別（WS 聊天室專用）
export interface ChatRoomMessage {
  text: string;
  nickname: string;
  reply_to: string | null;
}

export interface ChatMessageEvent {
  type: 'chat_message';
  channel: string;
  id: string;
  payload: ChatRoomMessage;
  server_time?: string;
}
