[English](../README.md) · [日本語](README.ja.md)

<p align="center">
  <img src="https://img.shields.io/npm/v/@clawapi/engine?style=flat-square&color=E04040&label=npm" alt="npm version">
  <img src="https://img.shields.io/github/license/sstklen/clawapi?style=flat-square&color=4A90D9" alt="license">
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat-square" alt="bun">
  <img src="https://img.shields.io/badge/providers-15+-10B981?style=flat-square" alt="providers">
  <img src="https://img.shields.io/badge/MCP-ready-8B5CF6?style=flat-square" alt="MCP">
</p>

<h1 align="center">🦞 ClawAPI</h1>

<p align="center">
  <strong>一個指令。所有 AI。金鑰永遠在你手上。</strong>
</p>

<p align="center">
  開源 AI API 金鑰管理器 + 智慧路由引擎<br>
  用單一本地引擎管理 15+ AI 服務供應商 — 金鑰從不離開你的機器。
</p>

---

## ✨ 為什麼選 ClawAPI

| | 做了什麼 | 怎麼做到 |
|---|---|---|
| **① 零設定啟動** | 掃描環境變數裡的 API 金鑰，驗證並匯入 — 10 秒搞定 | `setup_wizard auto` |
| **② 智慧推薦** | 設定完成後，告訴你下一步應該加哪個免費服務商 | `growth_guide recommend` |
| **③ 永遠不卡流量限制** | Groq 額度用完？自動切到 Gemini，並告訴你怎麼加倍額度 | L2 智慧閘道 |
| **④ 越用越聰明** | 匿名使用資料持續改善路由效果，讓所有人受益 | 集體智慧機制 |

> 一個指令管理所有 AI 金鑰。一個引擎把每個請求導向最佳供應商。

---

## 問題所在

你的 API 金鑰散落在 OpenAI、Anthropic、Google、DeepSeek、Groq 各處……

- 金鑰存在 20 個專案各自的 `.env` 檔裡
- 不知道哪個金鑰在燒錢
- 某個服務掛掉時很難臨時切換
- AI 程式碼工具（Claude Code、Cursor）各自需要獨立設定金鑰

## 解決方案

```
         ┌─────────────────────────────────────────────┐
         │              ClawAPI Engine                  │
         │           （跑在你自己的機器上）             │
         │                                              │
  你 ───►│  🔑 加密金鑰保險庫（AES-256-GCM）           │
         │  🧠 跨供應商智慧路由                         │
         │  📊 成本追蹤與健康監控                       │
         │  🔌 本地端 OpenAI 相容 API                   │
         │                                              │
         │   金鑰    金鑰    金鑰    金鑰    金鑰       │
         │    │       │       │       │       │          │
         └────┼───────┼───────┼───────┼───────┼──────────┘
              ▼       ▼       ▼       ▼       ▼
           OpenAI  Anthropic  Gemini  DeepSeek  Groq
                                              + 10 家以上
```

**你的金鑰永遠不離開你的機器。就這樣。**

---

## ⚡ 快速開始

### 透過 npm 安裝（需要 [Bun](https://bun.sh)）

```bash
# 安裝
bun add -g @clawapi/engine

# 設定（互動式 — 新增第一把 API 金鑰）
clawapi setup

# 啟動引擎
clawapi start
```

### 或下載二進位執行檔（無需依賴套件）

```bash
# macOS（Apple Silicon）
curl -fsSL https://github.com/sstklen/clawapi/releases/latest/download/clawapi-darwin-arm64 -o clawapi
chmod +x clawapi && ./clawapi setup
```

<details>
<summary>其他平台</summary>

| 平台 | 下載檔名 |
|----------|----------|
| macOS Apple Silicon | `clawapi-darwin-arm64` |
| macOS Intel | `clawapi-darwin-x64` |
| Linux x64 | `clawapi-linux-x64` |
| Windows x64 | `clawapi-win-x64.exe` |

