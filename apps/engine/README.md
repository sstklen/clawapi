# 🦞 ClawAPI

**One command. Every AI. Your keys stay home.**

Open-source AI API Key Manager + Smart Router.
Manage 15+ AI providers from a single local engine — keys never leave your machine.

## Install

```bash
npm install -g @clawapi/engine
clawapi init
```

That's it. Two commands, zero config files to create manually.

`clawapi init` automatically creates your config and registers the MCP server with Claude Code.
Run `clawapi doctor` to verify everything is working.

> **Package name:** `@clawapi/engine` (not `clawapi` — that's a different package)

---

## Quick Start

### For Claude Code (MCP)

```bash
npm install -g @clawapi/engine   # Install the CLI
clawapi init                      # Create config + register MCP
# Restart Claude Code (close and reopen your terminal)
clawapi doctor                    # Verify setup
```

After restart, Claude Code can use 14 ClawAPI tools (search, translate, image generation, and more).

### For any OpenAI SDK client

```bash
npm install -g @clawapi/engine
clawapi init --no-mcp     # Setup without MCP registration
clawapi start              # Start the engine on localhost:4141

# Use as OpenAI-compatible API
# base_url: http://localhost:4141/v1
```

---

## What You Get

- 🔑 **Encrypted key vault** — AES-256-GCM, keys never leave your machine
- 🧠 **Smart routing** — Automatically picks the best provider for each request
- 📊 **Cost tracking** — Know exactly which key is burning money
- 🔌 **OpenAI-compatible API** — Works with any OpenAI SDK client
- 🤖 **MCP server** — 14 tools for Claude Code, Cursor, and more
- 🔄 **Auto-failover** — If one provider goes down, seamlessly switch to another

## Supported Providers

OpenAI · Anthropic · Google Gemini · DeepSeek · Groq · Cerebras · SambaNova ·
OpenRouter · Ollama · Brave Search · Tavily · DuckDuckGo · DeepL · and more

## MCP Tools

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
| `setup_wizard` | First-time setup: scan env for keys, validate, generate Gold Key |
| `growth_guide` | Growth guide: unlock progress, recommendations, pool health |
| `ask` | Ask ClawAPI anything |
| `task` | Execute multi-step AI tasks |

## CLI Commands

```bash
# Setup
clawapi init               # One-command setup (config + MCP)
clawapi init --force       # Reinitialize (overwrite config)
clawapi init --no-mcp      # Setup without MCP registration
clawapi setup              # Interactive first-time setup (5-step wizard)
clawapi doctor             # Diagnose issues

# Engine
clawapi start              # Start the engine
clawapi stop               # Stop the engine
clawapi status             # Check engine health

# Keys
clawapi keys list          # List your API keys
clawapi keys add           # Add a new API key
clawapi keys check         # Validate all keys

# MCP
clawapi mcp                # Start MCP server (stdio mode)
clawapi mcp --test         # Quick MCP health check
clawapi mcp --install      # Register MCP with Claude Code
clawapi mcp --uninstall    # Remove MCP from Claude Code

# Cleanup
clawapi uninstall          # Remove config + MCP settings
clawapi uninstall --all    # Remove everything (including API keys and data)
```

## Uninstall

```bash
clawapi uninstall              # Remove config and MCP settings
bun remove -g @clawapi/engine  # Remove the CLI
```

## Links

- 📦 [npm](https://www.npmjs.com/package/@clawapi/engine)
- 🐙 [GitHub](https://github.com/sstklen/clawapi)
- 📄 [License: AGPL-3.0](https://github.com/sstklen/clawapi/blob/main/LICENSE)
