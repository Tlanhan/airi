#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * @file simulate.mjs
 *
 * 零依赖测试脚本 — 模拟 webhook 消息发送并监听 AIRI 回复。
 *
 * 两种模式：
 *   Webhook 模式（默认）：POST 到 webhook adapter → 通过 WS 监听回复
 *   Direct 模式：直连事件中枢发送 input:text → 通过 WS 监听回复
 *
 * 使用方法：
 *   node scripts/simulate.mjs                           # webhook 模式
 *   node scripts/simulate.mjs --text "Hello"            # 自定义消息
 *   node scripts/simulate.mjs --direct                  # 直连模式
 *   node scripts/simulate.mjs --direct --text "你好"    # 直连+自定义消息
 *
 * 需要 Node.js 22+（使用原生 WebSocket）
 */

import process from 'node:process'

// ---------------------------------------------------------------------------
// 参数解析
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
    wsUrl: 'ws://localhost:6121',
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
        result.timeoutMs = Number.parseInt(args[++i] ?? '30', 10) * 1000
        break
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function buildEvent(type, data, instanceId) {
  return JSON.stringify({
    type,
    data,
    metadata: {
      source: {
        kind: 'plugin',
        plugin: { id: 'simulate-webhook' },
        id: instanceId,
      },
      event: {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      },
    },
  })
}

function parseServerMessage(raw) {
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && 'json' in obj && typeof obj.json === 'object') {
      return obj.json
    }
    return obj
  }
  catch {
    return null
  }
}

const green = s => `\x1B[32m${s}\x1B[0m`
const yellow = s => `\x1B[33m${s}\x1B[0m`
const cyan = s => `\x1B[36m${s}\x1B[0m`
const red = s => `\x1B[31m${s}\x1B[0m`
const bold = s => `\x1B[1m${s}\x1B[0m`

// ---------------------------------------------------------------------------
// Webhook 模式
// ---------------------------------------------------------------------------

async function runWebhookMode(opts) {
  console.log(bold('\n📨  Webhook 模式'))
  console.log(`   Webhook : ${cyan(opts.webhookUrl)}`)
  console.log(`   WS URL  : ${cyan(opts.wsUrl)}`)
  console.log(`   消息    : ${yellow(opts.text)}`)
  console.log(`   发送者  : ${opts.sender.name}\n`)

  const body = JSON.stringify({
    text: opts.text,
    sender: opts.sender,
    platform: opts.platform,
    channelId: opts.channelId,
  })

  const instanceId = `sim-${Date.now().toString(36)}`

  return new Promise((resolve, reject) => {
    let ws
    try {
      ws = new globalThis.WebSocket(opts.wsUrl)
    }
    catch {
      console.error(red('✗  WebSocket 不可用，需要 Node.js 22+'))
      process.exit(1)
    }

    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`超时 (${opts.timeoutMs / 1000}s)，未收到回复`))
    }, opts.timeoutMs)

    let announced = false
    let posted = false

    async function postWebhook() {
      try {
        const res = await fetch(opts.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        const text = await res.text()
        if (res.ok) {
          console.log(green(`✓  Webhook 已接收 (HTTP ${res.status}): ${text}`))
          console.log(`   等待回复中 (超时: ${opts.timeoutMs / 1000}s)...\n`)
        }
        else {
          clearTimeout(timeout)
          ws.close()
          reject(new Error(`Webhook HTTP ${res.status}: ${text}`))
        }
      }
      catch (err) {
        clearTimeout(timeout)
        ws.close()
        console.error(red(`✗  无法连接 ${opts.webhookUrl}`))
        console.error(`   提示: 确保 webhook adapter 已启动\n`)
        reject(err)
      }
    }

    ws.addEventListener('message', (event) => {
      const msg = parseServerMessage(event.data)
      if (!msg || !msg.type)
        return

      switch (msg.type) {
        case 'module:authenticated':
          if (!announced) {
            announced = true
            console.log(green('✓  已连接事件中枢'))
            ws.send(buildEvent('module:announce', {
              name: 'simulate-webhook',
              possibleEvents: ['output:gen-ai:chat:message', 'output:gen-ai:chat:complete'],
              identity: { kind: 'plugin', plugin: { id: 'simulate-webhook' }, id: instanceId },
            }, instanceId))
          }
          break

        case 'registry:modules:sync':
          if (announced && !posted) {
            posted = true
            postWebhook().catch(reject)
          }
          break

        case 'output:gen-ai:chat:message':
        case 'output:gen-ai:chat:complete': {
          clearTimeout(timeout)
          const content = msg.data?.message?.content ?? '(无内容)'
          const label = msg.type.includes('complete') ? '完整回复' : '流式分块'
          console.log(bold(`🗨️  AIRI 回复 (${label}):`))
          console.log(green(`   ${content}`))
          console.log()
          ws.close()
          resolve()
          break
        }
      }
    })

    ws.addEventListener('open', () => {
      if (opts.token) {
        ws.send(buildEvent('module:authenticate', { token: opts.token }, instanceId))
      }
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      console.error(red('✗  WebSocket 连接失败'))
      console.error(`   提示: 确保事件中枢已启动 (端口: ${opts.wsUrl})\n`)
      reject(new Error('WebSocket error'))
    })
  })
}

