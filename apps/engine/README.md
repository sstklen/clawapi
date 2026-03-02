# 🦞 ClawAPI

**One command. Every AI. Your keys stay home.**

Open-source AI API Key Manager + Smart Router.
Manage 15+ AI providers from a single local engine — keys never leave your machine.

---

## Quick Start

### For Claude Code (MCP)

```bash
# 1. Add to Claude Code
claude mcp add clawapi --scope user -- bunx @clawapi/engine mcp

# 2. Restart Claude Code (close and reopen your terminal)

# 3. Verify it works
clawapi mcp --test
```

You should see: `✅ MCP Server OK` with tool count and engine status.

### For any OpenAI SDK client

```bash
# Quick setup with defaults (no interactive prompts)
clawapi setup --defaults

# Start the engine
clawapi start

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

## MCP Config Location

Claude Code stores MCP config at `~/.claude.json`:

```json
{
  "mcpServers": {
    "clawapi": {
      "command": "bunx",
      "args": ["@clawapi/engine", "mcp"]
    }
  }
}
```

## CLI Commands

```bash
clawapi setup              # Interactive first-time setup
clawapi setup --defaults   # Quick setup with defaults (no prompts)
clawapi start              # Start the engine
clawapi stop               # Stop the engine
clawapi status             # Check engine health
clawapi keys list          # List your API keys
clawapi keys add           # Add a new API key
clawapi mcp                # Start MCP server (stdio mode)
clawapi mcp --test         # Quick health check
clawapi doctor             # Diagnose issues
```

## Links

- 📦 [npm](https://www.npmjs.com/package/@clawapi/engine)
- 🐙 [GitHub](https://github.com/sstklen/clawapi)
- 📄 [License: AGPL-3.0](https://github.com/sstklen/clawapi/blob/main/LICENSE)
