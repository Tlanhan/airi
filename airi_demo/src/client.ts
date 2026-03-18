/**
 * @file client.ts
 *
 * WebSocket 客户端 SDK（简化版 server-sdk）。
 *
 * 职责：
 * 1. 连接到事件路由中枢（server.ts）
 * 2. 自动认证 + 模块声明
 * 3. 发送/接收类型化事件
 * 4. 自动重连（指数退避）
 * 5. 心跳保活
 *
 * 从原项目 packages/server-sdk/src/client.ts 提炼而来。
 *
 * @example
 * ```ts
 * const client = createAiriClient({
 *   name: 'my-service',
 *   url: 'ws://localhost:6121',
 *   possibleEvents: ['input:text', 'output:gen-ai:chat:complete'],
 * })
 *
 * client.onEvent('output:gen-ai:chat:complete', (event) => {
 *   console.log('AIRI replied:', event.data.message?.content)
 * })
 *
 * await client.connect()
 *
 * client.send('input:text', { text: 'Hello!' })
 * ```
 */

/* eslint-disable no-console */

import type { ModuleIdentity, WebSocketEvent } from './types.js'

import WebSocket from 'ws'

import { buildEvent } from './types.js'

// ---------------------------------------------------------------------------
// 客户端配置
// ---------------------------------------------------------------------------

export interface AiriClientConfig {
  /** 模块名称（如 'openclaw', 'discord', 'my-webhook'） */
  name: string
  /** 事件中枢 WebSocket URL，默认 ws://localhost:6121 */
  url?: string
  /** 认证 token（需和 server 端一致） */
  token?: string
  /** 声明本模块感兴趣的事件类型列表 */
  possibleEvents?: string[]
  /** 自动重连，默认 true */
  autoReconnect?: boolean
  /** 最大重连次数，-1 为无限重连，默认 -1 */
  maxReconnectAttempts?: number
  /** 心跳间隔(ms)，默认 25000 */
  heartbeatIntervalMs?: number
}

export interface AiriClient {
  /** 连接到事件中枢 */
  connect: () => Promise<void>
  /** 发送事件 */
  send: (type: string, data: unknown) => void
  /** 监听特定类型的事件 */
  onEvent: (type: string, handler: (event: WebSocketEvent) => void | Promise<void>) => void
  /** 移除事件监听 */
  offEvent: (type: string, handler: (event: WebSocketEvent) => void | Promise<void>) => void
  /** 监听所有事件（调试用） */
  onAnyEvent: (handler: (event: WebSocketEvent) => void) => void
  /** 关闭连接 */
  close: () => void
  /** 是否已连接 */
  readonly connected: boolean
}

// ---------------------------------------------------------------------------
// 创建客户端
// ---------------------------------------------------------------------------

export function createAiriClient(config: AiriClientConfig): AiriClient {
  const {
    name,
    url = 'ws://localhost:6121',
    token,
    possibleEvents = [],
    autoReconnect = true,
    maxReconnectAttempts = -1,
    heartbeatIntervalMs = 25_000,
  } = config

  let ws: WebSocket | null = null
  let isConnected = false
  let reconnectAttempts = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let intentionalClose = false

  // 事件监听器
  const listeners = new Map<string, Set<(event: WebSocketEvent) => void | Promise<void>>>()
  let anyEventHandler: ((event: WebSocketEvent) => void) | undefined

  // 模块身份
  const identity: ModuleIdentity = {
    kind: 'plugin',
    plugin: { id: name },
    id: `${name}-${Date.now().toString(36)}`,
  }

  // ------ 连接管理 ------

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      intentionalClose = false

      try {
        ws = new WebSocket(url)
      }
      catch (err) {
        reject(err)
        return
      }

      ws.on('open', () => {
        console.log(`[client:${name}] connected to ${url}`)
        reconnectAttempts = 0

        // 如果有 token，发送认证请求
        if (token) {
          sendRaw(buildEvent('module:authenticate', { token }, identity))
        }
        // 否则等 server 自动认证后的 module:authenticated 事件
      })

      ws.on('message', (raw) => {
        try {
          const event = parseMessage(raw.toString('utf-8'))
          if (!event)
            return

          // 通知调试监听器
          anyEventHandler?.(event)

          handleEvent(event, resolve)
        }
        catch (err) {
          console.error(`[client:${name}] message parse error:`, err)
        }
      })

      ws.on('close', () => {
        isConnected = false
        stopHeartbeat()
        console.log(`[client:${name}] disconnected`)

        if (!intentionalClose && autoReconnect) {
          scheduleReconnect()
        }
      })

      ws.on('error', (err) => {
        console.error(`[client:${name}] error:`, err.message)
        // 如果还没 resolve（首次连接失败），reject
        if (!isConnected) {
          reject(err)
        }
      })
    })
  }

  function handleEvent(event: WebSocketEvent, onFirstConnect?: (value: void) => void): void {
    switch (event.type) {
      case 'module:authenticated': {
        isConnected = true
        console.log(`[client:${name}] authenticated`)

        // 认证成功后，声明模块身份和感兴趣的事件
        sendRaw(buildEvent('module:announce', {
          name,
          possibleEvents,
          identity,
        }, identity))

        startHeartbeat()
        break
      }

      case 'registry:modules:sync': {
        // 模块列表同步完成 → 首次连接流程结束
        onFirstConnect?.()
        break
      }

      case 'heartbeat:pong': {
        // 心跳回复，无需处理
        break
      }

      default: {
        // 分发给已注册的事件监听器
        const handlers = listeners.get(event.type)
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(event)
            }
            catch (err) {
              console.error(`[client:${name}] event handler error for ${event.type}:`, err)
            }
          }
        }
        break
      }
    }
  }

  // ------ 重连 ------

  function scheduleReconnect(): void {
    if (maxReconnectAttempts !== -1 && reconnectAttempts >= maxReconnectAttempts) {
      console.error(`[client:${name}] max reconnect attempts (${maxReconnectAttempts}) reached`)
      return
    }

    // 指数退避：1s → 2s → 4s → 8s → ... → 30s（封顶）
    const delay = Math.min(2 ** reconnectAttempts * 1000, 30_000)
    reconnectAttempts++
    console.log(`[client:${name}] reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`)

    setTimeout(() => {
      connect().catch((err) => {
        console.error(`[client:${name}] reconnect failed:`, err.message)
      })
    }, delay)
  }

  // ------ 心跳 ------

  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (ws && isConnected) {
        sendRaw(buildEvent('heartbeat:ping', {}, identity))
      }
    }, heartbeatIntervalMs)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  // ------ 发送 ------

  function sendRaw(event: WebSocketEvent): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event))
    }
  }

  function send(type: string, data: unknown): void {
    sendRaw(buildEvent(type, data, identity))
  }

  // ------ 事件监听 ------

  function onEvent(type: string, handler: (event: WebSocketEvent) => void | Promise<void>): void {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(handler)
  }

  function offEvent(type: string, handler: (event: WebSocketEvent) => void | Promise<void>): void {
    listeners.get(type)?.delete(handler)
  }

  // ------ 工具函数 ------

  function parseMessage(text: string): WebSocketEvent | null {
    try {
      const obj = JSON.parse(text)
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
    connect,
    send,
    onEvent,
    offEvent,
    onAnyEvent(handler) { anyEventHandler = handler },
    close() {
      intentionalClose = true
      stopHeartbeat()
      ws?.close()
      isConnected = false
    },
    get connected() { return isConnected },
  }
}
