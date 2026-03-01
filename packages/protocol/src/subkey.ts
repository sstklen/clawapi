// Sub-Key 型別（SPEC-C §4.10 + 附錄 B）

import type { ServiceId } from './telemetry';

export interface SubKeyValidateRequest {
  sub_key: string;
  service_id: ServiceId;
}

export interface SubKeyValidateResponse {
  valid: boolean;
  service_id: ServiceId;
  permissions: {
    models: string[] | null;
    rate_limit: number;
    rate_remaining: number;
    expires_at: string | null;
  };
}
