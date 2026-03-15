# 終端 1 啟動 Prompt — SPEC-A 開源引擎規格書

> 複製以下內容，貼到新的 Claude Code 終端。

---

```
你是 ClawAPI 的首席架構師，現在要寫 SPEC-A：開源引擎規格書。

## 背景

ClawAPI 是一個開源的 AI API 鑰匙管理器 + 智慧路由器（AGPL-3.0）。
龍蝦（使用者）把各家 API Key 丟進來，系統幫你統一管理、自動切換、智慧調度。

技術棧：Bun + Hono + SQLite + TypeScript

戰略定位：ClawAPI 可以作為 OpenClaw 的「超級 Key 管理器」——
用戶在 OpenClaw 裡設定 ClawAPI 為 custom provider（baseUrl: http://localhost:4141/v1），
就能享受 Key 池輪替、集體智慧、互助等功能。OpenAI 相容 API 是核心。

## 你的任務

寫 SPEC-A（開源引擎規格書），這是裝在龍蝦自己電腦上跑的部分。

## 必讀文件（先讀完再動筆）

1. 計畫書（170 項已確認決策）：
   ~/Desktop/ClawAPI/docs/ClawAPI_完整計畫書_v1.md

2. 通訊協議（開源引擎 ↔ VPS 的合約）：
   ~/Desktop/ClawAPI/specs/ClawAPI_SPEC-C_通訊協議_v1.md

## 規格書要寫什麼

輸出檔案：~/Desktop/ClawAPI/specs/ClawAPI_SPEC-A_開源引擎_v1.md

### 必須涵蓋的章節：

1. **模組架構圖** — 哪個模組依賴哪個，畫出清楚的依賴關係
2. **每個模組的公開 API** — 函數簽名 + 參數 + 回傳值 + 錯誤（TypeScript interface）
3. **內部資料結構** — 所有 TypeScript type/interface 完整定義
4. **DB Schema 精確版** — 含 index、constraint、migration 策略、完整 SQL
5. **五層路由引擎** — L0/L1/L2/L3/L4 各層的精確處理邏輯、判斷流程、邊界條件
6. **Key 池管理** — 選 Key 的優先順序：龍蝦王池 → 親友分身池 → L0 公共池 → 互助池（注意：L0 在互助前面，因為 L0 離線可用）
7. **API 端點完整清單** — OpenAI 相容 API（/v1/chat/completions 等，含 SSE streaming）+ ClawAPI 簡化 API + MCP tools，每個端點的 Request/Response
8. **CLI 命令完整規格** — 每個命令的參數、輸出格式、錯誤處理、互動流程
9. **MCP Server 規格** — tools 清單、每個 tool 的 inputSchema/outputSchema
10. **設定檔 config.yaml 完整 schema** — 所有設定項、型別、預設值、說明
11. **Adapter YAML schema v1** — 精確的 YAML 格式定義、驗證規則、三層安全掃描規則
12. **安全模型** — Key 加密流程（AES-256-GCM）、auth.token 機制、Adapter 沙箱、ECDH P-256 金鑰對管理（互助加密用）
13. **L0 免費層** — 公共 Key 快取機制、限額控制、自動升級邏輯
14. **互助客戶端邏輯** — 非同步設計（POST 拿 202 → WebSocket 等 aid_result）、ECDH 公鑰交換、加密流程、收到結果後的處理
15. **Sub-Key 系統** — 發行、驗證（含 VPS 中繼驗證 #129）、撤銷、用量追蹤的完整流程
16. **Web UI 架構** — HTMX + SSR 的頁面結構、每個頁面的功能和資料流
17. **錯誤碼完整清單** — 錯誤碼格式統一用 SCREAMING_SNAKE_CASE（如 AUTH_INVALID_TOKEN），每個錯誤的觸發條件、回傳格式、建議修復
18. **VPS 通訊模組** — 實作 SPEC-C 客戶端那一邊的所有邏輯：
    - HTTPS 客戶端（所有 REST 端點）
    - WebSocket 客戶端（routing + notifications + chat 頻道）
    - 離線數據堆積 + VPS 恢復後自動補傳
    - 路由推薦回饋（thumbs-down 機制 #86）
    - 裝置註冊時取得 VPS 公鑰 + region
19. **測試計畫** — 每個模組的測試策略、mock 方式、覆蓋率目標
20. **效能預算** — 啟動時間、記憶體用量、請求延遲的目標值
21. **OpenClaw 相容性** — 確保 OpenAI 相容 API 完整支持 SSE streaming，讓 OpenClaw 能無縫接入

### 寫作風格：

- 精確到可以直接拿來寫程式碼的程度
- 每個函數都有完整的 TypeScript 簽名
- 每個邊界條件都寫清楚（如果 X 怎樣 → 做 Y）
- 用程式碼區塊（```typescript）定義所有介面
- 用表格整理端點、命令、錯誤碼
- 流程用 ASCII 圖 或 步驟列表說明

### 注意事項：

- SPEC-C 通訊協議是合約，你這邊的實作必須完全符合 SPEC-C 的型別定義
- @clawapi/protocol 共享型別包已在 SPEC-C 附錄 B 定義，直接引用不要重複定義
- SPEC-C 的互助已改為非同步（202 + WebSocket callback），不是同步 200
- SPEC-C 新增了 region 欄位（裝置註冊 + 路由建議），要在客戶端正確處理
- SPEC-C 新增了 ECDH P-256 公鑰交換機制（互助加密基礎），引擎啟動時要產生金鑰對
- SPEC-C 新增了路由回饋端點（POST /v1/telemetry/feedback），要在 UI 和 CLI 暴露
- SPEC-C 新增了 Sub-Key VPS 驗證中繼（POST /v1/subkeys/validate），引擎要處理 WebSocket 驗證請求
- L0、互助、Sub-Key 都是核心功能，不能省略
- Key 池順序：龍蝦王池 → 親友分身池 → L0 公共池 → 互助池（L0 在互助前面）
- 集體智慧上報頻率：每 1 小時（不是 15 分鐘）
- 計畫書中的決策（#1-#170）是最終決定，規格書要忠實實現
- 規格書裡的中文註釋要用繁體中文

## 工作方式

你是 Opus，底下帶 Sonnet 子代理。
- Opus 負責：整體架構設計、模組介面定義、安全模型、關鍵演算法
- Sonnet 子代理負責：每個模組的詳細 API、DB Schema SQL、CLI 命令列表、錯誤碼列表

先讀完兩份文件，再開始寫。一次寫完，不要分段問。
```
