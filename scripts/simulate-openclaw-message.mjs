#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * @file simulate-openclaw-message.mjs
 *
 * Test script: simulate an OpenClaw message and watch the AIRI avatar respond.
 *
 * Prerequisites
 * -------------
 *  - The AIRI project must already be running:
 *      pnpm -F @proj-airi/server-runtime dev   (port 6121)
 *      pnpm -F @proj-airi/stage-web dev         (browser UI)
 *    Webhook mode additionally requires:
 *      pnpm -F @proj-airi/openclaw dev          (port 6122)
 *
 *  - An LLM provider and model must be configured in stage-web:
 *      Open stage-web in the browser → Settings → Modules → Consciousness
 *      Select a provider (e.g. Ollama, OpenAI) and a model.
 *      Without this, stage-web silently drops incoming messages — you will see
 *      "input:text" in the WebSocket Inspector (Incoming) but no
 *      "output:gen-ai:chat:complete" (Outgoing).
 *
 * Usage
 * -----
 *  # Mode 1 – Webhook (requires the openclaw service on port 6122):
 *    node scripts/simulate-openclaw-message.mjs
 *    node scripts/simulate-openclaw-message.mjs --text "你好，请介绍一下你自己"
 *    node scripts/simulate-openclaw-message.mjs --webhook-url http://localhost:6122/webhook --text "Hello!"
 *
 *  # Mode 2 – Direct WebSocket to server-runtime (no openclaw service needed):
 *    node scripts/simulate-openclaw-message.mjs --direct
 *    node scripts/simulate-openclaw-message.mjs --direct --text "今天天气怎么样？"
 *    node scripts/simulate-openclaw-message.mjs --direct --ws-url ws://localhost:6121/ws --token mySecret
 *
 *  # Show help:
 *    node scripts/simulate-openclaw-message.mjs --help
 *
 * Why webhook mode also opens a WebSocket
 * ----------------------------------------
 *  The LLM response does NOT come back through the HTTP webhook POST — it
 *  arrives as a WebSocket event emitted by stage-web back through server-runtime.
 *  There are two relevant events:
 *    - `output:gen-ai:chat:message`  — emitted for each streaming chunk
 *      (may not fire at all for non-streaming providers).
 *    - `output:gen-ai:chat:complete` — emitted once the full LLM turn is done
 *      (always emitted regardless of streaming mode; this is the definitive response).
 *
 *  The real @proj-airi/openclaw service works the same way:
 *    1. It exposes an HTTP webhook to *receive* messages from OpenClaw.
 *    2. It maintains a *persistent* WebSocket connection to server-runtime to
 *       both *forward* those messages to stage-web and *receive* LLM responses.
 *
 *  Webhook mode in this script therefore:
 *    1. Opens a WebSocket to server-runtime (to listen for responses).
 *    2. Waits until the connection is authenticated and registered.
 *    3. POSTs the message to the openclaw HTTP webhook.
 *    4. Waits for `output:gen-ai:chat:message` OR `output:gen-ai:chat:complete`
 *       on the WebSocket and prints the first one that arrives.
 *
 * What to observe
 * ---------------
 *  After running the script, watch the stage-web page in your browser.
 *  The avatar should receive the message, process it through the LLM, and a
 *  ChatBubbleMinimalism overlay should appear above the avatar showing the reply.
 *  The response is also printed to the console here.
 *
 * Troubleshooting — script times out / no response
 * -------------------------------------------------
 *  If the script prints a timeout error and you see only "Incoming" events in
 *  the stage-web WebSocket Inspector (no "Outgoing" output:gen-ai:chat:complete),
 *  the most common cause is that no LLM provider or model has been configured:
 *    Open stage-web → Settings → Modules → Consciousness → select a provider and model.
 *  After configuring, re-run the script.
 *  You can also check the browser console for a "[context-bridge]" warning.
 */

