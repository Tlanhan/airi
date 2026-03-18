/**
 * @file webhook-adapter.ts
 *
 * 通用 Webhook 适配器（简化版 openclaw adapter）。
 *
 * 职责：
 * 1. 启动 HTTP 服务器，接收外部 webhook POST 请求
 * 2. 通过 transform 函数将 webhook body 转为标准 input:text 事件
 * 3. 通过 SDK client 将事件发送到事件中枢
 * 4. 监听 AIRI 的回复事件，通过 onReply 回调通知调用者
 *
 * 这是迁移到任意 webhook 平台的核心文件。
 *
 * 从原项目 services/openclaw/src/adapters/airi-adapter.ts 提炼而来。
 *
 * @example
 * ```ts
 * // OpenClaw 接入（3 行核心代码）
 * const adapter = createWebhookAdapter({
 *   name: 'openclaw',
 *   webhookPort: 6122,
 *   transform: (body) => ({
 *     text: body.text,
 *     sender: body.sender,
 *     service: 'openclaw',
 *     platform: body.platform ?? 'openclaw',
 *     channelId: body.channelId,
 *   }),
 * })
 *
 * // 微信公众号接入
 * const adapter = createWebhookAdapter({
 *   name: 'wechat',
 *   webhookPort: 6200,
 *   transform: (body) => ({
 *     text: body.Content,
 *     sender: { id: body.FromUserName, name: body.FromUserName },
 *     service: 'wechat',
 *     platform: 'wechat-mp',
 *     channelId: body.ToUserName,
 *   }),
 *   onReply: (response, inputMeta) => {
 *     // 通过微信客服消息 API 回复
 *   },
 * })
 * ```
 */

/* eslint-disable no-console */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AiriClient } from './client.js'
import type { BuildInputTextParams, OutputChatCompleteData, OutputChatMessageData } from './types.js'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

import { createAiriClient } from './client.js'
import { buildInputTextData } from './types.js'

// ---------------------------------------------------------------------------
// 适配器配置
// ---------------------------------------------------------------------------

/** Webhook body → 标准输入参数的转换函数 */
export type WebhookTransform = (body: any) => BuildInputTextParams | null

/** AIRI 回复回调 */
export interface AiriReply {
  /** AIRI 的回复文本 */
  content: string
  /** 是否是流式分块（true = streaming chunk, false = 完整回复） */
  isStreaming: boolean
  /** 原始输入携带的平台元数据，可用于路由回复到正确的频道 */
  inputMetadata?: Record<string, unknown>
}

export interface WebhookAdapterConfig {
  /** 模块名称 */
  name: string
  /** HTTP webhook 监听端口，默认 6122 */
  webhookPort?: number
  /** Webhook 接收路径，默认 '/webhook' */
  webhookPath?: string
  /** 事件中枢 URL，默认 ws://localhost:6121 */
  hubUrl?: string
  /** 认证 token */
  hubToken?: string
  /** 将 webhook body 转为标准输入参数 */
  transform: WebhookTransform
  /** 收到 AIRI 回复时的回调（可选，用于将回复发回原平台） */
  onReply?: (reply: AiriReply) => void | Promise<void>
}

export interface WebhookAdapter {
  start: () => Promise<void>
  stop: () => void
  /** 内部的 SDK 客户端，可直接使用 */
  readonly client: AiriClient
}

// ---------------------------------------------------------------------------
// 创建 Webhook 适配器
// ---------------------------------------------------------------------------

