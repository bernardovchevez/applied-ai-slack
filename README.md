# applied-ai-slack

[![CI](https://github.com/bernardovchevez/applied-ai-slack/actions/workflows/ci.yml/badge.svg)](https://github.com/bernardovchevez/applied-ai-slack/actions/workflows/ci.yml)

Decoupled TypeScript Slack Bolt (`@slack/bolt`) client for the Applied AI Platform (`applied-ai-platform`). Communicates exclusively with the FastAPI presentation BFF over HTTP and Server-Sent Events (SSE) using `X-Client-Platform: slack` and `format: compact`.

```
workspace/
├── applied-ai-platform/              <- Platform (RAG, MCP server, LangGraph agents, pgvector, FastAPI BFF)
│   └── platform/bff/
├── applied-ai-web/                   <- Next.js browser client (X-Client-Platform: web)
└── applied-ai-slack/                 <- Slack Bolt client (X-Client-Platform: slack, this repository)
```

## Capabilities

| Slack Surface | BFF Endpoint | Behavior |
|---------------|--------------|----------|
| `/media-ask <question>` | `POST /v1/chat/stream` (SSE, `format=compact`) | Streams grounded RAG answer with source citations (`doc_type`, `rights_tier`) and interactive `Helpful` / `Needs work` feedback buttons |
| `/media-clearance <prompt>` | `POST /v1/agent/run` (`202 Accepted`) | Runs the multi-agent clearance workflow and posts an interactive Block Kit approval card (`Approve & Publish` / `Reject Draft`) |
| `@media-ops <message>` (channel) or **DM** to the bot | `/v1/chat/stream` or `/v1/agent/run` | Replies in-thread or in the DM; clearance-style prompts go to the agent workflow, other text to RAG |
| Block Kit `Approve` / `Reject` | `POST /v1/agent/run` (`resume`) | Resolves the pending `thread_id` in SQLite (`localhost`) or PostgreSQL (`stage`/`production`) and updates the Slack card in place |
| Block Kit `Helpful` / `Needs work` | `POST /v1/feedback` | Persists thumbs feedback correlated with `X-Session-Id` and `prompt_version` |
| `/media-status` | `GET /health` | Displays live BFF health, `environment`, `state_store`, `pgvector` chunk count, and active LLM provider |
| `/media-help` | (none) | Ephemeral onboarding card: commands and links to `docs/local-slack-testing.md` |

RAG and agent calls share a thread-scoped BFF session id (`slack-thread-<channel>-<thread_root_ts>`) for slash commands, `@media-ops`, and DMs so follow-ups in the same Slack thread keep chat context. BFF failures surface a Block Kit error card with **Retry** (updates the same message in place).

## Companion repositories

| Repository | Role |
|------------|------|
| [applied-ai-platform](https://github.com/bernardovchevez/applied-ai-platform) | FastAPI BFF, RAG, LangGraph agents, pgvector, evals |
| [applied-ai-web](https://github.com/bernardovchevez/applied-ai-web) | Next.js browser client (`X-Client-Platform: web`) |
| [applied-ai-slack](https://github.com/bernardovchevez/applied-ai-slack) | This repo (`X-Client-Platform: slack`) |

OpenAPI contract: [platform/bff/openapi.yaml](https://github.com/bernardovchevez/applied-ai-platform/blob/main/platform/bff/openapi.yaml).

## Local Slack testing

Step-by-step guide (unit tests, BFF smoke, Socket Mode, manual checklist, troubleshooting): **[docs/local-slack-testing.md](docs/local-slack-testing.md)**.

## Quick Start (Localhost with Socket Mode)

In `localhost`, `applied-ai-slack` uses **Slack Socket Mode** so no public webhook URL or `ngrok` tunnel is required:

1. Start the FastAPI BFF in `applied-ai-platform`:
   ```bash
   cd ../applied-ai-platform/platform/bff
   ./run.sh --env localhost
   ```
2. Create a Slack App using [`slack-app-manifest.yaml`](slack-app-manifest.yaml) at [api.slack.com/apps](https://api.slack.com/apps) and copy your `SLACK_BOT_TOKEN` (`xoxb-...`), `SLACK_SIGNING_SECRET`, and Socket Mode `SLACK_APP_TOKEN` (`xapp-...`).
3. Configure and start `applied-ai-slack`:
   ```bash
   cd applied-ai-slack
   cp .env.localhost.example .env.localhost
   npm install
   npm run build && npm run start:localhost
   ```

## Environments (Localhost, Stage & Production)

| Environment | Transport Mode | Env Template | BFF Auth (`BFF_API_KEY`) |
|-------------|----------------|--------------|--------------------------|
| `localhost` | Socket Mode (`SLACK_SOCKET_MODE=true`) | `.env.localhost.example` | Optional |
| `stage` | HTTP Events Receiver (`:3001/slack/events` + `/health`) | `.env.stage.example` | `Authorization: Bearer <BFF_API_KEY>` |
| `production` | HTTP Events Receiver (`:3001/slack/events` + `/health`) | `.env.production.example` | `Authorization: Bearer <BFF_API_KEY>` |

```bash
# Docker production build
docker build --build-arg APP_ENV=production -t applied-ai-slack:prod .
docker run -p 3001:3001 --env-file .env.production applied-ai-slack:prod
```

## Typecheck, Build & Unit Tests

GitHub Actions (`.github/workflows/ci.yml`) runs TypeScript validation and the unit/contract test suite on Node 22 on every push and pull request:

```bash
npm run typecheck   # tsc --noEmit
npm test            # Compiles and runs Node 22 test suite (SSE parser, BFF client, Block Kit cards)
```
