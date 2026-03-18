/**
 * @file server.ts
 *
 * 事件路由中枢（简化版 server-runtime）。
 *
 * 职责：
 * 1. 在指定端口启动 WebSocket 服务器
 * 2. 管理所有连接的模块（peer）
 * 3. 当一个 peer 发送事件时，路由给其他所有已注册的 peer
 *
 * 从原项目 packages/server-runtime/src/index.ts 提炼而来。
 * 原实现使用 crossws + h3，这里简化为纯 ws 库实现。
 *
 * 架构：
 *   peer A (webhook adapter) ──→ server (this) ──→ peer B (stage-web / LLM)
 *   peer B (stage-web / LLM) ──→ server (this) ──→ peer A (webhook adapter)
 *
 * @example
 * ```ts
 * const server = createEventHub({ port: 6121 })
 * server.start()
 * ```
 */

/* eslint-disable no-console */

import type { WebSocket } from 'ws'

import type { ModuleAnnounceData, ModuleIdentity, WebSocketEvent } from './types.js'

import process from 'node:process'

import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

import { createEventId } from './types.js'

// ---------------------------------------------------------------------------
// Peer 管理
// ---------------------------------------------------------------------------

interface Peer {
  id: string
  ws: WebSocket
  name?: string
  authenticated: boolean
  possibleEvents: string[]
  identity?: ModuleIdentity
  lastHeartbeatAt: number
}

// ---------------------------------------------------------------------------
// 服务器配置
// ---------------------------------------------------------------------------

export interface EventHubConfig {
  /** WebSocket 监听端口，默认 6121 */
  port?: number
  /** 认证 token，为空则跳过认证 */
  authToken?: string
  /** 心跳检测间隔(ms)，默认 30000 */
  heartbeatIntervalMs?: number
}

export interface EventHub {
  start: () => Promise<void>
  stop: () => void
  /** 当前连接的 peer 数量 */
  peerCount: () => number
}

// ---------------------------------------------------------------------------
// 创建事件路由中枢
// ---------------------------------------------------------------------------

