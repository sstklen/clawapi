# ClawAPI v0.1.11 完整 Bug Report — MCP + CLI 全面審計

> **測試日期：** 2026-03-02
> **環境：** macOS (darwin arm64), Bun 1.3.7, Claude Code
> **測試版本：** @clawapi/engine@0.1.11
> **測試方式：** 從已安裝狀態出發，逐一測試所有 CLI 指令 + MCP 啟動 + doctor 診斷
> **測試人：** tkman 的 AI 特助（Claude Code）

---

## 問題總覽

| # | 嚴重度 | 問題 | 狀態 |
|---|--------|------|------|
| 1 | 🔴 P0 | React 未列入 dependencies，MCP 啟動 crash | ✅ 已修（手動補裝） |
| 2 | 🔴 P0 | doctor 不檢查 MCP 能不能啟動 | ❌ 待修 |
| 3 | 🟡 P1 | doctor 在 engine 運行中報 Port FAIL | ❌ 待修 |
| 4 | 🟡 P1 | --help 子指令全部回傳 global help | ❌ 待修 |
| 5 | 🟡 P1 | --locale 語言切換無效 | ❌ 待修 |
| 6 | 🟡 P1 | VPS URL：config vs doctor 不一致 | ❌ 待修 |
| 7 | 🟡 P1 | MCP stderr 洩漏 info 訊息 | ❌ 待修 |
| 8 | 🟡 P1 | init DuckDuckGo demo 誤報網路不通 | ❌ 待修 |
| 9 | 🟢 P2 | config 模板 user_agent 註解版號過時 | ❌ 待修 |
| 10 | 🟢 P2 | npm 撞名（clawapi vs @clawapi/engine） | ❌ 待修 |
| 11 | 🟢 P2 | aid stats 與 config enabled 狀態矛盾 | ❌ 待修 |

---

## 🔴 P0 — 安裝即壞

### #1 — `react` 未列入 dependencies，MCP 啟動直接 crash

**復現步驟：**
```bash
bun install -g @clawapi/engine
clawapi init
# 重啟 Claude Code → MCP disconnected
```

**錯誤訊息：**
```
[ClawAPI MCP] 初始化引擎...
[ClawAPI MCP] 啟動失敗：Cannot find module 'react/jsx-dev-runtime'
  from '~/.bun/install/global/node_modules/@clawapi/engine/src/ui/pages/dashboard.tsx'
```

**根因分析：**
- `src/ui/pages/dashboard.tsx` 使用 JSX → 需要 `react/jsx-dev-runtime`
- `package.json` 的 `dependencies` 沒有 `react`，`peerDependencies` 也沒有
- `files` 欄位包含 `src/**/*.tsx` → 這些 TSX 檔案會發佈到 npm
- 全局安裝時不會自動拉 React → MCP 啟動 100% crash

**影響範圍：**
- 所有透過 `bun install -g` 或 `npm install -g` 安裝的使用者
- MCP 連不上 = ClawAPI 在 Claude Code 裡完全不能用
- doctor 報全 PASS → 使用者不知道為什麼不能用，會以為是 Claude Code 的問題

**已驗證的 Workaround：**
```bash
cd ~/.bun/install/global && bun add react react-dom
# 補裝後 MCP 正常啟動，回傳正確的 JSON-RPC initialize 回應
```

**建議修法（三選一）：**

A. 最簡單 — 加到 dependencies：
```json
"dependencies": {
  "react": "^19.0.0",
  "react-dom": "^19.0.0"
}
```

B. 最乾淨 — MCP 入口不載入 UI 模組：
```typescript
// src/mcp/index.ts
// 不要 import dashboard.tsx，MCP 不需要 UI
// UI 相關的只在 clawapi start（HTTP server）時才載入
```

C. 折衷 — 加到 peerDependencies + 安裝時提示：
```json
"peerDependencies": {
  "react": "^19.0.0"
}
```
但 bun/npm 全局安裝不一定會裝 peer deps，所以 B 方案比較靠譜。

