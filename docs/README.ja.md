[English](../README.md) · [中文版](README.zh.md)

<p align="center">
  <img src="https://img.shields.io/npm/v/@clawapi/engine?style=flat-square&color=E04040&label=npm" alt="npm version">
  <img src="https://img.shields.io/github/license/sstklen/clawapi?style=flat-square&color=4A90D9" alt="license">
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat-square" alt="bun">
  <img src="https://img.shields.io/badge/providers-15+-10B981?style=flat-square" alt="providers">
  <img src="https://img.shields.io/badge/MCP-ready-8B5CF6?style=flat-square" alt="MCP">
</p>

<h1 align="center">🦞 ClawAPI</h1>

<p align="center">
  <strong>コマンド一つ。すべてのAI。APIキーはあなたの手元に。</strong>
</p>

<p align="center">
  オープンソース AI API キーマネージャー + スマートルーター<br>
  単一のローカルエンジンで15以上のAIプロバイダーを管理 — キーはあなたのマシンから出ません。
</p>

---

## ✨ なぜ ClawAPI なのか

| | できること | 方法 |
|---|---|---|
| **① ゼロ設定セットアップ** | 環境変数のAPIキーをスキャンして検証・インポート — 10秒で完了 | `setup_wizard auto` |
| **② スマートレコメンド** | セットアップ後、次に追加すべき無料プロバイダーを教えてくれます | `growth_guide recommend` |
| **③ レート制限で詰まらない** | Groqの枠を使い切った？Geminiに自動切り替え。枠を倍にする方法も教えます | L2スマートゲートウェイ |
| **④ 使うほど賢くなる** | 匿名の使用データがルーティングを改善し、みんなが恩恵を受けます | 集合知メカニズム |

> 一つのコマンドですべてのAIキーを管理。一つのエンジンがすべてのリクエストを最適なプロバイダーに届けます。

---

## 課題

OpenAI、Anthropic、Google、DeepSeek、Groq...各所にAPIキーが散らばっています。

- 20個のプロジェクトそれぞれの `.env` ファイルにキーが保存されている
- どのキーがお金を消費しているか分からない
- プロバイダーが落ちたときに簡単に切り替えられない
- AIコーディングツール（Claude Code、Cursor）はそれぞれ別のキー設定が必要

## 解決策

```
         ┌─────────────────────────────────────────────┐
         │              ClawAPI Engine                  │
         │           （あなたのマシン上で動作）         │
         │                                              │
  あなた►│  🔑 暗号化キーボルト（AES-256-GCM）         │
         │  🧠 プロバイダー間のスマートルーティング     │
         │  📊 コスト追跡・ヘルス監視                   │
         │  🔌 ローカルホストのOpenAI互換API             │
         │                                              │
         │   キー     キー     キー     キー     キー  │
         │    │        │        │        │        │     │
         └────┼────────┼────────┼────────┼────────┼─────┘
              ▼        ▼        ▼        ▼        ▼
           OpenAI  Anthropic  Gemini  DeepSeek  Groq
                                              + 10以上
```

**あなたのキーはあなたのマシンから出ません。それだけです。**

---

## ⚡ クイックスタート

### npm経由でインストール（[Bun](https://bun.sh)が必要）

```bash
# インストール
bun add -g @clawapi/engine

# セットアップ（インタラクティブ — 最初のAPIキーを追加）
clawapi setup

# エンジンを起動
clawapi start
```

### またはバイナリをダウンロード（依存関係なし）

```bash
# macOS（Apple Silicon）
curl -fsSL https://github.com/sstklen/clawapi/releases/latest/download/clawapi-darwin-arm64 -o clawapi
chmod +x clawapi && ./clawapi setup
```

<details>
<summary>その他のプラットフォーム</summary>

| プラットフォーム | ダウンロード |
|----------|----------|
| macOS Apple Silicon | `clawapi-darwin-arm64` |
| macOS Intel | `clawapi-darwin-x64` |
| Linux x64 | `clawapi-linux-x64` |
| Windows x64 | `clawapi-win-x64.exe` |