→ [所有版本](https://github.com/sstklen/clawapi/releases)

</details>

---

## 🔌 搭配 AI 程式碼工具使用

### Claude Code（MCP）— 推薦方式

**前置條件：** 已安裝 [Bun](https://bun.sh) 或 Node.js 20+ · 已安裝 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

**第一步：將 ClawAPI 加入 Claude Code**

```bash
claude mcp add clawapi --scope user -- bunx @clawapi/engine mcp
```

**第二步：重新啟動 Claude Code**（關掉終端機再重開）

**第三步：確認運作正常**

```bash
clawapi mcp --test
```

應該會看到：`✅ MCP Server OK`，並顯示工具數量和引擎狀態。

> **設定檔存在哪？** Claude Code 的 MCP 設定儲存在 `~/.claude.json`。
> 可以用 `cat ~/.claude.json` 查看。

**快速設定（選用）：** 略過互動式提示，直接產生預設設定：

```bash
clawapi setup --defaults
```

設定完成後你擁有 **14 個 AI 工具**。問 Claude：*「你從 ClawAPI 取得了哪些工具？」*

| 工具 | 功能說明 |
|------|-------------|
| `llm` | 透過 ClawAPI 與任何 AI 模型對話 |
| `search` | 透過 Brave/Tavily/DuckDuckGo 進行網路搜尋 |
| `translate` | 透過 DeepL 或 AI 翻譯文字 |
| `image_generate` | 生成圖片 |
| `audio_transcribe` | 轉錄音訊檔案 |
| `embeddings` | 生成文字嵌入向量 |
| `keys_list` | 查看你的 API 金鑰 |
| `keys_add` | 新增一把 API 金鑰 |
| `status` | 查看引擎健康狀態 |
| `adapters` | 列出支援的供應商 |
| `setup_wizard` | 初次設定：掃描環境變數金鑰、驗證、設定 Claw Key |
| `growth_guide` | 成長指南：進度、推薦、池子健康狀態 |
| `ask` | 詢問 ClawAPI 任何問題 |
| `task` | 執行多步驟 AI 任務 |

### 任何 OpenAI SDK 客戶端

```python
from openai import OpenAI

# 把任何 OpenAI 客戶端指向 ClawAPI — 直接能用
client = OpenAI(
    base_url="http://localhost:4141/v1",
    api_key="your-clawapi-key"
)

# ClawAPI 自動選擇最佳可用供應商
response = client.chat.completions.create(
    model="auto",  # 讓 ClawAPI 決定，或指定 "gpt-4" / "claude-3" / "gemini-2"
    messages=[{"role": "user", "content": "Hello!"}]
)
```

支援：Python、Node.js、Go、Rust — 任何能使用 OpenAI API 的語言都行。

---

## 🧠 智慧路由（L1 → L4）

ClawAPI 不只是代理轉發 — 它會思考。

| 層級 | 名稱 | 功能 |
|-------|------|-------------|
| **L1** | 直接代理 | 最快路徑，直接把請求送到指定供應商。 |
| **L2** | 智慧閘道 | 依據成本、延遲和健康狀態自動選擇最佳供應商。 |
| **L3** | AI 禮賓 | 理解意圖，選擇正確的模型與參數。 |
| **L4** | 任務引擎 | 把複雜任務拆解成步驟，協調多個 AI 呼叫。 |

```
「把這份文件翻譯成日文並摘要」

  L4 任務引擎
   ├─ 步驟 1：L1 → DeepL（翻譯）
   ├─ 步驟 2：L2 → 最佳 LLM（摘要）
   └─ 步驟 3：合併結果 → 回傳
```

---

## 🔑 鐵律

這些不是功能 — 這些是**保證**。

| # | 規則 | 做法 |
|---|------|-----|
| 1 | **金鑰永不離開你的機器** | 所有 API 呼叫在本地執行。VPS 只看到元資料。 |
| 2 | **VPS 永不看到 API 內容** | ECDH P-256 金鑰交換。只共享延遲/狀態資訊。 |
| 3 | **離線也能運作** | 不需網路即可使用完整功能。VPS 是選用的。 |

---

## 📦 支援的供應商

| 供應商 | 模型 | 類型 |
|----------|--------|------|
| **OpenAI** | GPT-4o, GPT-4, o1, o3 | LLM |
| **Anthropic** | Claude 4, Claude 3.5 Sonnet | LLM |
| **Google** | Gemini 2.5, Gemini 2.0 Flash | LLM |
| **DeepSeek** | DeepSeek-V3, DeepSeek-R1 | LLM |
| **Groq** | Llama 3, Mixtral（超快速）| LLM |
| **Cerebras** | Llama 3（最快推論）| LLM |
| **SambaNova** | Llama 3（快速推論）| LLM |
| **OpenRouter** | 200+ 模型（聚合器）| LLM |
| **Qwen** | Qwen-2.5 | LLM |
| **Ollama** | 任何本地模型 | LLM |
| **Brave Search** | 網路搜尋 | Search |
| **Tavily** | AI 驅動搜尋 | Search |
| **DuckDuckGo** | 網路搜尋（免費）| Search |
| **DeepL** | 30+ 語言 | Translation |
| **+** | 社群擴充介面卡（YAML）| 可延伸 |

只需 30 行 YAML 即可新增自訂供應商。不需要寫程式碼。

---

## 🛠 完整 CLI 指令

```
引擎      start · stop · status
金鑰      keys add · list · remove · pin · rotate · import · check
Claw Key  claw-key set · show · remove
子金鑰    sub-keys issue · list · revoke · usage
互助      aid config · stats · donate
介面卡    adapters list · install · remove · update
遙測      telemetry show · toggle
備份      backup export · import
系統      logs · config · setup · doctor · version · mcp
```

**30+ 個指令。** 支援 3 種語言（英文、繁體中文、日本語）。

---

## 🏗 架構

```
┌─────────────────────────────┐          ┌────────────────────────┐
│      ClawAPI Engine         │          │     ClawAPI VPS        │
│      （你的機器）           │  ECDH    │     （選用雲端）       │
│                             │◄────────►│                        │
│  🔐 金鑰保險庫（AES-256）  │ 元資料   │  📋 設備登錄表         │
│  🧠 智慧路由（L1-L4）      │   僅此   │  📊 遙測聚合           │
│  🌐 OpenAI 相容 API        │          │  🤝 互助媒合           │
│  🔧 MCP 伺服器（14 工具）  │          │  🔍 異常偵測           │
│  💻 CLI（30+ 指令）        │          │                        │
│  🖥  Web UI（SSR + HTMX）  │          │                        │
└─────────────────────────────┘          └────────────────────────┘
      金鑰存在這裡 ☝️                         永不看到你的金鑰
```

## 🔒 安全性

- **AES-256-GCM** 靜態加密
- **ECDH P-256** 與 VPS 的金鑰交換
- **1,681 個測試**，0 次失敗
- 三重程式碼審查（自審 + Codex + Opus 交叉審查）
- 五方安全稽核方法論
- 非 root Docker 執行
- 所有端點均有速率限制

## 技術棧

| 元件 | 技術 |
|-----------|-----------|
| 執行環境 | [Bun](https://bun.sh) |
| 框架 | [Hono](https://hono.dev) |
| 資料庫 | SQLite (bun:sqlite) |
| 語言 | TypeScript |
| 打包 | Bun compile（4 平台二進位檔）|
| 容器 | Docker + Caddy |

---

## 🩺 內含：Dr. Claw — AI 除錯知識庫

本 repo 包含 [**Dr. Claw**](../drclaw/) — 記住每個解過的 bug 的 AI 除錯知識庫。問一次，不再重複。

- 6,800+ 個問題索引，980+ 個已驗證修復
- MCP Server + REST API
- 從 Confucius Debug 獨立出來，現在住在 `clawapi/drclaw/`

## 📝 授權條款

**AGPL-3.0** — 可自由使用、修改和散布。歡迎貢獻。

詳見 [LICENSE](../LICENSE)。

---

## 搭配使用

- **Opus Relay** ([`sstklen/opus-relay`](https://github.com/sstklen/opus-relay)) — 把本機 Claude CLI 橋接到任何 VPS。ClawAPI 管金鑰，Opus Relay 橋接算力。

---

<p align="center">
  <sub>由 <a href="https://github.com/sstklen">sstklen</a> 在日本房總半島用 🦞 打造</sub>
</p>
