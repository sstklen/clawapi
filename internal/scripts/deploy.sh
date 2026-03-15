#!/usr/bin/env bash
# ============================================================
# ClawAPI VPS — 自動化部署腳本
# 用法：./scripts/deploy.sh
# 功能：拉取最新程式碼 → 構建映像 → 啟動容器 → 驗證健康狀態
# ============================================================

set -euo pipefail

# ─── 顏色定義 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # 無顏色

# ─── 輔助函數 ───
log_info()  { echo -e "${BLUE}[INFO]${NC}  $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# ─── 切到專案根目錄 ───
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

log_info "開始部署 ClawAPI VPS..."
log_info "專案目錄：$PROJECT_DIR"

# ─── 步驟 1：拉取最新程式碼 ───
log_info "步驟 1/4：拉取最新程式碼..."
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  BEFORE_COMMIT=$(git rev-parse --short HEAD)
  git pull --ff-only
  AFTER_COMMIT=$(git rev-parse --short HEAD)
  if [ "$BEFORE_COMMIT" = "$AFTER_COMMIT" ]; then
    log_info "程式碼已是最新版本（$AFTER_COMMIT）"
  else
    log_ok "程式碼已更新：$BEFORE_COMMIT → $AFTER_COMMIT"
  fi
else
  log_warn "不在 git 倉庫中，跳過 git pull"
fi

# ─── 步驟 2：構建 Docker 映像 ───
log_info "步驟 2/4：構建 Docker 映像..."
docker compose -f docker-compose.vps.yml build --no-cache
log_ok "映像構建完成"

# ─── 步驟 3：啟動容器 ───
log_info "步驟 3/4：啟動容器..."
docker compose -f docker-compose.vps.yml up -d
log_ok "容器已啟動"

# ─── 步驟 4：等待健康檢查通過 ───
log_info "步驟 4/4：等待健康檢查通過..."

MAX_RETRIES=30
RETRY_INTERVAL=2
HEALTHY=false

for i in $(seq 1 $MAX_RETRIES); do
  # 檢查容器健康狀態
  HEALTH_STATUS=$(docker inspect --format='{{.State.Health.Status}}' clawapi-vps 2>/dev/null || echo "unknown")

  if [ "$HEALTH_STATUS" = "healthy" ]; then
    HEALTHY=true
    break
  fi

  if [ "$HEALTH_STATUS" = "unhealthy" ]; then
    log_error "容器健康檢查失敗！"
    log_error "查看日誌：docker compose -f docker-compose.vps.yml logs clawapi-vps"
    exit 1
  fi

  echo -n "."
  sleep $RETRY_INTERVAL
done

echo "" # 換行

if [ "$HEALTHY" = true ]; then
  log_ok "健康檢查通過！"
else
  log_error "等待逾時（${MAX_RETRIES}×${RETRY_INTERVAL}s），容器可能尚未準備好"
  log_error "目前狀態：$HEALTH_STATUS"
  log_error "查看日誌：docker compose -f docker-compose.vps.yml logs clawapi-vps"
  exit 1
fi

# ─── 部署結果摘要 ───
echo ""
echo "============================================================"
log_ok "ClawAPI VPS 部署完成！"
echo "============================================================"
echo ""
echo "  容器狀態："
docker compose -f docker-compose.vps.yml ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "  有用的指令："
echo "    查看日誌：docker compose -f docker-compose.vps.yml logs -f"
echo "    重新啟動：docker compose -f docker-compose.vps.yml restart"
echo "    停止服務：docker compose -f docker-compose.vps.yml down"
echo ""
