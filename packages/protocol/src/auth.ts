// 認證相關型別（SPEC-C §2 + 附錄 B）

import type { L0Config } from './l0';

export type Region = 'asia' | 'europe' | 'americas' | 'other';

export interface DeviceRegistration {
  device_id: string;
  device_fingerprint: string;
  client_version: string;
  os: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  locale: string;
  timezone: string;
  region: Region;
}

export interface DeviceRegistrationResponse {
  device_token: string;
  token_expires_at: string;
  l0_config: L0Config;
  vps_public_key: string;
  vps_public_key_id: string;
  assigned_region: Region;
  latest_version: string;
  server_time: string;
}

export interface DeviceResetResponse {
  reset: boolean;
  message: string;
}

export interface AuthHeaders {
  'X-Device-Id': string;
  'X-Device-Token': string;
  'X-Client-Version': string;
}

export interface GoogleAuthRequest {
  google_id_token: string;
  requested_nickname?: string;
}

export interface GoogleAuthResponse {
  bound: boolean;
  google_email: string;
  nickname: string;
  features_unlocked: string[];
}
