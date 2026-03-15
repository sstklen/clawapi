[中文版](docs/README.zh.md) · [日本語版](docs/README.ja.md)

<p align="center">
  <img src="https://img.shields.io/npm/v/@clawapi/engine?style=flat-square&color=E04040&label=npm" alt="npm version">
  <img src="https://img.shields.io/github/license/sstklen/clawapi?style=flat-square&color=4A90D9" alt="license">
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat-square" alt="bun">
  <img src="https://img.shields.io/badge/providers-15+-10B981?style=flat-square" alt="providers">
  <img src="https://img.shields.io/badge/MCP-ready-8B5CF6?style=flat-square" alt="MCP">
</p>

<h1 align="center">🦞 ClawAPI</h1>

<p align="center">
  <strong>One command. Every AI. Your keys stay home.</strong>
</p>

<p align="center">
  Open-source AI API Key Manager + Smart Router<br>
  Manage 15+ AI providers from a single local engine — keys never leave your machine.
</p>

---

## ✨ Why ClawAPI

| | What happens | How |
|---|---|---|
| **① Zero-config setup** | Scans your env for API keys, validates, imports — done in 10 seconds | `setup_wizard auto` |
| **② Smart recommendations** | After setup, tells you exactly which free provider to add next | `growth_guide recommend` |
| **③ Never stuck on rate limits** | Groq quota hit? Auto-switches to Gemini. Tells you how to double your quota | L2 Smart Gateway |
| **④ Gets smarter over time** | Anonymous usage data improves routing for everyone | Collective Intelligence |

> One command to manage all your AI keys. One engine that routes every request to the best provider.

---

## The Problem

You have API keys scattered across OpenAI, Anthropic, Google, DeepSeek, Groq...

- Keys stored in `.env` files across 20 projects
- No idea which key is burning money
- Can't easily switch providers when one goes down
- AI coding tools (Claude Code, Cursor) each need separate key config

## The Solution

```
         ┌─────────────────────────────────────────────┐
         │              ClawAPI Engine                  │
         │           (runs on YOUR machine)             │
         │                                              │
  You ──►│  🔑 Encrypted key vault (AES-256-GCM)       │
         │  🧠 Smart routing across providers           │
         │  📊 Cost tracking & health monitoring        │
         │  🔌 OpenAI-compatible API on localhost       │
         │                                              │
         │   Keys     Keys     Keys     Keys     Keys  │
         │    │        │        │        │        │     │
         └────┼────────┼────────┼────────┼────────┼─────┘
              ▼        ▼        ▼        ▼        ▼
           OpenAI  Anthropic  Gemini  DeepSeek  Groq
                                              + 10 more
```

**Your keys never leave your machine. Period.**

---

## ⚡ Quick Start

### Install via npm (requires [Bun](https://bun.sh))

```bash
# Install
bun add -g @clawapi/engine

# Setup (interactive — adds your first API key)
clawapi setup

# Start the engine
clawapi start
```

### Or download a binary (no dependencies)

```bash
# macOS (Apple Silicon)
curl -fsSL https://github.com/sstklen/clawapi/releases/latest/download/clawapi-darwin-arm64 -o clawapi
chmod +x clawapi && ./clawapi setup
```

<details>
<summary>Other platforms</summary>

| Platform | Download |
|----------|----------|
| macOS Apple Silicon | `clawapi-darwin-arm64` |
| macOS Intel | `clawapi-darwin-x64` |
| Linux x64 | `clawapi-linux-x64` |
| Windows x64 | `clawapi-win-x64.exe` |

