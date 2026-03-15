/**
 * Debug 醫生 — 共用型別定義
 * 從 debug-ai.ts 抽取，所有模組共用
 */

// ─── 知識庫條目 ───

/** Debug 知識庫條目（YanHui KB） */
export interface DebugEntry {
  id?: number;
  error_description: string;
  error_message: string;
  error_category: string;
  root_cause: string;
  fix_description: string;
  fix_patch: string;
  environment: string;    // JSON string
  quality_score: number;
  verified: number;
  hit_count: number;
  contributed_by: string;
  source: string;
  // Dr. Claw 驗證飛輪
  verified_count: number;
  success_count: number;
  fail_count: number;
  last_verified_at?: string;
  created_at?: string;
  updated_at?: string;
}

// ─── 分析結果 ───

/** Claude 分析回傳結構 */
export interface DebugAnalysis {
  root_cause: string;
  category: string;
  severity: number;        // 1-5
  confidence: number;      // 0-1
  fix_description: string;
  fix_steps: string[];
  fix_patch: string;
}

/** KB 增強分析回傳（DebugAnalysis + KB 驗證資訊） */
export interface KBAugmentedAnalysis extends DebugAnalysis {
  kb_entry_ids: number[];
  validated_by_kb: boolean;
}

// ─── 龍蝦帳戶 ───

/** 龍蝦（使用者）帳戶 */
export interface LobsterAccount {
  id: number;
  lobster_id: string;
  display_name: string;
  balance: number;
  total_spent: number;
  total_saved: number;
  problems_solved: number;
  problems_contributed: number;
  onboarded: number;
  created_at: string;
  updated_at: string;
}

// ─── AI 過濾 ───

/** onboard 品質過濾結果 */
export interface FilteredEntry {
  index: number;         // 原始索引
  is_real_bug: boolean;  // 是否為真正的 bug
  quality_score: number; // 品質分數 0-1
  category: string;      // 分類
  has_sensitive_data: boolean; // 是否含敏感資料
  reason: string;        // 辨識原因（為什麼留/刪）
}

// ─── 望聞問切 ───

/** 望聞問切 Session 結構 */
export interface DiagnosisSession {
  id: string;
  lobster_id: string;
  phase: string;
  round: number;
  initial_description: string;
  initial_score: number;
  collected_info: string;    // JSON
  conversation: string;      // JSON array
  diagnosis: string | null;
  kb_candidates: string;     // JSON array
  status: string;
  created_at: string;
  updated_at: string;
}

/** collected_info 解構 */
export interface CollectedInfo {
  error_message?: string;
  context?: string;
  changes?: string;
  environment?: Record<string, any>;
  assumptions?: string;
}

/** 望聞問切四階段 */
export const DIAGNOSIS_PHASES = ['望', '聞', '問', '切'] as const;
export type DiagnosisPhase = typeof DIAGNOSIS_PHASES[number];

// ─── 驗證資訊 ───

/** KB 條目的社群驗證狀態 */
export interface VerificationInfo {
  kb_entry_id: number;
  verified_count: number;
  success_rate: number | null;
  last_verified: string | null;
  status: 'unverified' | 'partially_verified' | 'community_verified' | 'low_success';
}

// ─── 統計 ───

/** Debug 服務統計（持久化到 SQLite） */
export interface DebugStats {
  totalRequests: number;
  knowledgeHits: number;
  sonnetAnalyses: number;
  opusAnalyses: number;
  contributions: number;
  autoCollections: number;
  searches: number;
  startedAt: string;
}