export function createEventHub(config: EventHubConfig = {}): EventHub {
  const {
    port = 6121,
    authToken,
    heartbeatIntervalMs = 30_000,
  } = config

  const peers = new Map<string, Peer>()
  let peerIdCounter = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  const httpServer = createServer((_req, res) => {
    // 简易健康检查
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, peers: peers.size }))
  })

  const wss = new WebSocketServer({ server: httpServer })

  // ------ WebSocket 连接处理 ------

  wss.on('connection', (ws) => {
    const peerId = `peer-${++peerIdCounter}`
    const peer: Peer = {
      id: peerId,
      ws,
      authenticated: !authToken, // 无 token 时自动认证
      possibleEvents: [],
      lastHeartbeatAt: Date.now(),
    }
    peers.set(peerId, peer)

    console.log(`[server] peer connected: ${peerId} (total: ${peers.size})`)

    // 无需认证时，直接通知已认证
    if (!authToken) {
      sendToPeer(peer, {
        type: 'module:authenticated',
        data: { authenticated: true },
        metadata: { source: serverIdentity(), event: { id: createEventId() } },
      })
    }

    ws.on('message', (raw) => {
      try {
        const text = raw.toString('utf-8')
        const event = parseMessage(text)
        if (!event)
          return

        peer.lastHeartbeatAt = Date.now()
        handleEvent(peer, event)
      }
      catch (err) {
        console.error(`[server] error handling message from ${peerId}:`, err)
      }
    })

    ws.on('close', () => {
      peers.delete(peerId)
      console.log(`[server] peer disconnected: ${peerId}/${peer.name ?? '?'} (total: ${peers.size})`)
      broadcastModulesSync()
    })

    ws.on('error', (err) => {
      console.error(`[server] peer ${peerId} error:`, err.message)
    })
  })

  // ------ 事件处理 ------

  function handleEvent(from: Peer, event: WebSocketEvent): void {
    switch (event.type) {
      // 认证请求
      case 'module:authenticate': {
        const token = (event.data as { token?: string })?.token
        if (authToken && token !== authToken) {
          sendToPeer(from, {
            type: 'error',
            data: { message: 'Authentication failed' },
            metadata: { source: serverIdentity(), event: { id: createEventId() } },
          })
          from.ws.close()
          return
        }
        from.authenticated = true
        sendToPeer(from, {
          type: 'module:authenticated',
          data: { authenticated: true },
          metadata: { source: serverIdentity(), event: { id: createEventId() } },
        })
        break
      }

      // 模块声明（注册身份和感兴趣的事件类型）
      case 'module:announce': {
        const data = event.data as ModuleAnnounceData
        from.name = data.name
        from.possibleEvents = data.possibleEvents ?? []
        from.identity = data.identity

        console.log(`[server] module announced: ${data.name} (events: ${from.possibleEvents.join(', ')})`)

        // 通知所有 peer 当前的模块列表
        broadcastModulesSync()
        break
      }

      // 心跳
      case 'heartbeat:ping': {
        sendToPeer(from, {
          type: 'heartbeat:pong',
          data: {},
          metadata: { source: serverIdentity(), event: { id: createEventId() } },
        })
        break
      }

      // 其他所有事件 → 路由给目标 peer
      default: {
        if (!from.authenticated) {
          sendToPeer(from, {
            type: 'error',
            data: { message: 'Not authenticated' },
            metadata: { source: serverIdentity(), event: { id: createEventId() } },
          })
          return
        }

        routeEvent(from, event)
        break
      }
    }
  }

  /**
   * 事件路由核心逻辑：
   * 将事件转发给所有"声明过对该事件类型感兴趣"的 peer（排除发送者自身）。
   *
   * NOTICE: 原项目通过 possibleEvents 做精确的事件订阅匹配。
   * 如果 peer 的 possibleEvents 为空，则接收所有事件（兜底广播）。
   */
  function routeEvent(from: Peer, event: WebSocketEvent): void {
    const payload = JSON.stringify(event)
    let delivered = 0

    for (const [id, peer] of peers) {
      if (id === from.id)
        continue
      if (!peer.authenticated)
        continue

      // 如果 peer 声明了 possibleEvents，只转发匹配的事件
      // 如果没声明（空数组），则广播所有事件
      const wantsEvent = peer.possibleEvents.length === 0
        || peer.possibleEvents.includes(event.type)

      if (wantsEvent) {
        try {
          peer.ws.send(payload)
          delivered++
        }
        catch {
          console.error(`[server] failed to send to peer ${id}/${peer.name}`)
        }
      }
    }

    console.log(`[server] routed ${event.type} from ${from.name ?? from.id} → ${delivered} peer(s)`)
  }

  /** 广播当前模块列表给所有已认证的 peer */
  function broadcastModulesSync(): void {
    const modules = Array.from(peers.values())
      .filter(p => p.authenticated && p.name)
      .map(p => ({ name: p.name, possibleEvents: p.possibleEvents, identity: p.identity }))

    const event: WebSocketEvent = {
      type: 'registry:modules:sync',
      data: { modules },
      metadata: { source: serverIdentity(), event: { id: createEventId() } },
    }

    const payload = JSON.stringify(event)
    for (const peer of peers.values()) {
      if (peer.authenticated) {
        try {
          peer.ws.send(payload)
        }
        catch { /* ignore */ }
      }
    }
  }

  // ------ 心跳检测 ------

  function startHeartbeatMonitor(): void {
    heartbeatTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, peer] of peers) {
        if (now - peer.lastHeartbeatAt > heartbeatIntervalMs * 3) {
          console.log(`[server] peer ${id}/${peer.name} heartbeat expired, removing`)
          peer.ws.close()
          peers.delete(id)
        }
      }
    }, heartbeatIntervalMs)
  }

  // ------ 工具函数 ------

  function sendToPeer(peer: Peer, event: WebSocketEvent): void {
    try {
      peer.ws.send(JSON.stringify(event))
    }
    catch (err) {
      console.error(`[server] failed to send to peer ${peer.id}:`, err)
    }
  }

  function serverIdentity(): ModuleIdentity {
    return { kind: 'service', id: 'event-hub' }
  }

  /**
   * 解析 WebSocket 消息。
   * 兼容两种格式：
   * - 纯 JSON: { type, data, metadata }
   * - superjson: { json: { type, data, metadata }, meta: ... }
   */
  function parseMessage(text: string): WebSocketEvent | null {
    try {
      const obj = JSON.parse(text)
      // superjson 格式
      if (obj && typeof obj === 'object' && 'json' in obj && typeof obj.json === 'object') {
        return obj.json as WebSocketEvent
      }
      return obj as WebSocketEvent
    }
    catch {
      return null
    }
  }

  // ------ 公开 API ------

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        httpServer.listen(port, '0.0.0.0', () => {
          console.log(`[server] Event hub listening on ws://0.0.0.0:${port}`)
          console.log(`[server] Health check: http://localhost:${port}/`)
          startHeartbeatMonitor()
          resolve()
        })
      })
    },

    stop(): void {
      if (heartbeatTimer)
        clearInterval(heartbeatTimer)
      for (const peer of peers.values()) {
        peer.ws.close()
      }
      wss.close()
      httpServer.close()
      console.log('[server] Event hub stopped')
    },

    peerCount(): number {
      return peers.size
    },
  }
}

// ---------------------------------------------------------------------------
// 独立运行入口 — 可单独用 `tsx src/server.ts` 启动
// ---------------------------------------------------------------------------

const isMain = process.argv[1]?.endsWith('server.ts')
  || process.argv[1]?.endsWith('server.js')

if (isMain) {
  const hub = createEventHub({
    port: Number(process.env.HUB_PORT ?? 6121),
    authToken: process.env.AUTH_TOKEN,
  })
  hub.start()

  process.on('SIGINT', () => {
    hub.stop()
    process.exit(0)
  })
}
