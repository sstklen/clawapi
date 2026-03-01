# 🦞 ClawAPI

**Open-source AI API Key Manager + Smart Router**

> Your keys never leave your machine. Period.

ClawAPI helps you manage multiple AI API keys locally, route requests intelligently, and share unused quota with friends — all without exposing your keys to any third party.

## Features

- **30+ CLI Commands** — Full local management of AI API keys
- **12-Page Web UI** — SSR + HTMX, zero JS framework dependency
- **MCP Server** — 12 tools for Claude Desktop, Cursor, and more
- **OpenAI-Compatible API** — Drop-in replacement, works with any OpenAI SDK client
- **Smart Routing (L1-L4)** — From direct passthrough to AI-powered dynamic scheduling
- **Quality Testing (P1-P4)** — Automated API quality and health checks
- **AES-256-GCM Encryption** — Keys are encrypted at rest on your machine
- **ECDH P-256 Key Exchange** — End-to-end secure communication with VPS

## Iron Rules

1. **Keys never leave your machine** — All API calls are made locally
2. **VPS never sees API content** — Only metadata (latency, status) is shared
3. **Works offline** — Full functionality without VPS connection

## Quick Start

### Download

Download the latest binary for your platform from [Releases](https://github.com/sstklen/clawapi/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `clawapi-darwin-arm64` |
| macOS (Intel) | `clawapi-darwin-x64` |
| Linux (x64) | `clawapi-linux-x64` |
| Windows (x64) | `clawapi-win-x64.exe` |

### Install & Run

```bash
# macOS / Linux
chmod +x clawapi-darwin-arm64
./clawapi-darwin-arm64 setup

# Start the engine
./clawapi-darwin-arm64 start

# Add your first API key
./clawapi-darwin-arm64 keys add
```

### Use as OpenAI-Compatible API

Once started, ClawAPI exposes a local OpenAI-compatible endpoint:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="your-local-key"
)

response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### Use as MCP Server

Add to your Claude Desktop or Cursor config:

```json
{
  "mcpServers": {
    "clawapi": {
      "command": "/path/to/clawapi-darwin-arm64",
      "args": ["mcp"]
    }
  }
}
```

## CLI Commands

```
Engine:     start, stop, status
Keys:       keys add/list/remove/pin/rotate/import/check
Gold Key:   gold-key set/show/remove
Sub-Keys:   sub-keys issue/list/revoke/usage
Mutual Aid: aid config/stats/donate
Adapters:   adapters list/install/remove/update
Telemetry:  telemetry show/toggle
Backup:     backup export/import
Other:      logs, config, setup, doctor, version
```

## Architecture

```
┌─────────────────────────┐          ┌──────────────────────┐
│   ClawAPI Engine        │          │   ClawAPI VPS        │
│   (Your Machine)        │  ECDH    │   (Cloud)            │
│                         │◄────────►│                      │
│  • Key Storage (AES)    │  Metadata│  • Device Registry   │
│  • Smart Router         │   Only   │  • Telemetry Agg.    │
│  • OpenAI-Compat API    │          │  • L0 Key Pool       │
│  • MCP Server           │          │  • Mutual Aid Match  │
│  • Web UI               │          │  • Anomaly Detection │
│  • CLI                  │          │                      │
└─────────────────────────┘          └──────────────────────┘
     Keys stay here ☝️                  Never sees your keys
```

## Supported Providers

OpenAI, Anthropic (Claude), Google (Gemini), Groq, DeepSeek, Mistral, Cohere, Sambanova, Cerebras, OpenRouter, Brave Search, DeepL, and more via community adapters.

## Tech Stack

- **Runtime:** Bun 1.3.7
- **Framework:** Hono
- **Database:** SQLite (local) + SQLite (VPS)
- **Language:** TypeScript
- **Encryption:** AES-256-GCM + ECDH P-256
- **Packaging:** Bun compile (4-platform binaries)
- **Container:** Docker + Caddy

## Security

- Triple code review (self + Codex + Opus cross-review)
- 5-party security audit (Red team + Mutation testing + Blind review + Supply chain + STRIDE)
- 1,478 tests, 0 failures
- Non-root Docker execution
- Rate limiting on all endpoints

## VPS Endpoint

```
Health:  https://clawapi.washinmura.jp/health
API:     https://clawapi.washinmura.jp/v1/
```

## License

AGPL-3.0 — See [LICENSE](LICENSE) for details.

## Contributing

Issues and PRs welcome. Please read the specs in `specs/` before contributing.