// ---------------------------------------------------------------------------
// Direct 模式（绕过 webhook，直连事件中枢）
// ---------------------------------------------------------------------------

async function runDirectMode(opts) {
  console.log(bold('\n🔌  Direct 模式（直连事件中枢）'))
  console.log(`   WS URL  : ${cyan(opts.wsUrl)}`)
  console.log(`   消息    : ${yellow(opts.text)}`)
  console.log(`   发送者  : ${opts.sender.name}\n`)

  const instanceId = `sim-direct-${Date.now().toString(36)}`

  return new Promise((resolve, reject) => {
    let ws
    try {
      ws = new globalThis.WebSocket(opts.wsUrl)
    }
    catch {
      console.error(red('✗  WebSocket 不可用，需要 Node.js 22+'))
      process.exit(1)
    }

    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`超时 (${opts.timeoutMs / 1000}s)，未收到回复`))
    }, opts.timeoutMs)

    let announced = false
    let sent = false

    ws.addEventListener('message', (event) => {
      const msg = parseServerMessage(event.data)
      if (!msg || !msg.type)
        return

      switch (msg.type) {
        case 'module:authenticated':
          if (!announced) {
            announced = true
            console.log(green('✓  已连接事件中枢'))
            ws.send(buildEvent('module:announce', {
              name: 'simulate-direct',
              possibleEvents: [
                'input:text',
                'output:gen-ai:chat:message',
                'output:gen-ai:chat:complete',
              ],
              identity: { kind: 'plugin', plugin: { id: 'simulate-direct' }, id: instanceId },
            }, instanceId))
          }
          break

        case 'registry:modules:sync':
          if (announced && !sent) {
            sent = true
            console.log(green('✓  模块已注册，发送消息...'))

            // 直接发送 input:text 事件
            const sessionId = `direct-${opts.platform}-${opts.channelId}`
            const senderName = opts.sender.name ?? 'Direct'
            ws.send(buildEvent('input:text', {
              text: opts.text,
              textRaw: opts.text,
              overrides: {
                sessionId,
                messagePrefix: `(From ${senderName} via direct/${opts.platform}): `,
              },
              contextUpdates: [{
                strategy: 'append-self',
                text: `Message from direct mode, platform: ${opts.platform}`,
                metadata: { direct: { platform: opts.platform, sender: opts.sender } },
              }],
            }, instanceId))

            console.log(`   等待回复中 (超时: ${opts.timeoutMs / 1000}s)...\n`)
          }
          break

        case 'output:gen-ai:chat:message':
        case 'output:gen-ai:chat:complete': {
          clearTimeout(timeout)
          const content = msg.data?.message?.content ?? '(无内容)'
          const label = msg.type.includes('complete') ? '完整回复' : '流式分块'
          console.log(bold(`🗨️  AIRI 回复 (${label}):`))
          console.log(green(`   ${content}`))
          console.log()
          ws.close()
          resolve()
          break
        }
      }
    })

    ws.addEventListener('open', () => {
      if (opts.token) {
        ws.send(buildEvent('module:authenticate', { token: opts.token }, instanceId))
      }
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      console.error(red('✗  WebSocket 连接失败'))
      reject(new Error('WebSocket error'))
    })
  })
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2))

if (opts.help) {
  console.log(`
simulate.mjs — 测试 AIRI Webhook 通信

使用方法:
  node scripts/simulate.mjs [选项]

模式:
  (默认)    Webhook 模式 — POST 到 webhook adapter，通过 WS 监听回复
  --direct  Direct 模式 — 直连事件中枢发送 input:text

选项:
  --text <msg>           消息内容 (默认: 中文问候)
  --sender-name <name>   发送者名称 (默认: 测试用户)
  --platform <name>      平台标签 (默认: test)
  --channel <id>         频道 ID (默认: test-channel-001)
  --webhook-url <url>    Webhook URL (默认: http://localhost:6122/webhook)
  --ws-url <url>         事件中枢 WS URL (默认: ws://localhost:6121)
  --token <token>        认证 token
  --timeout <seconds>    超时时间 (默认: 30)
  --help, -h             显示帮助
`)
  process.exit(0)
}

try {
  if (opts.direct) {
    await runDirectMode(opts)
  }
  else {
    await runWebhookMode(opts)
  }
  console.log(green('✓  测试完成\n'))
  process.exit(0)
}
catch (err) {
  console.error(red(`\n✗  测试失败: ${err.message}\n`))
  process.exit(1)
}
