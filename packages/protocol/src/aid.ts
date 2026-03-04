// 互助型別（SPEC-C §4.5 + 附錄 B）

import type { ServiceId } from './telemetry';

export type AidDirection = 'given' | 'received';
export type NotificationKind =
  | 'l0_keys_updated'
  | 'version_available'
  | 'aid_request'
  | 'aid_matched'
  | 'aid_result'
  | 'adapter_updated'
  | 'service_alert';

export interface AidRequest {
  service_id: ServiceId;
  request_type: string;
  requester_public_key: string;
  max_latency_ms: number;
  context: {
    retry_count: number;
    original_error: string;
  };
}

export interface AidAccepted {
  status: 'matching';
  aid_id: string;
  estimated_wait_ms: number;
  message: string;
}

export interface AidResultNotification {
  kind: 'aid_result';
  aid_id: string;
  status: 'fulfilled' | 'timeout' | 'error';
  response_encrypted?: string;
  encryption_method?: 'aes-256-gcm';
  helper_public_key?: string;
  aid_record?: {
    service_id: ServiceId;
    latency_ms: number;
    helper_device_id: null;
  };
  message?: string;
  suggestion?: string;
}

export interface AidMatchedNotification {
  type: 'notification';
  kind: 'aid_matched';
  aid_id: string;
  service_id?: ServiceId;
  request_type?: string;
  requester_public_key?: string;
  helper_public_key?: string;
}

export interface AidEncryptedRequest {
  type: 'aid_data';
  kind: 'encrypted_request';
  aid_id: string;
  encrypted_payload: string;
  iv: string;
  tag: string;
}

export interface AidEncryptedResponse {
  type: 'aid_data';
  kind: 'encrypted_response';
  aid_id: string;
  encrypted_payload: string;
  iv: string;
  tag: string;
  helper_public_key: string;
}

export interface AidConfig {
  enabled: boolean;
  allowed_services: ServiceId[] | null;
  daily_limit: number;
  daily_given: number;
  blackout_hours?: number[];
  helper_public_key?: string;
}

export interface AidStats {
  given: AidStatBlock;
  received: AidStatBlock;
}

export interface AidStatBlock {
  today: number;
  this_month: number;
  all_time: number;
  by_service: Record<ServiceId, number>;
}

export interface AidResponsePayload {
  aid_id: string;
  status: 'fulfilled' | 'rejected' | 'error';
  response_encrypted?: string;
  encryption_method?: 'aes-256-gcm';
  helper_public_key?: string;
  latency_ms?: number;
  error_message?: string;
}

// ===== 感謝榜 + 積分 =====

/** 感謝榜項目（匿名顯示） */
export interface LeaderboardEntry {
  /** 排名（1-based） */
  rank: number;
  /** 匿名名稱（如「龍蝦 #42」） */
  anonymous_name: string;
  /** 累計幫助次數 */
  total_helped: number;
  /** 幫助過的服務類別 */
  services: string[];
  /** 信譽分數（0.0 ~ 1.0） */
  reputation_score: number;
}

/** 積分資訊 */
export interface AidCredits {
  /** 目前可用積分 */
  credits: number;
  /** 累計賺取的積分 */
  earned_total: number;
  /** 累計花費的積分（目前未使用，保留） */
  spent_total: number;
}

// 別名
export type AidRequestParams = AidRequest;
export type AidRequestResponse = AidAccepted;