→ [All releases](https://github.com/sstklen/clawapi/releases)

</details>

---

## 🔌 Use with AI Coding Tools

### Claude Code (MCP) — Recommended

**Prerequisites:** [Bun](https://bun.sh) or Node.js 20+ · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed

**Step 1: Add ClawAPI to Claude Code**

```bash
claude mcp add clawapi --scope user -- bunx @clawapi/engine mcp
```

**Step 2: Restart Claude Code** (close and reopen your terminal)

**Step 3: Verify it works**

```bash
clawapi mcp --test
```

You should see: `✅ MCP Server OK` with tool count and engine status.

> **Where is the config stored?** Claude Code saves MCP config at `~/.claude.json`.
> You can check it with `cat ~/.claude.json`.

**Quick setup (optional):** Generate default config without interactive prompts:

```bash
clawapi setup --defaults
```

You now have **14 AI tools** available. Ask Claude: *"What tools do you have from ClawAPI?"*

| Tool | What it does |
|------|-------------|
| `llm` | Chat with any AI model through ClawAPI |
| `search` | Web search via Brave/Tavily/DuckDuckGo |
| `translate` | Translate text via DeepL or AI |
| `image_generate` | Generate images |
| `audio_transcribe` | Transcribe audio files |
| `embeddings` | Generate text embeddings |
| `keys_list` | View your API keys |
| `keys_add` | Add a new API key |
| `status` | Check engine health |
| `adapters` | List supported providers |
| `setup_wizard` | First-time setup: scan env for keys, validate, Claw Key |
| `growth_guide` | Growth guide: progress, recommendations, pool health |
| `ask` | Ask ClawAPI anything |
| `task` | Execute multi-step AI tasks |

### Any OpenAI SDK Client

```python
from openai import OpenAI

# Point any OpenAI client at ClawAPI — it just works
client = OpenAI(
    base_url="http://localhost:4141/v1",
    api_key="your-clawapi-key"
)

# ClawAPI picks the best available provider automatically
response = client.chat.completions.create(
    model="auto",  # Let ClawAPI choose, or specify "gpt-4" / "claude-3" / "gemini-2"
    messages=[{"role": "user", "content": "Hello!"}]
)
```

Works with: Python, Node.js, Go, Rust — anything that speaks OpenAI API.

---

## 🧠 Smart Routing (L1 → L4)

ClawAPI doesn't just proxy — it thinks.

| Layer | Name | What it does |
|-------|------|-------------|
| **L1** | Direct Proxy | Fastest path. Pass request to the specified provider. |
| **L2** | Smart Gateway | Auto-select the best provider based on cost, latency, and health. |
| **L3** | AI Concierge | Understand intent, pick the right model + parameters. |
| **L4** | Task Engine | Break complex tasks into steps, orchestrate multiple AI calls. |

```
"Translate this doc to Japanese and summarize it"

  L4 Task Engine
   ├─ Step 1: L1 → DeepL (translate)
   ├─ Step 2: L2 → Best LLM (summarize)
   └─ Step 3: Merge results → Return
```

---

## 🔑 Iron Rules

These are not features — they are **guarantees**.

| # | Rule | How |
|---|------|-----|
| 1 | **Keys never leave your machine** | All API calls made locally. VPS only sees metadata. |
| 2 | **VPS never sees API content** | ECDH P-256 key exchange. Only latency/status shared. |
| 3 | **Works offline** | Full functionality without internet. VPS is optional. |

---

## 📦 Supported Providers

| Provider | Models | Type |
|----------|--------|------|
| **OpenAI** | GPT-4o, GPT-4, o1, o3 | LLM |
| **Anthropic** | Claude 4, Claude 3.5 Sonnet | LLM |
| **Google** | Gemini 2.5, Gemini 2.0 Flash | LLM |
| **DeepSeek** | DeepSeek-V3, DeepSeek-R1 | LLM |
| **Groq** | Llama 3, Mixtral (ultra-fast) | LLM |
| **Cerebras** | Llama 3 (fastest inference) | LLM |
| **SambaNova** | Llama 3 (fast inference) | LLM |
| **OpenRouter** | 200+ models (aggregator) | LLM |
| **Qwen** | Qwen-2.5 | LLM |
| **Ollama** | Any local model | LLM |
| **Brave Search** | Web search | Search |
| **Tavily** | AI-powered search | Search |
| **DuckDuckGo** | Web search (free) | Search |
| **DeepL** | 30+ languages | Translation |
| **+** | Community adapters (YAML) | Extensible |

Add your own provider in 30 lines of YAML. No code needed.

---

## 🛠 Full CLI

```
Engine      start · stop · status
Keys        keys add · list · remove · pin · rotate · import · check
Claw Key    claw-key set · show · remove
Sub-Keys    sub-keys issue · list · revoke · usage
Mutual Aid  aid config · stats · donate
Adapters    adapters list · install · remove · update
Telemetry   telemetry show · toggle
Backup      backup export · import
System      logs · config · setup · doctor · version · mcp
```

**30+ commands.** 3 languages (English, 繁體中文, 日本語).

---

## 🏗 Architecture

```
┌─────────────────────────────┐          ┌────────────────────────┐
│      ClawAPI Engine         │          │     ClawAPI VPS        │
│      (Your Machine)         │  ECDH    │     (Optional Cloud)   │
│                             │◄────────►│                        │
│  🔐 Key Vault (AES-256)    │ Metadata │  📋 Device Registry    │
│  🧠 Smart Router (L1-L4)   │   Only   │  📊 Telemetry Agg.    │
│  🌐 OpenAI-Compat API      │          │  🤝 Mutual Aid Match  │
│  🔧 MCP Server (14 tools)  │          │  🔍 Anomaly Detection │
│  💻 CLI (30+ commands)      │          │                        │
│  🖥  Web UI (SSR + HTMX)   │          │                        │
└─────────────────────────────┘          └────────────────────────┘
      Keys stay here ☝️                    Never sees your keys
```

## 🔒 Security

- **AES-256-GCM** encryption at rest
- **ECDH P-256** key exchange with VPS
- **1,681 tests**, 0 failures
- Triple code review (self + Codex + Opus cross-review)
- 5-party security audit methodology
- Non-root Docker execution
- Rate limiting on all endpoints

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Framework | [Hono](https://hono.dev) |
| Database | SQLite (bun:sqlite) |
| Language | TypeScript |
| Packaging | Bun compile (4-platform binaries) |
| Container | Docker + Caddy |

---

## 📝 License

**AGPL-3.0** — Free to use, modify, and distribute. Contributions welcome.

See [LICENSE](LICENSE) for details.

## Pair With

- **Opus Relay** ([`sstklen/opus-relay`](https://github.com/sstklen/opus-relay)) — Bridge your local Claude CLI to any VPS. ClawAPI manages the keys, Opus Relay bridges the compute.

---

<p align="center">
  <sub>Built with 🦞 by <a href="https://github.com/sstklen">sstklen</a> — Bōsō Peninsula, Japan</sub>
</p>
