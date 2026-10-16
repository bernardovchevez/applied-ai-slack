# Local Slack testing

This guide walks through testing `applied-ai-slack` on your machine against the FastAPI BFF in `applied-ai-platform`. For day-to-day development, use **Slack Socket Mode** so you do not need a public URL or `ngrok`.

## Overview: three layers

| Layer | What you need | What it proves |
|-------|----------------|----------------|
| 1. Unit tests | Node 22 only | SSE parsing, BFF client contracts, Block Kit builders |
| 2. BFF smoke | Platform venv + BFF running | Health, RAG, and agent APIs before Slack |
| 3. Live Slack | Slack dev workspace + tokens + BFF | End-to-end slash commands, mentions, and buttons |

Run them in order when you are debugging a new integration.

---

## Layer 1: Unit tests (no Slack, no BFF)

From the repository root:

```bash
npm run typecheck
npm test
```

These tests mock `fetch` and do not call Slack or the BFF. Use them after every code change.

---

## Layer 2: BFF smoke (no Slack app)

### Start the BFF

```bash
cd ../applied-ai-platform
# Activate venv and install deps per applied-ai-platform/README.md
cd platform/bff
./run.sh --env localhost
```

Default URL: `http://localhost:8000`.

### Quick checks

```bash
curl -s http://localhost:8000/health
```