import { argv } from 'node:process'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(args) {
  const result = {
    help: false,
    direct: false,
    text: '你好！请简单介绍一下你自己。',
    sender: { id: 'test-user-001', name: '测试用户' },
    platform: 'test',
    channelId: 'test-channel-001',
    webhookUrl: 'http://localhost:6122/webhook',
    wsUrl: 'ws://localhost:6121/ws',
    token: undefined,
    timeoutMs: 30_000,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--help':
      case '-h':
        result.help = true
        break
      case '--direct':
        result.direct = true
        break
      case '--text':
        result.text = args[++i] ?? result.text
        break
      case '--sender-id':
        result.sender.id = args[++i] ?? result.sender.id
        break
      case '--sender-name':
        result.sender.name = args[++i] ?? result.sender.name
        break
      case '--platform':
        result.platform = args[++i] ?? result.platform
        break
      case '--channel':
        result.channelId = args[++i] ?? result.channelId
        break
      case '--webhook-url':
        result.webhookUrl = args[++i] ?? result.webhookUrl
        break
      case '--ws-url':
        result.wsUrl = args[++i] ?? result.wsUrl
        break
      case '--token':
        result.token = args[++i]
        break
      case '--timeout':
        // User provides seconds; convert to milliseconds for internal use.
        result.timeoutMs = Number.parseInt(args[++i] ?? '30', 10) * 1_000
        break
    }
  }

  return result
}

