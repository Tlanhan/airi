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
 *    Optionally:
 *      pnpm -F @proj-airi/openclaw dev          (port 6122, for --webhook mode)
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
 * What to observe
 * ---------------
 *  After running the script, watch the stage-web page in your browser.
 *  The avatar should receive the message, process it through the LLM, and a
 *  ChatBubbleMinimalism overlay should appear above the avatar showing the reply.
 *  The response is also printed to the console here.
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
  (default)  Webhook mode — POST to the OpenClaw service webhook
  --direct   Direct WebSocket mode — connect straight to server-runtime

OPTIONS
  --text <msg>           Message text to send  (default: greeting in Chinese)
  --sender-id <id>       Sender ID             (default: test-user-001)
  --sender-name <name>   Sender display name   (default: 测试用户)
  --platform <name>      Platform tag          (default: test)
  --channel <id>         Channel/chat ID       (default: test-channel-001)

  Webhook mode only:
  --webhook-url <url>    Webhook URL           (default: http://localhost:6122/webhook)

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
async function runWebhookMode(opts) {
  console.log(colorBold('\n📨  Webhook mode'))
  console.log(`   URL     : ${colorCyan(opts.webhookUrl)}`)
  console.log(`   Message : ${colorYellow(opts.text)}`)
  console.log(`   Sender  : ${opts.sender.name} (${opts.sender.id})`)
  console.log(`   Platform: ${opts.platform} / channel: ${opts.channelId}\n`)

  const body = JSON.stringify({
    text: opts.text,
    sender: opts.sender,
    platform: opts.platform,
    channelId: opts.channelId,
  })

  let res
  try {
    res = await fetch(opts.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  }
  catch (err) {
    console.error(colorRed(`✗  Could not reach ${opts.webhookUrl}`))
    console.error(`   ${err.message}`)
    console.error(`\n   Tip: Make sure the OpenClaw service is running:`)
    console.error(`     pnpm -F @proj-airi/openclaw dev`)
    console.error(`   Or use --direct to bypass it and talk to server-runtime directly.\n`)
    process.exit(1)
  }

  const responseText = await res.text()
  if (res.ok) {
    console.log(colorGreen(`✓  Webhook accepted (HTTP ${res.status})`))
    console.log(`   Response: ${responseText}`)
    console.log()
    console.log(colorBold('👀  Now watch the avatar in the browser!'))
    console.log(`   The avatar should receive the message through the server-runtime`)
    console.log(`   and display the LLM response as a ChatBubble overlay above it.`)
    console.log()
  }
  else {
    console.error(colorRed(`✗  Webhook returned HTTP ${res.status}`))
    console.error(`   Response: ${responseText}`)
    process.exit(1)
  }
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

            // Announce ourselves as the simulate-openclaw test module
            ws.send(buildEvent('module:announce', {
              name: 'simulate-openclaw',
              possibleEvents: ['input:text', 'output:gen-ai:chat:message'],
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

        case 'output:gen-ai:chat:message': {
          clearTimeout(timeout)
          const payload = msg.data?.['gen-ai:chat']
          const content = payload?.message?.content ?? payload?.message ?? '(no content)'
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
