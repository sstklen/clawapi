# ClawAPI 交接文件

> 日期：2026-03-04 | 摘要：測試員回歸報告 3 新 Bug 修完 + 17 個整合測試 + UX 補完
> Git：待 commit | 測試：1039/0 | Build：四平台 ✅ | 全局安裝 ✅

---

## 已完成（更早的 session）

### UX 大修 — 8 項修復 + MCP 四爽點引導（`b706ed2`）

| 嚴重度 | 問題 | 修法 |
|--------|------|------|
| P0 | ask 說「未設定 Claw Key」 | L3 fallback 到已匯入的 LLM Key |
| P0 | Claw Key 被文字淹沒 | 視覺框框顯示 |
| P0 | 命名混亂 | 澄清 + fallback 消除 |
| P1 | status 說「已停止」 | 加 MCP (stdio) 模式 |
| P1 | 驗證失敗沒下一步 | 碰壁引導（爽點③） |
| P1 | 多人分發沒提到 | Sub-Key 提示 |
| P2 | L 層級沒說明 | 人話對照 |
| P2 | Claw Key 無法重看 | status 顯示遮罩版 |

### sub-keys CLI 非互動模式 + 爽點完整版

（詳見上一版 handoff）

### 第一輪 6 個 Bug 全修（`97f6de6`）

A1/A2/A3（master.key 脫鉤）、B1（DuckDuckGo 免費路由）、C1（L4 fallback）

---

## 已完成（本 session）

### 測試員回歸報告的 3 個新 Bug — 全部修復

**Bug N1 🔴 P0：MCP 殭屍問題（同 session uninstall 後 disk I/O error）**

| 修法 | 檔案 |
|------|------|
| uninstall 前先停 daemon（SIGTERM → 3s 等待 → SIGKILL） | `src/cli/commands/uninstall.ts` |
| 偵測 MCP 模式，顯示醒目警告「重啟 Claude Code session」 | 同上 |

**Bug N3 🟡 P1：不明 Groq Key + daily_used:12**

| 根因 | 修法 | 檔案 |
|------|------|------|
| `keys list` 和 `keys check` 用的是 hardcoded 假資料 | 接上真正的 KeyPool（DB 讀取） | `src/cli/commands/keys.ts` |
| 假資料包含 `gsk_...Xm4Q` + `daily_used: 12` | 移除所有 mock data | 同上 |

**Phase 2 UX 落差：init CLI 沒有路線圖**

| 修法 | 檔案 |
|------|------|
| 加入 L1→L4 成長路線圖（含「← 你在這裡」標記） | `src/cli/commands/init.ts` |
| 四爽點每個附場景描述 | 同上 |
| 結尾兩個輕問句 | 同上 |

### 新增：自循環整合測試（17 個測試）

**檔案：** `src/__tests__/integration.test.ts`

用 TestHarness class（真實 DB + CryptoModule + KeyPool），每個測試用臨時目錄隔離。

| 接縫 | 測什麼 | 測試數 |
|------|--------|--------|
| 1. master.key + data.db 配對 | 正常解密 + 換 key 後失敗 | 2 |
| 2. DuckDuckGo 免費路由 | 空 KeyPool 也能路由 + 付費優先 | 2 |
| 3. status 解密驗證 | 正常無警告 + 不匹配有警告 | 2 |
| 4. 重複 Key 防護 | 同 Key 不重複 + 不同 Key 正常加 | 2 |
| 5. daily_used 初始值 | 新 Key 計數器 = 0 | 3 |
| 6. selectKey 輪換 | 多 Key 輪換 + 不存在回 null | 2 |
| 7. 空 DB 的 status | 0 Key 時不壞 | 1 |
| 8. 免費佔位 Key 安全性 | id=-1 不影響真 Key | 1 |
| 9. 多服務混合 | 3 服務互不干擾 + status 正確統計 | 2 |

### 驗證結果
- `bun test --recursive`：1039 pass / 0 fail ✅（+17 整合測試）
- 四平台 build ✅
- 全局安裝 ✅
- CLI 版本確認 v0.1.12 ✅

---

## 未完成

- **Git commit**：本 session 改動尚未 commit
- Bug N2（`/v1/search` HTTP 端點不存在）→ P2 下版修，影響外部 REST 整合但不影響 MCP

---

## 改動檔案總覽（本 session）

| 檔案 | 改動 |
|------|------|
| `src/cli/commands/uninstall.ts` | 停 daemon + MCP 殭屍警告 |
| `src/cli/commands/keys.ts` | 移除假資料，接上真實 KeyPool |
| `src/cli/commands/init.ts` | L1-L4 路線圖 + 爽點場景 + 輕問句 |
| `src/__tests__/integration.test.ts` | 🆕 17 個接縫測試 |

---

## 測試員下次測試重點

1. **新 session 測試**（重啟 Claude Code 後）：
   - `status` → 應正確顯示 Key 數量和服務數
   - `search(query="test")` → DuckDuckGo 免費搜尋
   - `setup_wizard(action=auto)` → 一鍵匯入
   - `task(task="搜尋最新消息")` → L4 fallback
2. **CLI 測試**（不需要 MCP）：
   - `clawapi keys list` → 應顯示真實 Key（不再是假資料）
   - `clawapi keys check` → 顯示真實狀態
   - `clawapi uninstall --all` → 應看到 MCP 重啟警告
   - `clawapi init` → 應看到 L1-L4 路線圖 + 四爽點場景

---

*交接人：Claude Code（老大）| 2026-03-04 凌晨*
