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

// 別名
export type AidRequestParams = AidRequest;
export type AidRequestResponse = AidAccepted;
