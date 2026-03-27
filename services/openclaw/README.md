# @proj-airi/openclaw

Bridges [OpenClaw](https://github.com/openclaw/openclaw) message notifications to the AIRI avatar stage.

**Effect**: when OpenClaw receives a message on any of its 20+ supported channels (WhatsApp, Signal, iMessage, LINE, Slack, Matrix, etc.), this service forwards it to AIRI's server. AIRI's LLM reacts to the message and the response is shown as a chat bubble popup on アイリ's avatar.

```
OpenClaw (any channel)
  │  POST /webhook
  ▼
openclaw (this service, HTTP :6122)
  │  input:text  (WebSocket)
  ▼
AIRI server-runtime (:6121)
  │  LLM reasoning
  ▼
output:gen-ai:chat:complete   ← definitive final response (always emitted)
output:gen-ai:chat:message    ← per-chunk during streaming (may not fire)
  │
  ▼
AIRI stage-web / stage-tamagotchi
  └─ Chat bubble popup on the avatar
```

## How it works

This service is an **adapter** — the same pattern used by `services/discord-bot` and `services/telegram-bot`:

1. It starts a lightweight HTTP server that listens for incoming `POST /webhook` calls from OpenClaw.
2. Each webhook call is wrapped into an `input:text` event and sent to the AIRI WebSocket server (`ws://localhost:6121/ws`) via `@proj-airi/server-sdk`.
3. AIRI's LLM processes the message and generates a response.
4. Two events are emitted back through server-runtime:
   - `output:gen-ai:chat:complete` — the definitive final response; **always emitted** once the full LLM turn finishes.
   - `output:gen-ai:chat:message` — one event per streaming chunk; may not fire for non-streaming providers.
5. The response is displayed as a chat bubble on the AIRI avatar stage — that's the popup the user sees.

There is **no Discord/Telegram required** as a middleware. OpenClaw talks directly to this service, which talks directly to AIRI.

## Quick start

> **All four components below must be running together** for a message sent through this
> service to produce a visible response on the avatar:
>
> | # | Component | Command | Purpose |
> |---|---|---|---|
> | 1 | **server-runtime** | `pnpm -F @proj-airi/server-runtime start` | WebSocket hub that routes events |
> | 2 | **stage-web** (or tamagotchi) | `pnpm -F @proj-airi/stage-web dev` | Avatar UI that shows the chat bubble |
> | 3 | **LLM provider** | Configured in stage-web Settings | Generates the avatar's reply |
> | 4 | **openclaw** (this service) | `pnpm -F @proj-airi/openclaw dev` | Bridges OpenClaw webhooks to the server |

### 1. Start the AIRI server

```bash
pnpm -F @proj-airi/server-runtime start
```

### 2. Start the AIRI stage (so you can see the avatar)

```bash
pnpm -F @proj-airi/stage-web dev
# or the desktop app:
pnpm -F @proj-airi/stage-tamagotchi dev
```

Open **http://localhost:5173** (stage-web default) in your browser. The avatar should appear
on the main page. The right-hand panel is the **chat history area** — this is where the
avatar's replies appear as chat bubbles.

### 2a. Configure an LLM provider

Before the avatar can reply to messages, it needs a language-model backend:

1. Open **Settings → Modules → Consciousness** in stage-web.
2. Pick a provider (e.g. OpenAI, Anthropic, Ollama) and enter the API key / base URL.
3. Select a model.

> **Quick test without OpenClaw:** go to **Settings → Developer → Chat** in stage-web and
> click **▶ Inject simulated response** to verify the chat bubble appears before involving
> the full webhook pipeline.

### 3. Configure and start this service

```bash
cd services/openclaw
cp .env .env.local          # optional: override defaults
pnpm start
```

The default `.env` values work for a local setup:

| Variable | Default | Description |
|---|---|---|
| `AIRI_TOKEN` | `abcd` | Auth token expected by the AIRI server |
| `AIRI_URL` | `ws://localhost:6121/ws` | AIRI WebSocket endpoint |
| `OPENCLAW_WEBHOOK_PORT` | `6122` | Port this service listens on |

### 4. Configure OpenClaw to send messages here

In your OpenClaw workspace, create a **skill** or **webhook** that POSTs to:

```
http://localhost:6122/webhook
```

with a JSON body:

```json
{
  "text": "Hello from WhatsApp!",
  "sender": { "id": "alice", "name": "Alice" },
  "platform": "whatsapp",
  "channelId": "chat_alice_123"
}
```

Only `text` is required. `sender`, `platform`, and `channelId` are optional enrichment.

Alternatively, test immediately with `curl`:

**Linux / macOS (bash)**

```bash
curl -X POST http://localhost:6122/webhook \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello AIRI! You got a WhatsApp message.","sender":{"name":"Alice"},"platform":"whatsapp","channelId":"chat1"}'
```

**Windows — Command Prompt (`cmd.exe`)**

```cmd
curl -X POST http://localhost:6122/webhook ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"Hello AIRI!\",\"sender\":{\"name\":\"Alice\"},\"platform\":\"whatsapp\",\"channelId\":\"chat1\"}"
```

**Windows — PowerShell** (use `curl.exe` to call real curl, not the `Invoke-WebRequest` alias)

```powershell
curl.exe -X POST http://localhost:6122/webhook `
  -H "Content-Type: application/json" `
  -d '{"text":"Hello AIRI!","sender":{"name":"Alice"},"platform":"whatsapp","channelId":"chat1"}'
```

> **Tip**: if you get `{"error":"Invalid JSON"}`, check that your shell is not wrapping the body with extra quotes.  
> Use `GET /health` first to confirm the service is up: `curl http://localhost:6122/health`

You should see アイリ's avatar display a chat bubble popup in response.

> **I sent the curl request and got `{"ok":true}`, but I don't see the popup.**
>
> Work through this checklist:
> 1. **Is stage-web open?** Open `http://localhost:5173` in a browser.
> 2. **Is an LLM provider configured?** Without one the server receives the event but has
>    nothing to reply with. Go to **Settings → Modules → Consciousness** and add a provider.
> 3. **Is server-runtime running?** If this service says "connected" in its logs you're fine.
>    If it keeps reconnecting, start `pnpm -F @proj-airi/server-runtime start` first.
> 4. **Quick smoke-test:** open **Settings → Developer → Chat** in stage-web and click
>    **▶ Inject simulated response** — if the bubble appears there but not after a curl call,
>    the issue is in the LLM provider or server-runtime connection, not the avatar itself.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook` | Receive a message notification from OpenClaw |
| `GET` | `/health` | Health check — returns `{"ok":true}` |

## Architecture notes

- Each `(platform, channelId)` pair gets its own AIRI session (`openclaw-<platform>-<channelId>`), so conversations on different channels are isolated.
- The `messagePrefix` injected into the AIRI prompt tells the LLM who is speaking and from which platform.
- The `contextUpdates` array carries structured OpenClaw metadata through the AIRI pipeline. It is available in both `output:gen-ai:chat:complete` and `output:gen-ai:chat:message` events under `event.data['gen-ai:chat'].input.data.openclaw` for any future relay logic.

## Extending

To send AIRI's response *back* through OpenClaw, listen for `output:gen-ai:chat:complete` in the adapter and use OpenClaw's CLI or REST API to reply. The event carries the complete assistant message at `event.data.message.content`, and the original input context (including the `openclaw` metadata you sent) is available under `event.data['gen-ai:chat'].input.data.openclaw`:

```bash
openclaw message send --to <channelId> --message "<airi-response>"
```

See `src/adapters/airi-adapter.ts` for the `setupAiriEventHandlers` method where this can be added.

---

## Testing with the simulation script

The repository ships a **zero-dependency** Node.js script that lets you send a test message and see AIRI's response — no OpenClaw installation required. It has two modes:

### Prerequisites

Before running the script, ensure all required services are up:

| # | Service | Command | Port |
|---|---------|---------|------|
| 1 | **server-runtime** | `pnpm -F @proj-airi/server-runtime dev` | 6121 |
| 2 | **stage-web** (open in browser) | `pnpm -F @proj-airi/stage-web dev` | 5173 |
| 3 | **LLM provider** | Configured in stage-web Settings → Modules → Consciousness | — |
| 4 | **openclaw** *(webhook mode only)* | `pnpm -F @proj-airi/openclaw dev` | 6122 |

> **Important**: Without an LLM provider configured in stage-web, messages are accepted but never answered — you will see `input:text` in the WebSocket Inspector but no `output:gen-ai:chat:complete` in response.

### Mode 1 — Direct (recommended for quick tests)

This mode sends the message straight to server-runtime via WebSocket, bypassing the openclaw HTTP layer. Only services 1–3 above are needed.

```bash
# Default message (Chinese greeting):
node scripts/simulate-openclaw-message.mjs --direct

# Custom message:
node scripts/simulate-openclaw-message.mjs --direct --text "你能做些什么？"

# With auth token (if server-runtime requires one):
node scripts/simulate-openclaw-message.mjs --direct --token mySecret
```

Expected output:

```
🔌  Direct WebSocket mode
   URL     : ws://localhost:6121/ws
   Message : 你好！请简单介绍一下你自己。
   ...

✓  Connected & authenticated
✓  input:text event sent
   Waiting for AIRI response (timeout: 120s)...

🗨️   AIRI avatar response received:
   我可以陪你聊天呀，也可以帮你做很多事情。...

👀  Check the browser — the ChatBubble overlay should be visible above the avatar.
```

### Mode 2 — Webhook (end-to-end test)

This mode POST to the openclaw HTTP webhook, exactly as OpenClaw itself would. All four services above must be running.

```bash
# Default message:
node scripts/simulate-openclaw-message.mjs

# Custom message:
node scripts/simulate-openclaw-message.mjs --text "你好！"

# Custom webhook URL:
node scripts/simulate-openclaw-message.mjs --webhook-url http://localhost:6122/webhook --text "Hello!"
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Timed out after 120s` | No LLM provider configured | Open stage-web → Settings → Modules → Consciousness and select a provider + model |
| `Timed out after 120s` | LLM is very slow | Pass `--timeout 300` for a larger budget |
| `Error: connect ECONNREFUSED` | server-runtime not running | `pnpm -F @proj-airi/server-runtime dev` |
| Webhook: `fetch failed` on POST | openclaw service not running | `pnpm -F @proj-airi/openclaw dev` |
| `input:text` visible as **Incoming** in WebSocket Inspector but no **Outgoing** `output:gen-ai:chat:complete` | LLM not configured, or stage-web served over plain HTTP on a non-localhost address | 1. Verify LLM in Settings → Modules → Consciousness. 2. If accessing stage-web via `http://192.168.x.x:port`, the browser's Web Locks API is unavailable (requires HTTPS or localhost) — use `http://localhost:port` instead. 3. Open the browser DevTools console and look for `[context-bridge]` log lines to pinpoint the failure. |
| Browser console shows `[context-bridge] navigator.locks.request failed` | stage-web not served over a secure context | Access stage-web via `http://localhost:port` or set up HTTPS |

Show all options:

```bash
node scripts/simulate-openclaw-message.mjs --help
```
