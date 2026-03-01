// L0 公共 Key 型別（SPEC-C §4.3 + 附錄 B）

import type { ServiceId } from './telemetry';

export interface L0Config {
  daily_limit: number;
  services: ServiceId[];
}

export interface L0Key {
  id: string;
  service_id: ServiceId;
  key_encrypted: string | null;
  encryption_method: 'aes-256-gcm' | null;
  encryption_key_id: string | null;
  status: 'active' | 'degraded' | 'dead';
  daily_quota_per_device: number | null;
  total_daily_quota: number | null;
  total_daily_used: number | null;
  donated_by: string | null;
  updated_at: string;
}

export interface L0KeysResponse {
  schema_version: number;
  keys: L0Key[];
  l0_encryption_key: string;
  device_daily_limits: Record<ServiceId, {
    limit: number;
    used: number;
    reset_at: string;
  }>;
  cache_ttl: number;
  server_time: string;
}

export interface L0DonateRequest {
  service_id: ServiceId;
  encrypted_key: string;
  ephemeral_public_key: string;
  iv: string;
  tag: string;
  display_name?: string;
  anonymous?: boolean;
}

export interface L0DonateResponse {
  accepted: boolean;
  l0_key_id: string;
  message: string;
  validation: {
    key_valid: boolean;
    service_confirmed: ServiceId;
    estimated_daily_quota: number;
  };
}

export interface L0UsageEntry {
  l0_key_id: string;
  service_id: ServiceId;
  count: number;
  last_used_at: string;
}

// 別名
export type DonateKeyParams = L0DonateRequest;
