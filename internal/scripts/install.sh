#!/usr/bin/env bash
# ============================================================
# ClawAPI 引擎 — 一鍵安裝腳本
# 用法：curl -fsSL https://get.clawapi.com | bash
#   或：curl -fsSL https://get.clawapi.com | bash -s -- --version 0.1.0
# 功能：偵測平台 → 下載可執行檔 → 驗證 checksum → 安裝到 PATH
# ============================================================

set -euo pipefail

# ─── 設定 ───
GITHUB_REPO="clawapi/clawapi"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="clawapi"
BASE_URL="https://github.com/${GITHUB_REPO}/releases/download"

# ─── 顏色定義 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ─── 輔助函數 ───
log_info()  { echo -e "${BLUE}[clawapi]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[clawapi]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[clawapi]${NC} $*"; }
log_error() { echo -e "${RED}[clawapi]${NC} $*" >&2; }

# ─── 解析參數 ───
VERSION=""
CUSTOM_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v)
      VERSION="$2"
      shift 2
      ;;
    --dir|-d)
      CUSTOM_DIR="$2"
      shift 2
      ;;
    --help|-h)
      echo "用法：install.sh [選項]"
      echo ""
      echo "選項："
      echo "  --version, -v <版本>    指定版本（預設：最新版）"
      echo "  --dir, -d <目錄>        安裝目錄（預設：/usr/local/bin）"
      echo "  --help, -h              顯示幫助"
      exit 0
      ;;
    *)
      log_error "未知參數：$1"
      exit 1
      ;;
  esac
done

if [[ -n "$CUSTOM_DIR" ]]; then
  INSTALL_DIR="$CUSTOM_DIR"
fi

# ─── 偵測平台和架構 ───
detect_platform() {
  local os arch

  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)   os="linux" ;;
    Darwin)  os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*)
      os="win"
      ;;
    *)
      log_error "不支援的作業系統：$os"
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      log_error "不支援的架構：$arch"
      exit 1
      ;;
  esac

  # Windows 只支援 x64
  if [[ "$os" == "win" && "$arch" != "x64" ]]; then
    log_error "Windows 只支援 x64 架構"
    exit 1
  fi

  # Linux 只支援 x64
  if [[ "$os" == "linux" && "$arch" != "x64" ]]; then
    log_error "Linux 目前只支援 x64 架構"
    exit 1
  fi

  echo "${os}-${arch}"
}

# ─── 取得最新版本 ───
get_latest_version() {
  local latest
  latest="$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed -E 's/.*"tag_name": *"v?([^"]+)".*/\1/')" || {
    log_error "無法取得最新版本資訊"
    exit 1
  }
  echo "$latest"
}

# ─── 主流程 ───
main() {
  echo ""
  log_info "ClawAPI 安裝程式"
  echo ""

  # 偵測平台
  local platform
  platform="$(detect_platform)"
  log_info "偵測到平台：${platform}"

  # 決定版本
  if [[ -z "$VERSION" ]]; then
    log_info "取得最新版本..."
    VERSION="$(get_latest_version)"
  fi
  log_info "安裝版本：v${VERSION}"

  # 組合檔名
  local filename
  if [[ "$platform" == "win-x64" ]]; then
    filename="clawapi-${platform}.exe"
  else
    filename="clawapi-${platform}"
  fi

  local download_url="${BASE_URL}/v${VERSION}/${filename}"
  local checksum_url="${BASE_URL}/v${VERSION}/checksums.sha256"

  # 建立暫存目錄
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  # 下載可執行檔
  log_info "下載 ${filename}..."
  if ! curl -fsSL -o "${tmpdir}/${filename}" "$download_url"; then
    log_error "下載失敗：${download_url}"
    log_error "請確認版本 v${VERSION} 是否存在"
    exit 1
  fi

  # 下載並驗證 checksum（安全規則：驗證失敗一律中止，不允許跳過）
  log_info "驗證 checksum..."
  if ! curl -fsSL -o "${tmpdir}/checksums.sha256" "$checksum_url" 2>/dev/null; then
    log_error "無法下載 checksum 檔案：${checksum_url}"
    log_error "安全規則：無法驗證完整性時，安裝中止"
    exit 1
  fi

  local expected_hash actual_hash
  expected_hash="$(grep "${filename}" "${tmpdir}/checksums.sha256" | awk '{print $1}')"

  if [[ -z "$expected_hash" ]]; then
    log_error "checksums.sha256 中找不到 ${filename}"
    log_error "安全規則：無法比對 checksum 時，安裝中止"
    exit 1
  fi

  if command -v sha256sum &>/dev/null; then
    actual_hash="$(sha256sum "${tmpdir}/${filename}" | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    actual_hash="$(shasum -a 256 "${tmpdir}/${filename}" | awk '{print $1}')"
  else
    log_error "找不到 sha256sum 或 shasum，無法驗證完整性"
    log_error "安全規則：請先安裝 coreutils（sha256sum）後再安裝"
    exit 1
  fi

  if [[ "$actual_hash" != "$expected_hash" ]]; then
    log_error "Checksum 驗證失敗！"
    log_error "預期：${expected_hash}"
    log_error "實際：${actual_hash}"
    log_error "檔案可能已被篡改，安裝中止"
    exit 1
  fi

  log_ok "Checksum 驗證通過"

  # 設定可執行權限
  chmod +x "${tmpdir}/${filename}"

  # 安裝到目標目錄
  log_info "安裝到 ${INSTALL_DIR}/${BINARY_NAME}..."

  if [[ -w "$INSTALL_DIR" ]]; then
    mv "${tmpdir}/${filename}" "${INSTALL_DIR}/${BINARY_NAME}"
  else
    log_info "需要 sudo 權限寫入 ${INSTALL_DIR}/"
    sudo mv "${tmpdir}/${filename}" "${INSTALL_DIR}/${BINARY_NAME}"
    sudo chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
  fi

  # 驗證安裝
  if command -v "$BINARY_NAME" &>/dev/null; then
    log_ok "安裝成功！"
    echo ""
    echo "  版本：$("$BINARY_NAME" version 2>/dev/null || echo "v${VERSION}")"
    echo "  位置：$(command -v "$BINARY_NAME")"
    echo ""
    echo "  開始使用："
    echo "    clawapi setup    # 首次設定"
    echo "    clawapi start    # 啟動引擎"
    echo "    clawapi --help   # 查看所有命令"
    echo ""
  else
    log_warn "安裝完成，但 ${BINARY_NAME} 不在 PATH 中"
    log_warn "請將 ${INSTALL_DIR} 加入你的 PATH"
    echo ""
    echo "  例如：export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
  fi
}

main "$@"
