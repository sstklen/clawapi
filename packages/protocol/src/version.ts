// 版本檢查型別（SPEC-C §4.7）

export interface VersionCheckResponse {
  latest_version: string;
  current_version: string;
  update_available: boolean;
  is_critical?: boolean;
  release_notes?: string;
  download_urls?: {
    npm: string;
    brew: string;
    binary: Record<string, string>;
    docker: string;
  };
  min_supported_version?: string;
}
