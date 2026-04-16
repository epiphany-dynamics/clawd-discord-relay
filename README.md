# Claude Discord Relay

A Discord bot that routes messages to Claude Code CLI agents with persistent memory. Message different Discord channels to talk to different Claude agents — each with their own personality, expertise, and persistent session.

Built with Bun + discord.js. No web UI needed. Just Discord.

---

## Features

- **Multiple routing modes** per Discord channel:
  - `direct` — one channel, one agent, persistent Claude session
  - `smart-dispatch` — Haiku picks 1-3 agents from a pool based on your message
  - `broadcast` — all listed agents respond in parallel
  - `webhook-feed` — read-only channel for cron agents to post updates

- **Full memory loop** on every message:
  1. Query Qdrant/Mem0 for relevant memories
  2. Load last N conversation exchanges for context
  3. Build prompt: agent profile + memories + history + message
  4. Spawn Claude CLI
  5. Process `[REMEMBER:]` / `[GOAL:]` / `[DONE:]` memory intents
  6. Async memory extraction via GPT-4o-mini (non-blocking)
  7. Store exchange in per-channel conversation history

- **Session persistence** — Claude sessions resume across messages (no context loss)
- **Attachment support** — images, code files, text files forwarded to agents
- **Typing indicators** — Discord shows "typing..." while agents work; heartbeat every 45s for long tasks
- **Stop commands** — `!stop`, `!stop <agent>`, `!stopall` kill running processes

- **Memory stack** (graceful fallback chain):
  - Primary: [Mem0](https://mem0.ai) HTTP service
  - Fallback: Direct Qdrant + Ollama embeddings
  - Optional: Gemini multimodal second-brain collection

---

## Architecture

```
Discord message
     │
     ▼
discord-relay.ts
     │
     ├── channels.json          channel → routing mode
     ├── agents/<name>.md       agent personality + instructions
     │
     ├── src/memory.ts          Mem0 → Qdrant+Ollama fallback
     ├── src/memory-extract.ts  GPT-4o-mini async fact extraction
     ├── src/conversation-history.ts  per-channel rolling window
     └── src/gemini-embed.ts    optional multimodal embeddings
          │
          ▼
     Claude CLI (`claude -p "..." --output-format json`)
          │
          ▼
     Discord response (chunked at 2000 chars)
```

---

## Prerequisites

- **[Bun](https://bun.sh)** runtime
- **[Claude Code CLI](https://claude.ai/code)** installed and authenticated
- **[Qdrant](https://qdrant.tech)** running (Docker: `docker run -p 6333:6333 qdrant/qdrant`)
- **[Ollama](https://ollama.ai)** with `nomic-embed-text` model (`ollama pull nomic-embed-text`)
- A Discord bot with **Message Content Intent** enabled

Optional (for enhanced memory):
- [Mem0](https://github.com/mem0ai/mem0) self-hosted HTTP service
- OpenAI API key (GPT-4o-mini memory extraction)
- Google Gemini API key (multimodal second-brain embeddings)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/patrickg21212/clawd-discord-relay
cd clawd-discord-relay
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

Required:
- `DISCORD_BOT_TOKEN` — from Discord Developer Portal
- `DISCORD_GUILD_ID` — right-click your server → Copy Server ID
- `DISCORD_OWNER_USER_ID` — right-click your profile → Copy User ID
- `CLAUDE_PATH` — path to the `claude` CLI binary
- `PROJECT_DIR` — your Claude project directory (where CLAUDE.md lives)

### 3. Create Discord channels

Create text channels in your Discord server matching the names in `channels.json`. Example:
- `#assistant` — direct to your main agent
- `#dev` — direct to a coding-focused agent
- `#all-hands` — smart-dispatch to all agents

### 4. Configure channels

Edit `channels.json`:

```json
{
  "all-hands": { "type": "smart-dispatch", "agents": ["assistant", "dev", "ops"] },
  "assistant": { "type": "direct", "agent": "assistant", "model": "claude" },
  "dev":       { "type": "direct", "agent": "dev",       "model": "sonnet" }
}
```

Models: `claude` (Opus, default), `sonnet`, `haiku`

### 5. Create agent profiles

Add markdown files to `agents/`. The filename = the channel/agent name.

```markdown
# My Agent

You are [Name], an AI assistant specializing in [domain].

## Personality
- ...

## Capabilities
- ...
```

### 6. Start it

```bash
bun run start
```

Or as a systemd service:
```bash
sudo cp daemon/discord-relay.service /etc/systemd/system/
sudo systemctl enable discord-relay
sudo systemctl start discord-relay
```

---

## Discord Commands

| Command | Description |
|---------|-------------|
| `!stop` | Stop the agent running in current channel |
| `!stop <agent>` | Stop a specific agent by name |
| `!stopall` | Stop all running agents |
| `!newsession` | Clear session — next message cold-starts |
| `!sessions` | List all active sessions |

---

## Memory Intents

Agents can store memories by including tags in their responses:

```
[REMEMBER: user prefers concise responses]
[GOAL: finish the API integration | DEADLINE: 2026-04-20]
[DONE: set up the database migrations]
```

Tags are stripped before the response is sent to Discord. Memories are stored to Qdrant and surfaced on future relevant queries.

---

## Webhook API

The relay runs an HTTP server (default port 3007) for agents to post back to Discord:

```bash
# Post to a specific agent's channel
curl -X POST http://localhost:3007/webhook/agent-report \
  -H "Content-Type: application/json" \
  -d '{"agent": "dev", "message": "Cron job completed: 3 new leads found"}'

# Post to #agent-feed channel
curl -X POST http://localhost:3007/webhook/agent-feed \
  -H "Content-Type: application/json" \
  -d '{"agent": "ops", "message": "Disk usage at 78% — watch it"}'
```

---

## Memory Stack Details

The relay uses a layered memory system:

1. **Mem0** (if running) — semantic memory with automatic deduplication
2. **Qdrant + Ollama** (fallback) — direct vector search with `nomic-embed-text`
3. **GPT-4o-mini** — asynchronously extracts memorable facts after each exchange
4. **Conversation history** — rolling window of last 50 exchanges per channel (JSON file)

Start Qdrant with Docker:
```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

Pull the embedding model:
```bash
ollama pull nomic-embed-text
```

---

## Environment Variables

See [.env.example](.env.example) for the full list with descriptions.

---

## License

MIT
