# ClawAPI 交接文件

> 日期：2026-03-03 | 摘要：UX 大修 + sub-keys + 測試員 6 bug 全修完
> Git：待 commit | 測試：1653/0 | Build：四平台 ✅ | 全局安裝 ✅

---

## 已完成（前前 session）

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

---

## 已完成（前 session）

### P1-2 + P1-5：sub-keys CLI 非互動模式

`clawapi sub-keys issue` 現在支援非互動 CLI 旗標：

```bash
# 最簡（只需 --label）
clawapi sub-keys issue --label "龍蝦001"

# 完整參數
clawapi sub-keys issue --label "朋友A" --expire 7 --limit 50 --rate 120 --services "groq,openai"

# JSON 輸出（適合腳本/程式解析）
clawapi sub-keys issue --label "API" --json
```

### 爽點完整版輸出（setup-wizard.ts）
- 成長路線圖 L1→L4 + 四爽點全景 + 兩個輕問句
- 每個爽點附具體場景描述
- 檔案：`src/mcp/tools/setup-wizard.ts`, `src/mcp/server.ts`, `src/mcp/__tests__/delight-points.test.ts`

---

## 已完成（本 session）

### 測試員報告的 6 個 Bug — 全部修復

**Root A：master.key 與 data.db 脫鉤**

| Bug | 修法 | 檔案 |
|-----|------|------|
| A1 uninstall 刪 master.key 留 data.db → 全部解密失敗 | master.key 移到 dataFiles（與 data.db 一對） | `src/cli/commands/uninstall.ts` |
| A2 status 誤報健康（解密失敗也報正常）| listKeys 回傳有 `(解密失敗)` 標記，status 獨立統計 + 警告 | `src/mcp/tools/status.ts` |
| A3 uninstall→init 產生重複 Key | addKey() 先解密比對，已存在就回傳現有 id | `src/core/key-pool.ts` |

**Root B：DuckDuckGo 免費路由**

| Bug | 修法 | 檔案 |
|-----|------|------|
| B1 DuckDuckGo 免 Key 但路由要求 Key | L2Gateway 加入 `requires_key: false` 的 adapter 到候選 + 佔位 Key | `src/layers/l2-gateway.ts` |

**Root C：L4 任務引擎 fallback**

| Bug | 修法 | 檔案 |
|-----|------|------|
| C1 L4 任務引擎要求 CLAW_KEY 環境變數 | getClawKey() 先找 __claw_key__ → 找不到用任何 LLM Key | `src/layers/l4-task.ts` |

### 驗證結果
- `bun test --recursive`：1653 pass / 0 fail ✅
- 四平台 build ✅
- 全局安裝 ✅
- CLI 版本確認 v0.1.12 ✅

---

## 未完成

- **Git commit**：所有改動尚未 commit（UX 大修 + sub-keys + 6 bug fix）
- 完整流程測試（uninstall → init → 重開 session → 測所有工具）建議在 commit 前做

---

## 改動檔案總覽（本 session 3 bug fix）

| 檔案 | 改動 |
|------|------|
| `src/layers/l2-gateway.ts` | 免費服務候選 + createFreeServiceKey() |
| `src/mcp/tools/status.ts` | 解密失敗偵測 + 警告訊息 |
| `src/core/key-pool.ts` | addKey() 重複檢查 |

---

## 測試員下次測試重點

1. `search(query="test")` → DuckDuckGo 免費搜尋應該能用了
2. `status` → 如果 master.key 不匹配，應顯示「N 個 Key 解密失敗」警告
3. `clawapi uninstall` → `clawapi init` → Key 不應重複
4. `task(task="搜尋最新消息")` → L4 引擎應能 fallback 到一般 LLM Key
5. `clawapi sub-keys issue --label "test" --json` → 不問問題直接出 JSON

---

*交接人：Claude Code（老大）| 2026-03-03 深夜*
