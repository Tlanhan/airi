import type { IncomingMessage, ServerResponse } from 'node:http'

import { createServer } from 'node:http'
import { env } from 'node:process'

import { useLogg } from '@guiiai/logg'
import { ContextUpdateStrategy, Client as ServerChannel } from '@proj-airi/server-sdk'

const log = useLogg('OpenClawAdapter').useGlobalConfig()

export interface OpenClawAdapterConfig {
  /** Port to listen on for incoming OpenClaw webhooks. Default: 6122 */
  webhookPort?: number
  airiToken?: string
  airiUrl?: string
}

/**
 * Shape of the webhook payload that OpenClaw POSTs to this service.
 *
 * To configure OpenClaw to forward messages here, add a skill/webhook in
 * your OpenClaw workspace that POSTs to:
 *   http://localhost:<OPENCLAW_WEBHOOK_PORT>/webhook
 *
 * Body example:
 * ```json
 * {
 *   "text": "Hello from WhatsApp!",
 *   "sender": { "id": "user123", "name": "Alice" },
 *   "platform": "whatsapp",
 *   "channelId": "chat456"
 * }
 * ```
 */
export interface OpenClawWebhookPayload {
  /** The plain-text message content. Required. */
  text: string
  /** The sender's identity (optional, provided by OpenClaw). */
  sender?: {
    id?: string
    name?: string
  }
  /** The messaging platform the message originated from (e.g. "whatsapp", "signal"). */
  platform?: string
  /** The channel or chat identifier within the platform. */
  channelId?: string
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

export class OpenClawAdapter {
  private readonly airiClient: ServerChannel
  private readonly webhookPort: number
  private readonly httpServer: ReturnType<typeof createServer>

  constructor(config: OpenClawAdapterConfig) {
    this.webhookPort = config.webhookPort ?? Number.parseInt(env.OPENCLAW_WEBHOOK_PORT ?? '6122')

    // Connect to AIRI server as an 'openclaw' module
    this.airiClient = new ServerChannel({
      name: 'openclaw',
      possibleEvents: [
        'input:text',
        'output:gen-ai:chat:message',
      ],
      token: config.airiToken ?? env.AIRI_TOKEN,
      url: config.airiUrl ?? env.AIRI_URL ?? 'ws://localhost:6121/ws',
    })

    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((error: unknown) => {
        log.withError(error as Error).error('Unhandled error in request handler')
        if (!res.headersSent)
          res.writeHead(500).end(JSON.stringify({ error: 'Internal Server Error' }))
      })
    })

    this.setupAiriEventHandlers()
  }

  private setupAiriEventHandlers(): void {
    // Log AIRI responses (the avatar already shows them as chat bubbles)
    this.airiClient.onEvent('output:gen-ai:chat:message', (event) => {
      const message = (event.data as { message?: { content?: string } }).message
      if (message?.content)
        log.log('AIRI avatar response:', message.content.slice(0, 120))
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Health-check endpoint
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not Found' }))
      return
    }

    const rawBody = await readBody(req)
    // Strip UTF-8 BOM that some HTTP clients (e.g. certain Windows tools) prepend,
    // then trim surrounding whitespace so JSON.parse doesn't choke on stray newlines.
    const body = rawBody.replace(/^\uFEFF/, '').trim()

    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Empty request body' }))
      return
    }

    let payload: OpenClawWebhookPayload
    try {
      payload = JSON.parse(body) as OpenClawWebhookPayload
    }
    catch (err) {
      // Log a short prefix of the body to aid debugging without leaking sensitive payload data.
      log.withError(err as Error).error(`Failed to parse JSON body (first 80 chars): ${body.slice(0, 80)}`)
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    if (!payload.text || typeof payload.text !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Missing required field: text' }))
      return
    }

    const senderName = payload.sender?.name ?? payload.sender?.id ?? 'OpenClaw'
    const platform = payload.platform ?? 'openclaw'
    const channelId = payload.channelId ?? 'default'

    log.log(`Incoming message from ${senderName} via OpenClaw/${platform} (channel: ${channelId}): ${payload.text}`)

    // Context note injected into the AIRI conversation so the LLM knows the origin
    const notice = `This message was received through OpenClaw on platform '${platform}', channel '${channelId}'.`

    this.airiClient.send({
      type: 'input:text',
      data: {
        text: payload.text,
        textRaw: payload.text,
        overrides: {
          // Group messages by platform+channel so each chat has an isolated session
          sessionId: `openclaw-${platform}-${channelId}`,
          messagePrefix: `(From ${senderName} via OpenClaw/${platform}): `,
        },
        openclaw: {
          platform,
          channelId,
          sender: payload.sender,
        },
        contextUpdates: [{
          strategy: ContextUpdateStrategy.AppendSelf,
          text: notice,
          content: notice,
          metadata: {
            openclaw: {
              platform,
              channelId,
              sender: payload.sender,
            },
          },
        }],
      },
    })

    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.httpServer.listen(this.webhookPort, '0.0.0.0', () => {
        log.log(`OpenClaw webhook server listening on http://0.0.0.0:${this.webhookPort}`)
        log.log(`  → Webhook endpoint : POST http://localhost:${this.webhookPort}/webhook`)
        log.log(`  → Health check     : GET  http://localhost:${this.webhookPort}/health`)
        log.log(`Configure OpenClaw to POST to the webhook endpoint for messages to appear as avatar popups.`)
        resolve()
      })
    })
  }

  stop(): void {
    this.httpServer.close()
    this.airiClient.close()
    log.log('OpenClaw adapter stopped')
  }
}
