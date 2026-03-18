/**
 * @file mock-stage.ts
 *
 * 模拟 stage-web / LLM 端 — 接收 input:text 并生成回复。
 *
 * 在真实 AIRI 项目中，这个角色由 stage-web (浏览器) 承担：
 * 它监听 input:text 事件，调用 LLM 生成回复，然后发出 output:gen-ai:chat:complete。
 *
 * 在 demo 中，这个模块用简单的 echo 或模板回复来模拟 LLM 的行为，
 * 让你可以端到端测试整个 webhook 通信链路，而不需要真正的 LLM。
 *
 * @example
 * ```ts
 * const stage = createMockStage({ hubUrl: 'ws://localhost:6121' })
 * await stage.connect()
 * // 现在发送 webhook → mock-stage 会自动回复
 * ```
 */

/* eslint-disable no-console */

import type { AiriClient } from './client.js'
import type { InputTextData, WebSocketEvent } from './types.js'

import { createAiriClient } from './client.js'

export interface MockStageConfig {
  hubUrl?: string
  hubToken?: string
  /** 自定义回复生成函数，默认会 echo 输入文本 */
  generateReply?: (text: string, senderInfo: string) => string | Promise<string>
  /** 模拟的回复延迟(ms)，模拟 LLM 推理时间，默认 500 */
  replyDelayMs?: number
}

export interface MockStage {
  connect: () => Promise<void>
  close: () => void
  readonly client: AiriClient
}

export function createMockStage(config: MockStageConfig = {}): MockStage {
  const {
    hubUrl = 'ws://localhost:6121',
    hubToken,
    generateReply = defaultReply,
    replyDelayMs = 500,
  } = config

  const client = createAiriClient({
    name: 'mock-stage',
    url: hubUrl,
    token: hubToken,
    // 模拟 stage-web：监听所有输入事件
    possibleEvents: [
      'input:text',
      'input:text:voice',
      'output:gen-ai:chat:message',
      'output:gen-ai:chat:complete',
    ],
  })

  // 监听 input:text 事件，生成模拟回复
  client.onEvent('input:text', async (event: WebSocketEvent) => {
    const data = event.data as InputTextData
    const text = data.text
    if (!text)
      return

    const senderInfo = data.overrides?.messagePrefix ?? ''
    console.log(`[mock-stage] received: ${senderInfo}${text}`)

    // 模拟 LLM 推理延迟
    await sleep(replyDelayMs)

    const reply = await generateReply(text, senderInfo)
    console.log(`[mock-stage] replying: ${reply.slice(0, 80)}`)

    // 发出完整回复事件（和真实 stage-web 发出的格式一致）
    client.send('output:gen-ai:chat:complete', {
      'message': {
        role: 'assistant',
        content: reply,
      },
      // 携带原始输入的元数据，让 webhook adapter 的 onReply 能路由回正确的频道
      'gen-ai:chat': {
        input: {
          data: event.data,
        },
      },
    })
  })

  return {
    async connect() {
      await client.connect()
      console.log('[mock-stage] ready — will auto-reply to input:text events')
    },
    close() {
      client.close()
    },
    get client() { return client },
  }
}

function defaultReply(text: string, senderInfo: string): string {
  // 简单的模板回复，模拟人偶的回答
  const replies = [
    `收到你的消息了！你说的是「${text}」对吧？`,
    `嗯嗯，我理解了。关于「${text}」这个问题，让我想想...`,
    `你好呀！${senderInfo ? `${senderInfo.replace(/[()]/g, '')}，` : ''}你说的「${text}」很有意思呢！`,
  ]
  return replies[Math.floor(Math.random() * replies.length)]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