---

### #2 — `clawapi doctor` 不檢查 MCP 能不能啟動

**現象：**
MCP 因缺 React 完全無法啟動，但 `clawapi doctor` 報告 7 項全 PASS。

**影響：**
使用者按文件跑 `clawapi doctor` 確認「一切正常」→ 信心滿滿重啟 Claude Code → MCP 不能用 → 矛盾。

**建議：**
增加一個 `MCP startup` 檢查項：
```
PASS  MCP startup  (13 tools registered, 21 adapters)
```
做法：嘗試 require MCP 入口模組、或呼叫 initialize handler，確認不會 throw。

---

## 🟡 P1 — Bug

### #3 — `doctor` 在 engine 運行中報 Port FAIL

**復現：**
```bash
clawapi start --daemon   # Engine 啟動在 4141
clawapi status           # ✅ Running, PID: 76833
clawapi doctor           # ❌ Port 4141 is in use
```

**問題：** Engine 自己佔了 port，doctor 不知道是自己人，報 FAIL。

**建議：** 檢查 port 被誰佔。如果是 ClawAPI engine → PASS（"Port in use by ClawAPI engine"）；如果是別的程序 → FAIL。

---

### #4 — `--help` 子指令全部回傳 global help

**復現：**
```bash
clawapi init --help      # 回傳 global help
clawapi mcp --help       # 回傳 global help
clawapi keys --help      # 回傳 global help
clawapi keys add --help  # 回傳 global help
```

**期望：** 各指令有自己的 help，顯示該指令的 flags 和用法。

---

### #5 — `--locale` 語言切換無效

**復現：**
```bash
clawapi version --locale ja
# 輸出：ClawAPI v0.1.11 / Runtime: Bun 1.3.7 / Platform: darwin arm64
# 期望：日文輸出
```

`--locale en` 和 `--locale ja` 產出完全一樣。`config.yaml` 裡的 `locale: 'zh-TW'` 也沒影響 `version` 輸出。

---

### #6 — VPS URL：config 跟 doctor 對不上

**config.yaml：**
```yaml
vps:
  base_url: 'https://api.clawapi.com'
```

**doctor 輸出：**
```
PASS  VPS reachable (clawapi.washinmura.jp)
```

兩個不同的 domain。doctor 到底在 ping 哪個？如果是硬編碼的 `clawapi.washinmura.jp`，應該改成讀 config。

---

### #7 — MCP stderr 洩漏 info-level 訊息

**現象：**
```
[ClawAPI MCP] 初始化引擎...
[ClawAPI MCP] 引擎初始化完成
[ClawAPI MCP] MCP Server 就緒（21 個 Adapter）
```

這些 info 級訊息輸出到 stderr。

**為什麼有問題：**
MCP stdio 協議：stdout = JSON-RPC、stderr = 僅 error 或靜默。
Claude Code 目前容忍 stderr 有內容，但其他 MCP 客戶端可能會斷線。

**建議：** MCP 模式下 stderr 只輸出 error level，或提供 `--quiet` / `--silent` flag。

---

### #8 — `init` DuckDuckGo Demo 誤報「網路不通」

**復現：**
```bash
# DuckDuckGo 可連線
curl -s -o /dev/null -w "%{http_code}" "https://duckduckgo.com/?q=test"
# → 202

# 但 init 說不通
clawapi init --no-mcp
# → 搜尋 demo 跳過（網路不通或 API 暫時不可用）
```

可能原因：init 呼叫的是 DuckDuckGo API（`api.duckduckgo.com`），不是首頁。或超時設太短。

**建議：** 調高超時，或改成更可靠的測試端點（如自己的 VPS health check）。

---

## 🟢 P2 — 小問題

### #9 — config 模板 user_agent 註解版號過時

