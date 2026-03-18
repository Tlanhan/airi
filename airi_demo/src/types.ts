/**
 * @file types.ts
 *
 * AIRI 人偶通信协议的核心类型定义。
 *
 * 这是整个 webhook 通信系统的类型基础，定义了：
 * - 事件信封格式（所有消息的统一包装）
 * - 输入事件（外部平台 → AIRI）
 * - 输出事件（AIRI → 外部平台）
 * - 模块注册协议（peer 身份声明）
 * - 上下文注入策略（给 LLM 提供平台元数据）
 *
 * 从原项目 packages/plugin-protocol/src/types/events.ts 提炼而来。
 */

// ---------------------------------------------------------------------------
// 事件信封 — 所有 WebSocket 消息的统一包装
// ---------------------------------------------------------------------------

/** 模块身份标识 */
export interface ModuleIdentity {
  kind: 'plugin' | 'stage' | 'service'
  plugin?: { id: string }
  id: string
}

/** 事件元数据 */
export interface EventMetadata {
  source?: ModuleIdentity
  event?: {
    id?: string
    parentId?: string
  }
}

/** WebSocket 事件信封 — 所有通信都通过这个格式 */
export interface WebSocketEvent<T extends string = string, D = unknown> {
  type: T
  data: D
  metadata?: EventMetadata
}

// ---------------------------------------------------------------------------
// 上下文注入 — 告诉 LLM 消息来自哪个平台
// ---------------------------------------------------------------------------

export enum ContextUpdateStrategy {
  /** 替换该来源之前的所有上下文 */
  ReplaceSelf = 'replace-self',
  /** 追加到该来源的上下文列表 */
  AppendSelf = 'append-self',
}

export interface ContextUpdate {
  strategy: ContextUpdateStrategy
  text: string
  content?: string
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 输入事件 — 外部平台消息 → AIRI
// ---------------------------------------------------------------------------

/** 输入消息的会话控制覆写 */
export interface InputOverrides {
  /** 会话隔离 ID — 不同 platform+channel 的消息不会混在一起 */
  sessionId?: string
  /** 注入到 LLM prompt 前的消息前缀，让 LLM 知道谁在说话 */
  messagePrefix?: string
}

/** input:text 事件的 data 部分 */
export interface InputTextData {
  /** 消息正文（必填） */
  text: string
  /** 原始未处理的消息文本（可选） */
  textRaw?: string
  /** 会话控制 */
  overrides?: InputOverrides
  /** 上下文注入（告诉 LLM 消息来自哪个平台） */
  contextUpdates?: ContextUpdate[]
  /** 平台特定元数据（键名自定义，如 'openclaw', 'discord', 'wechat'） */
  [platformKey: string]: unknown
}

// ---------------------------------------------------------------------------
// 输出事件 — AIRI 回复 → 外部平台
// ---------------------------------------------------------------------------

/** LLM 回复消息结构 */
export interface AssistantMessage {
  role: 'assistant'
  content: string
}

/**
 * output:gen-ai:chat:message 的 data
 * 流式分块 — 每次 LLM 生成一小段就发一次（非流式模型可能不触发）
 */
export interface OutputChatMessageData {
  'message'?: AssistantMessage
  /** 原始输入的完整信息，用于路由回复 */
  'gen-ai:chat'?: {
    input?: {
      data?: Record<string, unknown>
    }
  }
}

/**
 * output:gen-ai:chat:complete 的 data
 * 完整回复 — LLM 一轮对话结束后发出（始终触发）
 */
export interface OutputChatCompleteData {
  'message'?: AssistantMessage
  /** 原始输入的完整信息，用于路由回复 */
  'gen-ai:chat'?: {
    input?: {
      data?: Record<string, unknown>
    }
  }
}

// ---------------------------------------------------------------------------
// 模块注册协议 — peer 连接后向 hub 声明自己的身份和能力
// ---------------------------------------------------------------------------

export interface ModuleAnnounceData {
  name: string
  possibleEvents: string[]
  identity?: ModuleIdentity
}

export interface ModuleAuthenticatedData {
  authenticated: boolean
}

// ---------------------------------------------------------------------------
// 工具函数 — 构建标准化的事件信封
// ---------------------------------------------------------------------------

let eventCounter = 0

/** 生成唯一事件 ID */
export function createEventId(): string {
  return `${Date.now().toString(36)}-${(eventCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 构建带完整元数据的事件信封 */
export function buildEvent<T extends string, D>(
  type: T,
  data: D,
  source?: ModuleIdentity,
): WebSocketEvent<T, D> {
  return {
    type,
    data,
    metadata: {
      source,
      event: { id: createEventId() },
    },
  }
}

// ---------------------------------------------------------------------------
// 输入事件构造器 — 将外部平台消息转为标准 input:text
// ---------------------------------------------------------------------------

export interface BuildInputTextParams {
  /** 消息正文 */
  text: string
  /** 发送者信息 */
  sender?: { id?: string, name?: string }
  /** 来源服务名称（如 'openclaw', 'discord', 'wechat'） */
  service: string
  /** 来源平台（如 'whatsapp', 'signal', 'qq'） */
  platform?: string
  /** 频道/聊天 ID */
  channelId?: string
  /** 额外的平台元数据 */
  metadata?: Record<string, unknown>
}

/**
 * 将外部平台消息转为标准的 input:text 事件 data。
 *
 * 这是最核心的转换函数 — 任何平台接入只需调用此函数。
 *
 * @example
 * ```ts
 * // OpenClaw 接入
 * const data = buildInputTextData({
 *   text: 'Hello!',
 *   sender: { name: 'Alice' },
 *   service: 'openclaw',
 *   platform: 'whatsapp',
 *   channelId: 'chat_123',
 * })
 *
 * // 微信公众号接入
 * const data = buildInputTextData({
 *   text: '你好',
 *   sender: { id: 'openid_xxx', name: '张三' },
 *   service: 'wechat',
 *   platform: 'wechat-mp',
 *   channelId: 'gh_xxx',
 * })
 * ```
 */
export function buildInputTextData(params: BuildInputTextParams): InputTextData {
  const {
    text,
    sender,
    service,
    platform = service,
    channelId = 'default',
    metadata,
  } = params

  const senderName = sender?.name ?? sender?.id ?? service

  // 会话隔离：每个 service-platform-channel 组合有独立的对话上下文
  const sessionId = `${service}-${platform}-${channelId}`

  // 消息前缀：让 LLM 知道谁在通过什么平台说话
  const messagePrefix = `(From ${senderName} via ${service}/${platform}): `

  // 上下文注入：给 LLM 补充结构化的平台来源信息
  const contextHint = `This message was received through ${service} on platform '${platform}', channel '${channelId}'.`

  return {
    text,
    textRaw: text,
    overrides: {
      sessionId,
      messagePrefix,
    },
    contextUpdates: [{
      strategy: ContextUpdateStrategy.AppendSelf,
      text: contextHint,
      content: contextHint,
      metadata: {
        [service]: {
          platform,
          channelId,
          sender,
          ...metadata,
        },
      },
    }],
    // 平台特定元数据挂在顶层，方便回复路由时取出
    [service]: {
      platform,
      channelId,
      sender,
      ...metadata,
    },
  }
}