function printHelp() {
  console.log(`
simulate-openclaw-message.mjs — Send a test message and watch the AIRI avatar reply

USAGE
  node scripts/simulate-openclaw-message.mjs [OPTIONS]

MODES
  (default)  Webhook mode — POST to the OpenClaw webhook AND listen for the
             LLM response on the server-runtime WebSocket (mirrors how the real
             openclaw service works: HTTP in, WebSocket out).
  --direct   Direct WebSocket mode — connect straight to server-runtime (no
             openclaw service needed).

WHY BOTH MODES NEED A WEBSOCKET
  The LLM response does NOT come back over HTTP — it arrives as a WebSocket
  event from server-runtime.  Two events carry the response:
    output:gen-ai:chat:message   — one event per streaming chunk (may not fire
                                   for non-streaming providers)
    output:gen-ai:chat:complete  — fired once the full turn is done (always
                                   emitted; this is the definitive final answer)
  The script resolves as soon as either event arrives.
  Webhook mode opens a WebSocket listener BEFORE posting so it cannot miss
  any events.  The real openclaw service does the same thing.

OPTIONS
  --text <msg>           Message text to send  (default: greeting in Chinese)
  --sender-id <id>       Sender ID             (default: test-user-001)
  --sender-name <name>   Sender display name   (default: 测试用户)
  --platform <name>      Platform tag          (default: test)
  --channel <id>         Channel/chat ID       (default: test-channel-001)

  Webhook mode:
  --webhook-url <url>    Webhook URL           (default: http://localhost:6122/webhook)
  --ws-url <url>         server-runtime WS URL (default: ws://localhost:6121/ws)
  --token <token>        Auth token for server-runtime (if required)

  Direct WebSocket mode only:
  --ws-url <url>         Server-runtime WS URL (default: ws://localhost:6121/ws)
  --token <token>        Auth token            (if server requires one)

  --timeout <seconds>    Response wait timeout (default: 30)
  --help, -h             Show this help
`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a raw WebSocket message from the server.
 *  The server uses superjson.stringify, which wraps the payload as
 *  { json: <payload>, meta: <type-metadata> }.  Plain JSON is also accepted
 *  here in case the server version is plain-JSON-based. */
function parseServerMessage(raw) {
  try {
    const obj = JSON.parse(raw)
    // superjson wrapper: { json: { type, data, ... }, meta: ... }
    if (obj && typeof obj === 'object' && 'json' in obj && typeof obj.json === 'object') {
      return obj.json
    }
    return obj
  }
  catch {
    return null
  }
}

/** Build a minimal WebSocket event envelope (plain JSON; server accepts both
 *  superjson and plain JSON, see NOTICE in packages/server-runtime/src/index.ts). */
function buildEvent(type, data, instanceId) {
  return JSON.stringify({
    type,
    data,
    metadata: {
      source: {
        kind: 'plugin',
        plugin: { id: 'simulate-openclaw' },
        id: instanceId,
      },
      event: {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      },
    },
  })
}

function colorGreen(s) { return `\x1B[32m${s}\x1B[0m` }
function colorYellow(s) { return `\x1B[33m${s}\x1B[0m` }
function colorCyan(s) { return `\x1B[36m${s}\x1B[0m` }
function colorRed(s) { return `\x1B[31m${s}\x1B[0m` }
function colorBold(s) { return `\x1B[1m${s}\x1B[0m` }

// ---------------------------------------------------------------------------
// Mode 1: Webhook
// ---------------------------------------------------------------------------
//
// WHY webhook mode also opens a WebSocket
// ----------------------------------------
// The LLM response does NOT come back through the HTTP POST — it arrives as a
// WebSocket event emitted by stage-web back through server-runtime.
// Two events carry the response:
//   - `output:gen-ai:chat:message`  — one event per streaming chunk
//   - `output:gen-ai:chat:complete` — fired once the full turn is done (always emitted)
// The real `@proj-airi/openclaw` service works the same way:
//   1. It exposes an HTTP webhook to *receive* messages from OpenClaw.
//   2. It maintains a *persistent* WebSocket connection to server-runtime so it
//      can *send* those messages to stage-web AND *receive* the LLM responses.
//
// Without that second connection the script would just fire-and-forget —
// you'd see `input:text` in the stage-web WebSocket Inspector (Incoming) but
// never `output:gen-ai:chat:complete` (Outgoing) in the script's console.
//
// Solution: open the server-runtime WebSocket BEFORE posting so there's no
// race condition, POST the message to openclaw, then wait for the response.
async function runWebhookMode(opts) {
  console.log(colorBold('\n📨  Webhook mode (with response listener)'))
  console.log(`   Webhook : ${colorCyan(opts.webhookUrl)}`)
  console.log(`   WS URL  : ${colorCyan(opts.wsUrl)}`)
  console.log(`   Message : ${colorYellow(opts.text)}`)
  console.log(`   Sender  : ${opts.sender.name} (${opts.sender.id})`)
  console.log(`   Platform: ${opts.platform} / channel: ${opts.channelId}\n`)

  const body = JSON.stringify({
    text: opts.text,
    sender: opts.sender,
    platform: opts.platform,
    channelId: opts.channelId,
  })

  const instanceId = `sim-webhook-${Date.now().toString(36)}`

  return new Promise((resolve, reject) => {
    let ws
    try {
      // NOTICE: Uses Node.js 22+ native WebSocket (available as a global via globalThis).
      // No `ws` package dependency is needed — this keeps the script zero-dependency so it
      // runs with just `node scripts/simulate-openclaw-message.mjs` without any install step.
      // Reference: https://nodejs.org/en/blog/announcements/v22-release-announce#websocket
      ws = new globalThis.WebSocket(opts.wsUrl)
    }
    catch {
      console.error(colorRed('✗  WebSocket constructor not available.'))
      console.error('   Requires Node.js 22+. Current version: ' + process.version)
      process.exit(1)
    }

    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out after ${opts.timeoutMs / 1000}s waiting for LLM response`))
    }, opts.timeoutMs)

    let announced = false
    let posted = false

    async function postWebhook() {
      let res
      try {
        res = await fetch(opts.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      }
      catch (err) {
        clearTimeout(timeout)
        ws.close()
        console.error(colorRed(`✗  Could not reach ${opts.webhookUrl}`))
        console.error(`   ${err.message}`)
        console.error(`\n   Tip: Make sure the OpenClaw service is running:`)
        console.error(`     pnpm -F @proj-airi/openclaw dev`)
        console.error(`   Or use --direct to bypass openclaw and talk to server-runtime directly.\n`)
        reject(new Error(err.message))
        return
      }

      const responseText = await res.text()
      if (res.ok) {
        console.log(colorGreen(`✓  Webhook accepted (HTTP ${res.status}): ${responseText}`))
        console.log(`   Waiting for LLM response on WebSocket (timeout: ${opts.timeoutMs / 1000}s)...`)
        console.log()
      }
      else {
        clearTimeout(timeout)
        ws.close()
        console.error(colorRed(`✗  Webhook returned HTTP ${res.status}`))
        console.error(`   Response: ${responseText}`)
        reject(new Error(`Webhook HTTP ${res.status}`))
      }
    }

    ws.addEventListener('error', (event) => {
      clearTimeout(timeout)
      console.error(colorRed(`✗  WebSocket error: ${event.message ?? 'unknown'}`))
      console.error(`\n   Tip: Make sure server-runtime is running:`)
      console.error(`     pnpm -F @proj-airi/server-runtime dev\n`)
      reject(new Error('WebSocket error'))
    })

    ws.addEventListener('close', () => {
      clearTimeout(timeout)
    })

    ws.addEventListener('message', (event) => {
      const msg = parseServerMessage(event.data)
      if (!msg || !msg.type) return

      switch (msg.type) {
        case 'module:authenticated': {
          if (msg.data?.authenticated && !announced) {
            announced = true
            console.log(colorGreen('✓  Connected to server-runtime & authenticated'))

            // Mirror what the real openclaw service registers itself as.
            // Both output:gen-ai:chat:message (per-chunk during streaming) and
            // output:gen-ai:chat:complete (full turn result) must be listed so
            // server-runtime routes either event to this connection.
            ws.send(buildEvent('module:announce', {
              name: 'simulate-openclaw-webhook',
              possibleEvents: ['output:gen-ai:chat:message', 'output:gen-ai:chat:complete'],
              identity: {
                kind: 'plugin',
                plugin: { id: 'simulate-openclaw-webhook' },
                id: instanceId,
              },
            }, instanceId))
          }
          break
        }

        case 'registry:modules:sync': {
          // Once we're registered, post the webhook.  We defer this to after the
          // registry sync so server-runtime has acknowledged our connection,
          // guaranteeing our output:gen-ai:chat:* listener is active before
          // the HTTP POST triggers stage-web to start processing.
          if (announced && !posted) {
            posted = true
            postWebhook().catch(reject)
          }
          break
        }

        // output:gen-ai:chat:message fires for each streaming chunk (may fire
        // multiple times or not at all depending on the provider/model).
        // The assistant response is at data.message.content; data['gen-ai:chat'].message
        // holds the user (input) message and should not be used here.
        case 'output:gen-ai:chat:message': {
          clearTimeout(timeout)
          const content = msg.data?.message?.content ?? '(no content)'
          console.log(colorBold('🗨️   AIRI avatar response received (streaming chunk):'))
          console.log(colorGreen(`   ${content}`))
          console.log()
          console.log(colorBold('👀  Check the browser — the ChatBubble overlay should be visible above the avatar.'))
          console.log()
          ws.close()
          resolve()
          break
        }

        // output:gen-ai:chat:complete fires once the full LLM turn is finished.
        // This is the definitive final response — always emitted, even when
        // output:gen-ai:chat:message is not (e.g. non-streaming providers).
        // The assistant response is at data.message.content (same path as above).
        case 'output:gen-ai:chat:complete': {
          clearTimeout(timeout)
          const content = msg.data?.message?.content ?? '(no content)'
          console.log(colorBold('🗨️   AIRI avatar response received:'))
          console.log(colorGreen(`   ${content}`))
          console.log()
          console.log(colorBold('👀  Check the browser — the ChatBubble overlay should be visible above the avatar.'))
          console.log()
          ws.close()
          resolve()
          break
        }

        case 'error': {
          const errMsg = msg.data?.message ?? 'unknown error'
          console.error(colorRed(`✗  Server error: ${errMsg}`))
          clearTimeout(timeout)
          ws.close()
          reject(new Error(errMsg))
          break
        }
      }
    })

    ws.addEventListener('open', () => {
      if (opts.token) {
        ws.send(buildEvent('module:authenticate', { token: opts.token }, instanceId))
      }
      // No-token: server will send module:authenticated automatically, handled above
    })
  })
}

// ---------------------------------------------------------------------------
// Mode 2: Direct WebSocket
// ---------------------------------------------------------------------------
async function runDirectMode(opts) {
  console.log(colorBold('\n🔌  Direct WebSocket mode'))
  console.log(`   URL     : ${colorCyan(opts.wsUrl)}`)
  console.log(`   Message : ${colorYellow(opts.text)}`)
  console.log(`   Sender  : ${opts.sender.name} (${opts.sender.id})`)
  console.log(`   Platform: ${opts.platform} / channel: ${opts.channelId}\n`)

  const instanceId = `sim-${Date.now().toString(36)}`

  return new Promise((resolve, reject) => {
    let ws
    try {
      // NOTICE: Uses Node.js 22+ native WebSocket (available as a global via globalThis).
      // No `ws` package dependency is needed — this keeps the script zero-dependency so it
      // runs with just `node scripts/simulate-openclaw-message.mjs` without any install step.
      // Reference: https://nodejs.org/en/blog/announcements/v22-release-announce#websocket
      ws = new globalThis.WebSocket(opts.wsUrl)
    }
    catch {
      console.error(colorRed('✗  WebSocket constructor not available.'))
      console.error('   Requires Node.js 22+. Current version: ' + process.version)
      process.exit(1)
    }

    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out after ${opts.timeoutMs / 1000}s waiting for response`))
    }, opts.timeoutMs)

    let announced = false
    let messageSent = false

    ws.addEventListener('error', (event) => {
      clearTimeout(timeout)
      console.error(colorRed(`✗  WebSocket error: ${event.message ?? 'unknown'}`))
      console.error(`\n   Tip: Make sure the server-runtime is running:`)
      console.error(`     pnpm -F @proj-airi/server-runtime dev\n`)
      reject(new Error('WebSocket error'))
    })

    ws.addEventListener('close', () => {
      clearTimeout(timeout)
    })

    ws.addEventListener('message', (event) => {
      const msg = parseServerMessage(event.data)
      if (!msg || !msg.type) return

      switch (msg.type) {
        case 'module:authenticated': {
          if (msg.data?.authenticated && !announced) {
            announced = true
            console.log(colorGreen('✓  Connected & authenticated'))

            // Announce ourselves as the simulate-openclaw test module.
            // Both output:gen-ai:chat:message (per-chunk during streaming) and
            // output:gen-ai:chat:complete (full turn result) must be listed so
            // server-runtime routes either event to this connection.
            ws.send(buildEvent('module:announce', {
              name: 'simulate-openclaw',
              possibleEvents: ['input:text', 'output:gen-ai:chat:message', 'output:gen-ai:chat:complete'],
              identity: {
                kind: 'plugin',
                plugin: { id: 'simulate-openclaw' },
                id: instanceId,
              },
            }, instanceId))
          }
          break
        }

        case 'registry:modules:sync': {
          if (announced && !messageSent) {
            messageSent = true

            const senderName = opts.sender.name ?? opts.sender.id ?? 'OpenClaw'
            const platform = opts.platform
            const channelId = opts.channelId
            const notice = `This message was received through OpenClaw on platform '${platform}', channel '${channelId}'.`

            // Mirror exactly what OpenClawAdapter does (airi-adapter.ts)
            ws.send(buildEvent('input:text', {
              text: opts.text,
              textRaw: opts.text,
              overrides: {
                sessionId: `openclaw-${platform}-${channelId}`,
                messagePrefix: `(From ${senderName} via OpenClaw/${platform}): `,
              },
              openclaw: {
                platform,
                channelId,
                sender: opts.sender,
              },
              contextUpdates: [{
                strategy: 'append-self',
                text: notice,
                content: notice,
                metadata: {
                  openclaw: { platform, channelId, sender: opts.sender },
                },
              }],
            }, instanceId))

            console.log(colorGreen('✓  input:text event sent'))
            console.log(`   Waiting for AIRI response (timeout: ${opts.timeoutMs / 1000}s)...`)
            console.log()
          }
          break
        }

        // output:gen-ai:chat:message fires for each streaming chunk (may fire
        // multiple times or not at all depending on the provider/model).
        // The assistant response is at data.message.content; data['gen-ai:chat'].message
        // holds the user (input) message and should not be used here.
        case 'output:gen-ai:chat:message': {
          clearTimeout(timeout)
          const content = msg.data?.message?.content ?? '(no content)'
          console.log(colorBold('🗨️   AIRI avatar response received (streaming chunk):'))
          console.log(colorGreen(`   ${content}`))
          console.log()
          console.log(colorBold('👀  Check the browser — the ChatBubble overlay should be visible above the avatar.'))
          console.log()
          ws.close()
          resolve()
          break
        }

        // output:gen-ai:chat:complete fires once the full LLM turn is finished.
        // This is the definitive final response — always emitted, even when
        // output:gen-ai:chat:message is not (e.g. non-streaming providers).
        // The assistant response is at data.message.content (same path as above).
        case 'output:gen-ai:chat:complete': {
          clearTimeout(timeout)
          const content = msg.data?.message?.content ?? '(no content)'
          console.log(colorBold('🗨️   AIRI avatar response received:'))
          console.log(colorGreen(`   ${content}`))
          console.log()
          console.log(colorBold('👀  Check the browser — the ChatBubble overlay should be visible above the avatar.'))
          console.log()
          ws.close()
          resolve()
          break
        }

        case 'error': {
          const errMsg = msg.data?.message ?? 'unknown error'
          console.error(colorRed(`✗  Server error: ${errMsg}`))
          clearTimeout(timeout)
          ws.close()
          reject(new Error(errMsg))
          break
        }
      }
    })

    // If token is provided, authenticate first; otherwise the server auto-authenticates
    ws.addEventListener('open', () => {
      if (opts.token) {
        ws.send(buildEvent('module:authenticate', { token: opts.token }, instanceId))
      }
      // No-token: server will send module:authenticated automatically, handled above
    })
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const opts = parseArgs(argv.slice(2))

if (opts.help) {
  printHelp()
  process.exit(0)
}

console.log(colorBold('\n━━  AIRI OpenClaw Message Simulator  ━━'))

try {
  if (opts.direct) {
    await runDirectMode(opts)
  }
  else {
    await runWebhookMode(opts)
  }
}
catch (err) {
  console.error(colorRed(`\n✗  ${err.message}`))
  process.exit(1)
}