→ [全リリース](https://github.com/sstklen/clawapi/releases)

</details>

---

## 🔌 AIコーディングツールとの連携

### Claude Code（MCP）— 推奨

**前提条件：** [Bun](https://bun.sh) または Node.js 20+ · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) がインストール済み

**ステップ1：ClawAPIをClaude Codeに追加**

```bash
claude mcp add clawapi --scope user -- bunx @clawapi/engine mcp
```

**ステップ2：Claude Codeを再起動**（ターミナルを閉じて再度開く）

**ステップ3：動作確認**

```bash
clawapi mcp --test
```

`✅ MCP Server OK` とツール数・エンジンステータスが表示されれば成功です。

> **設定はどこに保存される？** Claude CodeのMCP設定は `~/.claude.json` に保存されます。
> `cat ~/.claude.json` で確認できます。

**クイックセットアップ（任意）：** インタラクティブなプロンプトなしでデフォルト設定を生成：

```bash
clawapi setup --defaults
```

これで **14のAIツール** が使えるようになります。Claudeに聞いてみましょう：*「ClawAPIからどんなツールが使えますか？」*

| ツール | 機能 |
|------|-------------|
| `llm` | ClawAPI経由で任意のAIモデルとチャット |
| `search` | Brave/Tavily/DuckDuckGo経由でウェブ検索 |
| `translate` | DeepLまたはAI経由でテキストを翻訳 |
| `image_generate` | 画像を生成 |
| `audio_transcribe` | 音声ファイルを文字起こし |
| `embeddings` | テキスト埋め込みベクトルを生成 |
| `keys_list` | APIキーを表示 |
| `keys_add` | 新しいAPIキーを追加 |
| `status` | エンジンのヘルス状態を確認 |
| `adapters` | 対応プロバイダー一覧を表示 |
| `setup_wizard` | 初回セットアップ：環境変数のキースキャン、検証、Claw Key設定 |
| `growth_guide` | 成長ガイド：進捗、レコメンド、プールの健全性 |
| `ask` | ClawAPIに何でも質問 |
| `task` | マルチステップAIタスクを実行 |

### OpenAI SDKクライアント全般

```python
from openai import OpenAI

# OpenAIクライアントをClawAPIに向けるだけ — そのまま動きます
client = OpenAI(
    base_url="http://localhost:4141/v1",
    api_key="your-clawapi-key"
)

# ClawAPIが最適なプロバイダーを自動選択
response = client.chat.completions.create(
    model="auto",  # ClawAPIに任せるか、"gpt-4" / "claude-3" / "gemini-2" を指定
    messages=[{"role": "user", "content": "Hello!"}]
)
```

Python、Node.js、Go、Rust など OpenAI API に対応したあらゆる言語で動作します。

---

## 🧠 スマートルーティング（L1 → L4）

ClawAPIは単なるプロキシではありません — 考えます。

| レイヤー | 名前 | 機能 |
|-------|------|-------------|
| **L1** | ダイレクトプロキシ | 最速ルート。指定されたプロバイダーに直接リクエストを転送。 |
| **L2** | スマートゲートウェイ | コスト・レイテンシ・ヘルス状態に基づいて最適なプロバイダーを自動選択。 |
| **L3** | AIコンシェルジュ | 意図を理解し、適切なモデルとパラメータを選択。 |
| **L4** | タスクエンジン | 複雑なタスクをステップに分解し、複数のAI呼び出しを調整。 |

```
「このドキュメントを日本語に翻訳して要約して」

  L4タスクエンジン
   ├─ ステップ1：L1 → DeepL（翻訳）
   ├─ ステップ2：L2 → 最適なLLM（要約）
   └─ ステップ3：結果をマージ → 返却
```

---

## 🔑 鉄則

これらは機能ではありません — **保証**です。

| # | ルール | 方法 |
|---|------|-----|
| 1 | **キーはあなたのマシンから出ない** | すべてのAPI呼び出しはローカルで実行。VPSにはメタデータのみ。 |
| 2 | **VPSはAPIコンテンツを見ない** | ECDH P-256鍵交換。レイテンシ/ステータスのみ共有。 |
| 3 | **オフラインでも動作** | インターネットなしで全機能が使用可能。VPSはオプション。 |

---

## 📦 対応プロバイダー

| プロバイダー | モデル | タイプ |
|----------|--------|------|
| **OpenAI** | GPT-4o, GPT-4, o1, o3 | LLM |
| **Anthropic** | Claude 4, Claude 3.5 Sonnet | LLM |
| **Google** | Gemini 2.5, Gemini 2.0 Flash | LLM |
| **DeepSeek** | DeepSeek-V3, DeepSeek-R1 | LLM |
| **Groq** | Llama 3, Mixtral（超高速）| LLM |
| **Cerebras** | Llama 3（最速推論）| LLM |
| **SambaNova** | Llama 3（高速推論）| LLM |
| **OpenRouter** | 200以上のモデル（アグリゲーター）| LLM |
| **Qwen** | Qwen-2.5 | LLM |
| **Ollama** | 任意のローカルモデル | LLM |
| **Brave Search** | ウェブ検索 | Search |
| **Tavily** | AI駆動の検索 | Search |
| **DuckDuckGo** | ウェブ検索（無料）| Search |
| **DeepL** | 30以上の言語 | Translation |
| **+** | コミュニティアダプター（YAML）| 拡張可能 |

30行のYAMLで独自プロバイダーを追加できます。コーディング不要。

---

## 🛠 フルCLIコマンド

```
エンジン    start · stop · status
キー       keys add · list · remove · pin · rotate · import · check
Claw Key   claw-key set · show · remove
サブキー   sub-keys issue · list · revoke · usage
相互支援   aid config · stats · donate
アダプター adapters list · install · remove · update
テレメトリ telemetry show · toggle
バックアップ backup export · import
システム   logs · config · setup · doctor · version · mcp
```

**30以上のコマンド。** 3言語対応（英語、繁体字中国語、日本語）。

---

## 🏗 アーキテクチャ

```
┌─────────────────────────────┐          ┌────────────────────────┐
│      ClawAPI Engine         │          │     ClawAPI VPS        │
│      （あなたのマシン）     │  ECDH    │     （オプションのクラウド）│
│                             │◄────────►│                        │
│  🔐 キーボルト（AES-256）  │ メタデータ│  📋 デバイスレジストリ  │
│  🧠 スマートルーター（L1-L4）│   のみ  │  📊 テレメトリ集計     │
│  🌐 OpenAI互換API          │          │  🤝 相互支援マッチング │
│  🔧 MCPサーバー（14ツール） │          │  🔍 異常検知           │
│  💻 CLI（30以上のコマンド） │          │                        │
│  🖥  Web UI（SSR + HTMX）  │          │                        │
└─────────────────────────────┘          └────────────────────────┘
      キーはここに ☝️                         あなたのキーは見ません
```

## 🔒 セキュリティ

- **AES-256-GCM** による保存時暗号化
- **ECDH P-256** によるVPSとの鍵交換
- **1,681件のテスト**、失敗ゼロ
- 三重コードレビュー（自己レビュー + Codex + Opusクロスレビュー）
- 5者セキュリティ監査手法
- 非rootのDocker実行
- すべてのエンドポイントにレート制限

## 技術スタック

| コンポーネント | 技術 |
|-----------|-----------|
| ランタイム | [Bun](https://bun.sh) |
| フレームワーク | [Hono](https://hono.dev) |
| データベース | SQLite (bun:sqlite) |
| 言語 | TypeScript |
| パッケージング | Bun compile（4プラットフォームバイナリ）|
| コンテナ | Docker + Caddy |

---

## 📝 ライセンス

**AGPL-3.0** — 自由に使用・改変・配布できます。コントリビューションを歓迎します。

詳細は [LICENSE](../LICENSE) をご覧ください。

---

<p align="center">
  <sub>🦞 <a href="https://github.com/sstklen">sstklen</a> が房総半島から届けます</sub>
</p>