```yaml
# user_agent: 'ClawAPI/0.1.5'
```

當前版本 0.1.11。這是 `clawapi init` 自動產生的模板。

**建議：** 模板裡用動態版號，或乾脆拿掉版號註解。

---

### #10 — npm 撞名

- `clawapi@1.1.1`（無 scope）= 別人的 Playwright 自動化工具
- `@clawapi/engine@0.1.11`（有 scope）= 本專案

`npm search clawapi` 或手滑 `bun add clawapi` 會裝到別人的。

**建議：**
- `doctor` 檢查：如果偵測到無 scope 的 `clawapi` 已安裝 → 警告
- 長期：考慮聯繫 npm 處理名稱爭議

---

### #11 — `aid stats` 與 config 的 enabled 狀態矛盾

**config.yaml：**
```yaml
aid:
  enabled: false
```

**aid stats 輸出：**
```
Status：Enabled
Helped others today：8 times
```

config 說 disabled 但 stats 顯示 enabled 且有數據。如果是 demo/seed data，應標示清楚。

---

## 正常運作的部分（測試通過）

| 功能 | 結果 |
|------|------|
| `clawapi version` | ✅ 正確顯示版本 |
| `clawapi keys list` | ✅ 正確顯示（有 1 把 Groq key） |
| `clawapi keys list --json` | ✅ 結構化 JSON 輸出 |
| `clawapi keys list --plain` | ✅ 無色彩純文字 |
| `clawapi keys check` | ✅ 健康檢查正常（120ms） |
| `clawapi config show` | ✅ 完整顯示 |
| `clawapi adapters list` | ✅ 6 個 built-in adapter |
| `clawapi status` | ✅ 正確顯示 Running/Stopped |
| `clawapi status --json` | ✅ JSON 格式 |
| `clawapi doctor --json` | ✅ 結構化診斷結果 |
| `clawapi start --daemon` | ✅ 背景啟動成功 |
| `clawapi stop` | ✅ 正常停止 |
| `clawapi migrate` | ✅ DB migration 成功 |
| `clawapi gold-key show` | ✅ 顯示 Gold Key 設定 |
| `clawapi sub-keys list` | ✅ 顯示 sub-key 列表 |
| `curl localhost:4141/health` | ✅ 回傳正確 JSON |
| MCP initialize（修 React 後） | ✅ 回傳正確 protocolVersion |
| MCP tools/list（修 React 後） | ✅ 回傳 13 個 tools |
| 錯誤指令處理 | ✅ 正確報錯 + 提示 --help |

---

## MCP Tools 清單（13 個，全部可列出）

| Tool | 用途 |
|------|------|
| `llm` | 呼叫 LLM，自動路由 |
| `search` | 網路搜尋（DuckDuckGo 等） |
| `translate` | 翻譯 |
| `ask` | AI 管家（自然語言問答） |
| `task` | 多步驟任務引擎 |
| `embeddings` | 文字向量嵌入 |
| `image_generate` | 圖片生成 |
| `audio_transcribe` | 語音轉文字 |
| `keys_list` | 列出 Key 池 |
| `keys_add` | 新增 Key |
| `status` | 引擎狀態 |
| `adapters` | Adapter 列表 |
| `setup_wizard` | 設定引導（auto 模式全自動） |
| `growth_guide` | 成長引導 |

---

## 整體評價

**CLI 設計很乾淨：**
- `--json` / `--plain` 雙模式做得好，CI/CD 友善
- 指令分組清楚（keys / gold-key / sub-keys / aid / adapters）
- 錯誤處理不錯，未知指令有明確提示

**主要問題集中在 onboarding：**
- React 缺失讓 MCP 啟動失敗（P0 #1）
- doctor 抓不到 MCP 問題（P0 #2）
- 這兩個修好，新使用者的第一次體驗就通了

**其他都是打磨級別的：**
- help 系統、locale、doctor 邏輯 — 有空再修不急
