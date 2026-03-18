/**
 * @file index.ts
 *
 * 一键启动入口 — 同时启动所有三个组件进行端到端演示。
 *
 * 架构：
 *   curl POST /webhook
 *        │
 *        ▼
 *   Webhook Adapter (HTTP :6122)
 *        │  input:text (WebSocket)
 *        ▼
 *   Event Hub (WS :6121) ──→ Mock Stage (模拟 LLM)
 *        │                        │
 *        │  output:gen-ai:chat:complete
 *        ◄────────────────────────┘
 *        │
 *        ▼
 *   Webhook Adapter.onReply()
 *        │
 *        ▼
 *   在控制台打印回复（或回发到原平台）
 *
 * 启动后，用 curl 测试：
 *   curl -X POST http://localhost:6122/webhook \
 *     -H "Content-Type: application/json" \
 *     -d '{"text":"你好！","sender":{"name":"Alice"},"platform":"whatsapp"}'
 */

/* eslint-disable no-console */

import process from 'node:process'

import { createMockStage } from './mock-stage.js'
import { createEventHub } from './server.js'
import { createWebhookAdapter, openClawTransform } from './webhook-adapter.js'

async function main() {
  const hubPort = Number(process.env.HUB_PORT ?? 6121)
  const webhookPort = Number(process.env.WEBHOOK_PORT ?? 6122)
  const authToken = process.env.AUTH_TOKEN

  console.log('═══════════════════════════════════════════════════════════')
  console.log('  AIRI Webhook Demo — 人偶对话 Webhook 通信演示')
  console.log('═══════════════════════════════════════════════════════════\n')

  // 1. 启动事件路由中枢
  console.log('▶ Starting Event Hub...')
  const hub = createEventHub({ port: hubPort, authToken })
  await hub.start()

  // 2. 启动模拟 Stage（模拟 LLM 回复）
  console.log('\n▶ Starting Mock Stage (simulates LLM)...')
  const stage = createMockStage({
    hubUrl: `ws://localhost:${hubPort}`,
    hubToken: authToken,
    generateReply: (text, _sender) => {
      // 你可以替换为真实的 LLM API 调用
      return `[Demo Reply] 我收到了你的消息：「${text}」。这是一个模拟回复，在真实场景中这里会是 LLM 的输出。`
    },
  })
  await stage.connect()

  // 3. 启动 Webhook 适配器
  console.log('\n▶ Starting Webhook Adapter...')
  const adapter = createWebhookAdapter({
    name: 'openclaw',
    webhookPort,
    hubUrl: `ws://localhost:${hubPort}`,
    hubToken: authToken,
    transform: openClawTransform,
    onReply: (reply) => {
      console.log('\n╔══════════════════════════════════════════════════')
      console.log(`║ 💬 AIRI Reply (${reply.isStreaming ? 'streaming' : 'complete'}):`)
      console.log(`║ ${reply.content}`)
      console.log('╚══════════════════════════════════════════════════\n')

      // ★ 在这里添加将回复发回原平台的逻辑
      // 例如：调用微信客服消息 API、OpenClaw CLI、Telegram Bot API 等
      // const platformMeta = reply.inputMetadata?.openclaw
      // await sendBackToOpenClaw(platformMeta.channelId, reply.content)
    },
  })
  await adapter.start()

  // 打印测试指南
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  ✅ All components started! Test with:')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')
  console.log('  PowerShell:')
  console.log(`    curl.exe -X POST http://localhost:${webhookPort}/webhook \``)
  console.log('      -H "Content-Type: application/json" `')
  console.log('      -d \'{"text":"你好AIRI！","sender":{"name":"Alice"},"platform":"whatsapp"}\'')
  console.log('')
  console.log('  Or use the simulation script:')
  console.log('    node scripts/simulate.mjs')
  console.log('    node scripts/simulate.mjs --text "Hello AIRI"')
  console.log('    node scripts/simulate.mjs --direct --text "Direct mode"')
  console.log('')
  console.log('  Health checks:')
  console.log(`    curl http://localhost:${hubPort}/          # Event Hub`)
  console.log(`    curl http://localhost:${webhookPort}/health  # Webhook Adapter`)
  console.log('')
  console.log('  Press Ctrl+C to stop.\n')

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...')
    adapter.stop()
    stage.close()
    hub.stop()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
