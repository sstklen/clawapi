#!/usr/bin/env bash
# ============================================================
# ClawAPI VPS — 資料庫自動備份腳本
# 建議由 cron 每日 UTC 3:00 執行
# crontab 範例：0 3 * * * /path/to/scripts/backup-db.sh
#
# 備份策略：
#   - 每日備份：保留最近 7 天
#   - 每週備份：每週一額外保存，保留最近 4 週
# ============================================================

set -euo pipefail

# ─── 配置 ───
DB_SOURCE="${DB_PATH:-/data/clawapi-vps.db}"
BACKUP_DIR="${BACKUP_DIR:-/data/db-backups}"
DATE=$(date -u '+%Y%m%d_%H%M%S')
DAY_OF_WEEK=$(date -u '+%u')  # 1=週一, 7=週日

# 保留天數
DAILY_KEEP_DAYS=7
WEEKLY_KEEP_DAYS=28

# ─── 顏色定義 ───
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo "[INFO]  $(date -u '+%Y-%m-%d %H:%M:%S UTC') $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $(date -u '+%Y-%m-%d %H:%M:%S UTC') $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $(date -u '+%Y-%m-%d %H:%M:%S UTC') $*"; }

# ─── 前置檢查 ───
if [ ! -f "$DB_SOURCE" ]; then
  log_error "資料庫檔案不存在：$DB_SOURCE"
  exit 1
fi

# 建立備份目錄
mkdir -p "$BACKUP_DIR/daily"
mkdir -p "$BACKUP_DIR/weekly"

# ─── 每日備份 ───
DAILY_BACKUP="$BACKUP_DIR/daily/clawapi-vps_${DATE}.db"

log_info "開始每日備份..."
log_info "來源：$DB_SOURCE"
log_info "目標：$DAILY_BACKUP"

# 使用 SQLite 的 .backup 指令確保一致性（比 cp 安全）
# 如果沒有 sqlite3 CLI，退化為 cp
if command -v sqlite3 &> /dev/null; then
  sqlite3 "$DB_SOURCE" ".backup '$DAILY_BACKUP'"
else
  cp "$DB_SOURCE" "$DAILY_BACKUP"
fi

# 計算備份大小
BACKUP_SIZE=$(du -h "$DAILY_BACKUP" | cut -f1)
log_ok "每日備份完成（$BACKUP_SIZE）"

# ─── 每週備份（週一）───
if [ "$DAY_OF_WEEK" = "1" ]; then
  WEEKLY_BACKUP="$BACKUP_DIR/weekly/clawapi-vps_weekly_${DATE}.db"
  cp "$DAILY_BACKUP" "$WEEKLY_BACKUP"
  log_ok "每週備份完成：$WEEKLY_BACKUP"
fi

# ─── 清理舊的每日備份（保留 7 天）───
log_info "清理超過 ${DAILY_KEEP_DAYS} 天的每日備份..."
DAILY_CLEANED=0
find "$BACKUP_DIR/daily" -name "clawapi-vps_*.db" -type f -mtime +${DAILY_KEEP_DAYS} | while read -r old_file; do
  rm -f "$old_file"
  log_info "已刪除：$(basename "$old_file")"
  DAILY_CLEANED=$((DAILY_CLEANED + 1))
done
log_ok "每日備份清理完成"

# ─── 清理舊的每週備份（保留 28 天 = 4 週）───
log_info "清理超過 ${WEEKLY_KEEP_DAYS} 天的每週備份..."
find "$BACKUP_DIR/weekly" -name "clawapi-vps_weekly_*.db" -type f -mtime +${WEEKLY_KEEP_DAYS} | while read -r old_file; do
  rm -f "$old_file"
  log_info "已刪除：$(basename "$old_file")"
done
log_ok "每週備份清理完成"

# ─── 備份摘要 ───
DAILY_COUNT=$(find "$BACKUP_DIR/daily" -name "*.db" -type f 2>/dev/null | wc -l | tr -d ' ')
WEEKLY_COUNT=$(find "$BACKUP_DIR/weekly" -name "*.db" -type f 2>/dev/null | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)

echo ""
echo "============================================================"
log_ok "備份完成摘要"
echo "============================================================"
echo "  每日備份數量：$DAILY_COUNT"
echo "  每週備份數量：$WEEKLY_COUNT"
echo "  備份總大小：  $TOTAL_SIZE"
echo "============================================================"