export function createWebhookAdapter(config: WebhookAdapterConfig): WebhookAdapter {
  const {
    name,
    webhookPort = 6122,
    webhookPath = '/webhook',
    hubUrl = 'ws://localhost:6121',
    hubToken,
    transform,
    onReply,
  } = config

  // 创建 SDK 客户端，声明关注的事件
  const client = createAiriClient({
    name,
    url: hubUrl,
    token: hubToken,
    possibleEvents: [
      'input:text',
      'output:gen-ai:chat:message',
      'output:gen-ai:chat:complete',
    ],
  })

  // ------ 监听 AIRI 回复 ------

  // 流式分块
  client.onEvent('output:gen-ai:chat:message', (event) => {
    const data = event.data as OutputChatMessageData
    const content = data.message?.content
    if (content) {
      console.log(`[${name}] AIRI streaming chunk: ${content.slice(0, 80)}...`)
      onReply?.({
        content,
        isStreaming: true,
        inputMetadata: data['gen-ai:chat']?.input?.data,
      })
    }
  })

  // 完整回复（始终触发）
  client.onEvent('output:gen-ai:chat:complete', (event) => {
    const data = event.data as OutputChatCompleteData
    const content = data.message?.content
    if (content) {
      console.log(`[${name}] AIRI complete reply: ${content.slice(0, 120)}`)
      onReply?.({
        content,
        isStreaming: false,
        inputMetadata: data['gen-ai:chat']?.input?.data,
      })
    }
  })

  // ------ HTTP 服务器 ------

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(`[${name}] unhandled error:`, err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
      }
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 健康检查
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, module: name, connected: client.connected }))
      return
    }

    // Webhook 端点
    if (req.method === 'POST' && req.url === webhookPath) {
      await handleWebhook(req, res)
      return
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found' }))
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 读取 request body
    const rawBody = await readBody(req)
    const body = rawBody.replace(/^\uFEFF/, '').trim() // 去除 BOM

    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Empty request body' }))
      return
    }

    // 解析 JSON
    let payload: unknown
    try {
      payload = JSON.parse(body)
    }
    catch {
      console.error(`[${name}] invalid JSON: ${body.slice(0, 80)}`)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    // 通过 transform 转为标准输入参数
    const params = transform(payload)
    if (!params || !params.text) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Transform returned null or missing text field' }))
      return
    }

    console.log(`[${name}] incoming: ${params.text.slice(0, 80)} (from ${params.sender?.name ?? 'unknown'})`)

    // 构建标准 input:text 事件并发送到事件中枢
    const inputData = buildInputTextData(params)
    client.send('input:text', inputData)

    // 立即返回 HTTP 200（AIRI 的回复通过 WebSocket 异步返回）
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  // ------ 工具函数 ------

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      req.on('error', reject)
    })
  }

  // ------ 公开 API ------

  return {
    async start(): Promise<void> {
      // 1. 先连接事件中枢
      await client.connect()

      // 2. 再启动 HTTP webhook 服务器
      return new Promise((resolve) => {
        httpServer.listen(webhookPort, '0.0.0.0', () => {
          console.log(`[${name}] Webhook server listening on http://0.0.0.0:${webhookPort}`)
          console.log(`[${name}]   POST ${webhookPath} — receive webhook`)
          console.log(`[${name}]   GET  /health       — health check`)
          resolve()
        })
      })
    },

    stop(): void {
      httpServer.close()
      client.close()
      console.log(`[${name}] adapter stopped`)
    },

    get client() { return client },
  }
}

// ---------------------------------------------------------------------------
// 内置 transform 函数 — 开箱即用的平台支持
// ---------------------------------------------------------------------------

/**
 * OpenClaw webhook body → 标准输入参数
 *
 * OpenClaw POST body 格式：
 * { text: string, sender?: { id, name }, platform?: string, channelId?: string }
 */
export const openClawTransform: WebhookTransform = (body) => {
  if (!body || typeof body.text !== 'string')
    return null
  return {
    text: body.text,
    sender: body.sender,
    service: 'openclaw',
    platform: body.platform ?? 'openclaw',
    channelId: body.channelId ?? 'default',
  }
}

/**
 * 通用简单 webhook body → 标准输入参数
 *
 * 适用于最简单的 { message: string } 格式
 */
export const simpleTransform: WebhookTransform = (body) => {
  const text = body?.text ?? body?.message ?? body?.content
  if (!text || typeof text !== 'string')
    return null
  return {
    text,
    sender: { name: body?.sender ?? body?.from ?? body?.user ?? 'anonymous' },
    service: 'webhook',
    platform: body?.platform ?? 'generic',
    channelId: body?.channel ?? body?.channelId ?? 'default',
  }
}

// ---------------------------------------------------------------------------
// 独立运行入口 — 可单独用 `tsx src/webhook-adapter.ts` 启动
// ---------------------------------------------------------------------------

const isMain = process.argv[1]?.endsWith('webhook-adapter.ts')
  || process.argv[1]?.endsWith('webhook-adapter.js')

if (isMain) {
  const adapter = createWebhookAdapter({
    name: process.env.MODULE_NAME ?? 'openclaw',
    webhookPort: Number(process.env.WEBHOOK_PORT ?? 6122),
    hubUrl: process.env.HUB_URL ?? 'ws://localhost:6121',
    hubToken: process.env.AUTH_TOKEN,
    transform: openClawTransform,
    onReply: (reply) => {
      console.log(`\n💬 AIRI says: ${reply.content}\n`)
    },
  })

  adapter.start().catch((err) => {
    console.error('Failed to start webhook adapter:', err)
    process.exit(1)
  })

  process.on('SIGINT', () => {
    adapter.stop()
    process.exit(0)
  })
}
