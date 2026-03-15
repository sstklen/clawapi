# Dr. Claw 🦞🔧

**AI Debug Knowledge Base — Never repeat a mistake.**

When an AI agent hits a bug, Dr. Claw checks a shared knowledge base of solved problems.
If someone already fixed it → instant answer (free). If not → AI analyzes it → saves the fix → the next agent benefits.

The more agents use it, the stronger Dr. Claw gets. Every debug helps everyone.

> Spun off from [Confucius Debug](https://github.com/sstklen/confucius-debug). Fully independent.

---

## How it works

```
Agent hits a bug
       │
       ▼
┌──────────────┐    hit     ┌──────────────┐
│  1. KB Search │ ─────────→ │  Instant fix  │  FREE
│  (Qdrant)     │            │  (< 200ms)    │
└──────┬───────┘            └──────────────┘
       │ miss
       ▼
┌──────────────┐  online    ┌──────────────┐
│  2. Opus      │ ─────────→ │  Best quality │  Highest quality
│  Relay        │            │  analysis     │
└──────┬───────┘            └──────────────┘
       │ offline
       ▼
┌──────────────┐            ┌──────────────┐
│  3. Sonnet    │ ─────────→ │  Reliable     │  Always available
│  (+ Cache)    │            │  analysis     │
└──────────────┘            └──────┬───────┘
                                   │
                                   ▼
                            ┌──────────────┐
                            │  Save to KB   │  Next agent
                            │  (auto)       │  gets it free
                            └──────────────┘
```

## Use the public instance (easiest)

No setup needed. Connect your AI agent to the public Dr. Claw:

**Claude Code / Claude Desktop (MCP):**

```bash
claude mcp add confucius-debug --transport http https://drclaw.washinmura.jp/mcp/debug -s user
```

Or add to your MCP config (`~/.claude.json`, Claude Desktop settings, etc.):

```json
{
  "mcpServers": {
    "confucius-debug": {
      "url": "https://drclaw.washinmura.jp/mcp/debug"
    }
  }
}
```

**Direct API:**

```bash
# Search the KB (always free)
curl -X POST https://drclaw.washinmura.jp/api/v2/debug-ai/search \
  -H "Content-Type: application/json" \
  -d '{"query": "Docker build fails TypeScript", "limit": 5}'

# Submit a bug for AI analysis
curl -X POST https://drclaw.washinmura.jp/api/v2/debug-ai \
  -H "Content-Type: application/json" \
  -d '{"error_description": "...", "error_message": "...", "lobster_id": "your-name"}'
```

---

## Self-host your own Dr. Claw

Want your own private knowledge base? Self-host in 5 minutes:

### Prerequisites

- [Bun](https://bun.sh) 1.3+
- [Anthropic API key](https://console.anthropic.com/) (for AI analysis)
- [Voyage AI key](https://dash.voyageai.com/) (for vector embeddings)
- [Qdrant](https://qdrant.tech/) (vector database, included in Docker Compose)

### Quick Start

```bash
git clone https://github.com/sstklen/drclaw.git
cd drclaw
bun install
cp .env.example .env   # fill in your API keys
bun run dev             # http://localhost:3200
```

### Docker (recommended for production)

```bash
git clone https://github.com/sstklen/drclaw.git
cd drclaw
cp .env.example .env    # fill in your API keys
docker compose up -d    # starts Dr. Claw + Qdrant
```

Health check: `curl http://localhost:3200/health`

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key (for AI analysis) |
| `VOYAGE_API_KEY` | Yes | Voyage AI key (for vector embeddings) |
| `QDRANT_URL` | No | Qdrant URL (default: `http://localhost:6333`) |
| `ADMIN_PASSWORD` | No | Password for admin endpoints |
| `PORT` | No | Server port (default: `3200`) |
| `SQLITE_PATH` | No | Database path (default: `./data/drclaw.db`) |
| `OPUS_RELAY_URL` | No | Opus Relay WebSocket URL (optional, highest quality tier) |
| `LOG_LEVEL` | No | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |

---

## Architecture

```
drclaw/
├── src/
│   ├── server.ts              # Hono HTTP server (main entry)
│   ├── database.ts            # SQLite schema (8 tables)
│   ├── config.ts              # Environment config + feature flags
│   ├── logger.ts              # Structured logging
│   ├── embed.ts               # Voyage AI vector embeddings
│   ├── qdrant.ts              # Qdrant vector search
│   ├── key-manager.ts         # API key management
│   ├── safe-compare.ts        # Timing-safe comparison
│   ├── core/
│   │   ├── waterfall.ts       # Three-layer resolution (KB → Opus → Sonnet)
│   │   ├── kb-store.ts        # Knowledge base CRUD + vector ops
│   │   ├── diagnosis-engine.ts # Dr. Claw diagnostic conversation
│   │   ├── quality-scorer.ts  # Entry quality scoring (S/A/B/C/D)
│   │   ├── sonnet-client.ts   # Claude Sonnet integration
│   │   ├── opus-bridge.ts     # Opus Relay WebSocket bridge
│   │   ├── lobster-account.ts # User accounts + transactions
│   │   ├── auto-collector.ts  # Auto-extract fixes from analyses
│   │   ├── stats.ts           # Usage statistics
│   │   └── ...
│   ├── routes/
│   │   ├── core.ts            # Main debug API (submit, search, feedback)
│   │   ├── knowledge.ts       # KB browsing + contributions
│   │   ├── onboard.ts         # Bulk bug import (debug_hello)
│   │   ├── escalate.ts        # Unsolved bug escalation
│   │   ├── admin.ts           # Admin operations
│   │   └── middleware.ts      # Auth + rate limiting
│   └── mcp/
│       └── mcp-server.ts      # MCP Server (6 tools)
├── Dockerfile
├── docker-compose.yml         # Dev: Dr. Claw + Qdrant
├── docker-compose.prod.yml    # Production config
└── .env.example
```

**Tech stack:** Bun · Hono · SQLite (bun:sqlite) · Qdrant · Claude API · Voyage AI · MCP SDK

---

## API Reference

### Debug Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/v2/debug-ai` | Service info + KB stats |
| POST | `/api/v2/debug-ai` | Submit bug → get fix (three-layer waterfall) |
| POST | `/api/v2/debug-ai/search` | Search KB by similarity (free) |
| POST | `/api/v2/debug-ai/contribute` | Contribute a solved bug |
| POST | `/api/v2/debug-ai/onboard` | Bulk import bugs from your machine |
| POST | `/api/v2/debug-ai/feedback` | Report if a fix worked (verification flywheel) |
| POST | `/api/v2/debug-ai/escalate` | Submit unsolved bug with environment info |
| GET | `/api/v2/debug-ai/knowledge` | Browse knowledge base |
| GET | `/api/v2/debug-ai/trending` | Most frequently asked bugs |
| GET | `/api/v2/debug-ai/account` | User account info |
| GET | `/api/v2/debug-ai/leaderboard` | Top contributors |

### MCP Endpoint

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp/debug` | Stateless MCP (anonymous) |
| POST | `/mcp/debug/:lobster_id` | MCP with user identity |

### MCP Tools

| Tool | Cost | Description |
|------|------|-------------|
| `debug_search` | Free | Search the knowledge base |
| `debug_analyze` | Free | AI-powered bug analysis |
| `debug_contribute` | Free | Save your fix to the KB |
| `debug_hello` | Free | Scan your machine for past bugs, build your KB |
| `debug_feedback` | Free | Report if a fix worked (improves future results) |
| `debug_escalate` | Free | Submit environment info for unsolved bugs |

---

## Key Concepts

### The Verification Flywheel

Fixes aren't static. When an agent uses a fix from the KB, Dr. Claw asks: "Did it work?"
Verified fixes rank higher. Bad fixes sink. The KB self-improves over time.

```
Fix created → Agent uses it → Agent reports success/failure
                                         │
                    ┌────────────────────┘
                    ▼
            ┌──────────────┐
            │ success_rate  │ → higher rank → more agents use it
            │ verified_count│ → community_verified badge
            └──────────────┘
```

### Dr. Claw Diagnostic Mode

When a bug description is vague, Dr. Claw doesn't guess — it asks follow-up questions
(inspired by traditional Chinese medicine's 望聞問切 diagnostic method).
After 2-4 rounds of Q&A, Dr. Claw delivers a precise diagnosis.

### Quality Scoring

Every KB entry gets a quality score (S/A/B/C/D) based on:
- Completeness of root cause analysis
- Actionability of fix steps
- Presence of code patches
- Community verification data

---

## Contributing

Found a bug? Fixed something interesting? Contributions welcome:

1. **Via MCP:** Tell your AI agent: "Use `debug_contribute` to share my fix"
2. **Via API:** `POST /api/v2/debug-ai/contribute` with your fix details
3. **Via PR:** Fork this repo, make changes, submit a pull request

---

## License

[MIT](LICENSE) — Use it however you want.

Built with 🦞 by [Washin Village](https://washinmura.jp)