Open Swagger at [http://localhost:8000/docs](http://localhost:8000/docs) if you want to exercise endpoints manually.

For **grounded** `/media-ask` answers (not just connectivity), the platform needs a configured LLM (Ollama or OpenAI), ingested corpus, and pgvector (or another backend) as described in `applied-ai-platform/README.md`. `/media-status` and error paths from Slack still validate that the Bolt app can reach the BFF.

### Headers the Slack client sends

When comparing to curl or the web client, match what `src/bff.ts` sends:

- `Content-Type: application/json`
- `X-Client-Platform: slack`
- `X-Session-Id: <session id>` (on chat, agent, and feedback calls)
- `Authorization: Bearer <BFF_API_KEY>` only when `BFF_API_KEY` is set (optional on localhost)

---

## Layer 3: Live Slack (Socket Mode)

### One-time Slack app setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and choose **Create New App** → **From an app manifest**.
2. Paste the contents of [`slack-app-manifest.yaml`](../slack-app-manifest.yaml) at the repo root.
3. **Install to workspace** (use a dedicated dev workspace).
4. Collect credentials:
   - **Bot User OAuth Token** (`xoxb-...`) under **OAuth & Permissions**
   - **Signing Secret** under **Basic Information**
   - **App-Level Token** with scope `connections:write` (`xapp-...`) under **Basic Information** → **App-Level Tokens** (required for Socket Mode)
5. Confirm **Socket Mode** is enabled under **Settings** → **Socket Mode**.
6. Enable DMs to the bot (Slack defaults this off): **Features** → **App Home** → **Show Tabs** → turn **Messages Tab** on, then check **Allow users to send Slash commands and messages from the messages tab**. Without this, the bot DM shows *Sending messages to this app has been turned off*. The repo manifest sets `features.app_home.messages_tab_read_only_enabled: false` for new apps; existing apps must toggle this in the API dashboard or re-import the manifest.

If you change scopes or slash commands after install, reinstall the app to the workspace.

### Environment file

```bash
cp .env.localhost.example .env.localhost
```

Edit `.env.localhost` and set:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_APP_TOKEN`
- `BFF_URL=http://localhost:8000` (default)

Leave `BFF_API_KEY` empty for open localhost BFF unless you enabled API key auth locally.

The app loads `.env`, then `.env.localhost` when `APP_ENV=localhost`. Use `npm run start:localhost` so `APP_ENV` is set before the process starts. Do not commit `.env.localhost`.

### Run the Bolt app

Terminal 1: BFF (see Layer 2).

Terminal 2:

```bash
npm install
npm run build
npm run start:localhost
```

Expected log shape:

```text
[applied-ai-slack] running (env=localhost, mode=socket, bff=http://localhost:8000)
```

For TypeScript edits, run `npm run dev` in one terminal (watch compile) and restart `npm run start:localhost` in another after each build, or rebuild with `npm run build` before restart.

---

## Sample prompts for localhost demos

Prompts below match the synthetic **Harbor Line** corpus in `applied-ai-platform/data/synthetic/`. Use them in Slack or the same text on [applied-ai-web](https://github.com/bernardovchevez/applied-ai-web) chat and agent routes.

### Suggested demo flow (about 2 minutes)

1. `/media-status`
2. `/media-ask Is the theme song cleared for EMEA streaming?`
3. `/media-clearance Prepare clearance summary for Harbor Line S01E04 EMEA launch`
4. Click **Approve & Publish** or **Reject Draft** on the clearance card

### `/media-ask` (grounded RAG)

Rights and clearance:

```text
/media-ask Is the theme song cleared for EMEA streaming?
/media-ask Is the Harbor Line main title cleared for Japan streaming?
/media-ask Is the Getty archival footage for Harbor Line Episode 4 cleared?
/media-ask What product placement restrictions apply to Harbor Brew Co. in Episode 4?
/media-ask Is the Harbor Line theme song cleared for streaming in China?
```

Production and operations:

```text
/media-ask What locations are locked for Season 1 Episode 4?
/media-ask What location is locked for Harbor Line S01E07?
/media-ask Which East River location was rejected during the 2026 location scout?
/media-ask How many background talent releases are still outstanding for S01E04?
/media-ask What safety conditions apply to the chain breakaway stunt in S01E06?
```

Distribution, press, and finance:

```text
/media-ask What territories are excluded from the distribution agreement?
/media-ask When does Season 2 premiere?
/media-ask Who is joining Harbor Line Season 2 as a series regular?
/media-ask What is the total production budget for Harbor Line Season 2?
/media-ask What deliverables can block international SVOD packaging for an episode?
```

Grounding checks (should cite corpus or refuse to invent):

```text
/media-ask Did Harbor Line Season 1 premiere on Netflix?
/media-ask Who is the CEO of Netflix?
```

### `/media-clearance` (multi-agent workflow + approval card)

```text
/media-clearance Prepare clearance summary for Harbor Line S01E04 EMEA launch
/media-clearance Draft production brief clearance summary for Harbor Line S02E01 EMEA SVOD
/media-clearance Prepare launch summary for Harbor Line main title theme in EMEA streaming
/media-clearance Draft brief for Harbor Line S01E04: music, Getty archival, and product placement for LATAM SVOD
/media-clearance Prepare clearance summary for Harbor Line Season 2 premiere press and social (EMEA)
```

Empty command (uses built-in default prompt):

```text
/media-clearance
```

Default when text is omitted: *Prepare clearance summary for Harbor Line S01E04 EMEA launch*.

### `@media-ops` in a channel (same routing, thread replies)

Invite the bot first (`/invite @media-ops`), then:

```text
@media-ops Is the theme song cleared for EMEA streaming?
@media-ops Prepare clearance summary for Harbor Line S01E04 EMEA launch
```

Clearance-style wording on `@media-ops` (for example “clearance summary”, “production brief”, “prepare … clearance”) routes to the agent workflow; other questions route to RAG like `/media-ask`.

---

## Manual test checklist (Slack UI)

Invite the bot to a test channel first: `/invite @media-ops` (or the display name from your manifest).

| Step | Slack action | Expected result |
|------|----------------|-----------------|
| 1 | `/media-status` | Ephemeral status card from `GET /health` |
| 2 | `/media-ask Is the theme song cleared for EMEA streaming?` | In-channel answer with sources and **Helpful** / **Needs work** buttons |
| 3 | Click **Helpful** or **Needs work** | Ephemeral confirmation; BFF records `POST /v1/feedback` |
| 4 | `/media-clearance Prepare clearance summary for Harbor Line S01E04 EMEA launch` | In-channel card paused at human approval (`202`) with **Approve & Publish** / **Reject Draft** |
| 5 | Click **Approve & Publish** or **Reject Draft** | Same message updates in place via `POST /v1/agent/run` with `resume` |
| 6 | `@media-ops Is Harbor Line cleared for EMEA?` in the channel | Thread reply with RAG blocks |
| 7 | `@media-ops Prepare clearance summary for Harbor Line EMEA` | Thread reply with clearance approval card (wording matches clearance intent routing) |

### Direct messages

The manifest subscribes to `message.im`, but the current Bolt handlers only register `app_mention`. **DMs will not get bot replies until a `message` / `message.im` handler is added.** Use slash commands and `@media-ops` in a channel for local testing.

---

## Troubleshooting

| Symptom | Likely cause | What to try |
|---------|----------------|-------------|
| *Sending messages to this app has been turned off* in the bot DM | App Home Messages Tab is read-only or disabled | **App Home** → **Messages Tab** on → enable **Allow users to send Slash commands and messages from the messages tab**; refresh Slack client |
| Bolt exits on startup | Missing or invalid `SLACK_APP_TOKEN` | Create app-level token with `connections:write`; enable Socket Mode |
| Slash command “dispatch failed” | Bolt process not running | Start `npm run start:localhost`; check terminal for errors |
| Slash command not found | App not installed or wrong workspace | Reinstall app; confirm command names match manifest |
| Buttons do nothing | Interactivity off or app not running | Enable interactivity in app settings; keep Bolt process alive |
| Slack OK, message mentions BFF error | BFF down or wrong URL | `curl http://localhost:8000/health`; verify `BFF_URL` in `.env.localhost` |
| Empty or generic RAG answers | Index or LLM not configured | Follow `applied-ai-platform` ingest and `.env` setup; compare with `applied-ai-web` against same BFF |
| Web works, Slack does not | Header or session mismatch | Compare `X-Client-Platform: slack` and BFF logs for the same question |

---

## Optional: HTTP mode locally (stage rehearsal)

Production and stage use an HTTP Events Receiver on `:3001/slack/events` instead of Socket Mode. To rehearse that locally you need a tunnel (for example `ngrok http 3001`), set `SLACK_SOCKET_MODE=false`, and point Slack **Event Subscriptions** and **Interactivity** request URLs at your tunnel. For most local work, Socket Mode is simpler.

See [README.md](../README.md) for stage and production env templates and Docker.

---

## Related documentation

- [applied-ai-platform/platform/bff/README.md](../../applied-ai-platform/platform/bff/README.md): BFF endpoints, agent `202` / `resume` flow, localhost SQLite state
- [applied-ai-platform/README.md](../../applied-ai-platform/README.md): corpus ingest, pgvector, Ollama, and evals
- [applied-ai-web/README.md](../../applied-ai-web/README.md): Next.js client and equivalent web demo prompts
