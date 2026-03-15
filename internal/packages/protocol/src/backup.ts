// 備份型別（SPEC-C §4.9 + 附錄 B）

export interface BackupUploadHeaders {
  'X-Backup-Version': string;
  'X-Backup-Checksum': string;
  'X-Google-Token': string;
}

export interface BackupUploadResponse {
  uploaded: boolean;
  backup_size: number;
  server_checksum: string;
  stored_at: string;
}

export interface BackupDownloadHeaders {
  'X-Backup-Version': string;
  'X-Backup-Checksum': string;
  'X-Backup-Stored-At': string;
}

export interface BackupDeleteResponse {
  deleted: boolean;
  message: string;
}
