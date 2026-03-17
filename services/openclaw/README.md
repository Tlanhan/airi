# @proj-airi/openclaw-bot

Bridges [OpenClaw](https://github.com/openclaw/openclaw) message notifications to the AIRI avatar stage.

**Effect**: when OpenClaw receives a message on any of its 20+ supported channels (WhatsApp, Signal, iMessage, LINE, Slack, Matrix, etc.), this service forwards it to AIRI's server. AIRI's LLM reacts to the message and the response is shown as a chat bubble popup on アイリ's avatar.

```
OpenClaw (any channel)
  │  POST /webhook
  ▼
openclaw-bot (this service, HTTP :6122)
  │  input:text  (WebSocket)
  ▼
AIRI server-runtime (:6121)
  │  LLM reasoning
  ▼
output:gen-ai:chat:message
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
4. The response (`output:gen-ai:chat:message`) is displayed as a chat bubble on the AIRI avatar stage — that's the popup the user sees.

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
> | 4 | **openclaw-bot** (this service) | `pnpm start` | Bridges OpenClaw webhooks to the server |

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
- The `contextUpdates` array carries structured OpenClaw metadata through the AIRI pipeline. It is available in the `output:gen-ai:chat:message` event under `event.data['gen-ai:chat'].input.data.openclaw` for any future relay logic.

## Extending

To send AIRI's response *back* through OpenClaw, listen for `output:gen-ai:chat:message` in the adapter and use OpenClaw's CLI or REST API to reply. The event data carries the original input context (including the `openclaw` metadata you sent) under `event.data['gen-ai:chat'].input.data.openclaw`:

```bash
openclaw message send --to <channelId> --message "<airi-response>"
```

See `src/adapters/airi-adapter.ts` for the `setupAiriEventHandlers` method where this can be added.
