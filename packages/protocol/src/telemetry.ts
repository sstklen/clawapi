// 集體智慧型別（SPEC-C §4.2 + 附錄 B）

export type ServiceId = string;
export type Tier = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type RoutingStrategy = 'fast' | 'smart' | 'cheap';
export type Outcome = 'success' | 'rate_limited' | 'error' | 'timeout';
export type ServiceStatus = 'preferred' | 'degraded' | 'avoid';
export type TimeBucket = 'morning' | 'afternoon' | 'evening';

export interface TelemetryBatch {
  schema_version: number;
  batch_id: string;
  period: { from: string; to: string };
  entries: TelemetryEntry[];
  summary: TelemetrySummary;
}

export interface TelemetryEntry {
  service_id: ServiceId;
  model?: string;
  tier: Tier;
  outcome: Outcome;
  latency_ms: number;
  token_usage?: { input: number; output: number };
  routing_strategy: RoutingStrategy;
  retry_count: number;
  time_bucket: TimeBucket;
}

export interface TelemetrySummary {
  total_requests: number;
  success_rate: number;
  services_used: ServiceId[];
  pool_stats: {
    king_pool_used: number;
    friend_pool_used: number;
    l0_pool_used: number;
    aid_used: number;
  };
}

export interface TelemetryFeedback {
  recommendation_id: string;
  service_id: ServiceId;
  feedback: 'positive' | 'negative';
  reason?: 'high_latency' | 'errors' | 'quality' | 'other';
  comment?: string;
}

export interface TelemetryQuota {
  batch_uploads: {
    limit_per_hour: number;
    used_this_hour: number;
    next_allowed_at: string;
  };
  feedback: {
    limit_per_hour: number;
    used_this_hour: number;
  };
  pending_batches: number;
  server_time: string;
}

// 別名（SPEC-C v1.4）
export type RoutingFeedback = TelemetryFeedback;
