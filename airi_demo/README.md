# AIRI Webhook Demo — 人偶对话 Webhook 通信最小单元

从 [moeru-ai/airi](https://github.com/moeru-ai/airi) 提炼出的独立可复用 webhook 通信模块。可直接迁移到任何需要 webhook 接入 AIRI 人偶的项目。

## 架构

```text
外部平台 (OpenClaw / 微信 / Slack / 自定义)
  │  POST /webhook
  ▼
Webhook Adapter (HTTP :6122)          ← webhook-adapter.ts
  │  input:text (WebSocket)
  ▼
Event Hub (WS :6121)                  ← server.ts
  │  路由事件到所有订阅者
  ▼
Stage / LLM (浏览器 or mock)          ← mock-stage.ts (demo) / stage-web (生产)
  │  output:gen-ai:chat:complete
  ▼
Webhook Adapter.onReply()
  │
  ▼
回复到原平台 (通过 API 回发)
```

## 文件结构

```text
airi_demo/
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts              # 核心类型 + 事件构造器（最小协议定义）
│   ├── server.ts             # 事件路由中枢（简化版 server-runtime）
│   ├── client.ts             # WebSocket SDK 客户端（简化版 server-sdk）
│   ├── webhook-adapter.ts    # Webhook HTTP 适配器（核心迁移单元）
│   ├── mock-stage.ts         # 模拟 LLM/Stage（测试用）
│   └── index.ts              # 一键启动入口
└── scripts/
    └── simulate.mjs          # 零依赖测试脚本
```

## 快速开始

### 安装

```bash
cd airi_demo
npm install
```

### 一键启动（Event Hub + Mock Stage + Webhook Adapter）

```bash
npx tsx src/index.ts
```

### 发送测试消息

```powershell
# PowerShell
curl.exe -X POST http://localhost:6122/webhook `
  -H "Content-Type: application/json" `
  -d '{"text":"你好AIRI！","sender":{"name":"Alice"},"platform":"whatsapp"}'
```

```bash
# bash / zsh
curl -X POST http://localhost:6122/webhook \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好AIRI！","sender":{"name":"Alice"},"platform":"whatsapp"}'
```

### 使用模拟脚本

```bash
# Webhook 模式（需要 Node.js 22+）
node scripts/simulate.mjs
node scripts/simulate.mjs --text "Hello AIRI"

# Direct 模式（绕过 webhook，直连事件中枢）
node scripts/simulate.mjs --direct
node scripts/simulate.mjs --direct --text "你好"
```

## 分组件启动

也可以分别启动各组件（用于对接真实的 AIRI stage-web）：

```bash
# 终端 1：事件中枢
npx tsx src/server.ts

# 终端 2：Webhook 适配器
npx tsx src/webhook-adapter.ts

# stage-web 在浏览器中打开（对接真实 AIRI 项目时）
# pnpm -F @proj-airi/stage-web dev
```

## 迁移到新平台

接入新的 webhook 平台只需实现一个 `transform` 函数：

### 示例：接入微信公众号

```typescript
import { createWebhookAdapter } from './src/webhook-adapter.js'

const adapter = createWebhookAdapter({
  name: 'wechat',
  webhookPort: 6200,
  transform: body => ({
    text: body.Content, // ← 你的字段名
    sender: { id: body.FromUserName, name: '微信用户' },
    service: 'wechat',
    platform: 'wechat-mp',
    channelId: body.ToUserName,
  }),
  onReply: async (reply) => {
    // 调用微信客服消息 API 回复
    await sendWechatReply(reply.inputMetadata?.wechat?.channelId, reply.content)
  },
})

await adapter.start()
```

### 示例：接入 Slack

```typescript
const adapter = createWebhookAdapter({
  name: 'slack',
  webhookPort: 6201,
  transform: body => ({
    text: body.event?.text ?? '',
    sender: { id: body.event?.user, name: body.event?.user },
    service: 'slack',
    platform: 'slack',
    channelId: body.event?.channel,
  }),
  onReply: async (reply) => {
    await slackClient.chat.postMessage({
      channel: reply.inputMetadata?.slack?.channelId,
      text: reply.content,
    })
  },
})
```

### 示例：接入自定义 HTTP API

```typescript
import { createWebhookAdapter, simpleTransform } from './src/webhook-adapter.js'

// 使用内置的通用 transform（接受 {text/message/content, sender/from/user} 格式）
const adapter = createWebhookAdapter({
  name: 'my-app',
  webhookPort: 8080,
  transform: simpleTransform,
  onReply: reply => console.info('Reply:', reply.content),
})
```

## 核心 API

### `buildInputTextData(params)` — 构建标准输入事件

```typescript
import { buildInputTextData } from './src/types.js'

const data = buildInputTextData({
  text: '你好！',
  sender: { name: 'Alice' },
  service: 'openclaw',
  platform: 'whatsapp',
  channelId: 'chat_123',
})
// → 包含 sessionId, messagePrefix, contextUpdates 的完整 input:text data
```

### `createAiriClient(config)` — WebSocket SDK 客户端

```typescript
import { createAiriClient } from './src/client.js'

const client = createAiriClient({
  name: 'my-service',
  url: 'ws://localhost:6121',
  possibleEvents: ['input:text', 'output:gen-ai:chat:complete'],
})

client.onEvent('output:gen-ai:chat:complete', (event) => {
  console.info('Reply:', event.data.message?.content)
})

await client.connect()
client.send('input:text', { text: 'Hello' })
```

### `createWebhookAdapter(config)` — Webhook HTTP 适配器

```typescript
import { createWebhookAdapter } from './src/webhook-adapter.js'

const adapter = createWebhookAdapter({
  name: 'my-platform',
  webhookPort: 6122,
  transform: body => ({ text: body.text, service: 'my-platform', sender: { name: 'User' } }),
  onReply: reply => console.info(reply.content),
})
await adapter.start()
```

## 对接真实 AIRI 项目

将此 demo 的 `webhook-adapter.ts` 接入真实 AIRI 项目时：

1. 事件中枢不需要 — 用 AIRI 的 `server-runtime` (端口 6121)
2. Mock Stage 不需要 — 用 AIRI 的 `stage-web` (浏览器)
3. 只需要启动 **webhook-adapter**，配置 `hubUrl: 'ws://localhost:6121'`

```bash
# 真实 AIRI 项目中
pnpm -F @proj-airi/server-runtime dev    # 端口 6121
pnpm -F @proj-airi/stage-web dev         # 端口 5173（浏览器中打开配置 LLM）

# 本 demo 的 webhook adapter
HUB_URL=ws://localhost:6121 npx tsx src/webhook-adapter.ts
```

## 与原项目的对应关系

| Demo 文件 | 原项目文件 | 说明 |
|-----------|-----------|------|
| `types.ts` | `packages/plugin-protocol/src/types/events.ts` | 事件类型定义（大幅简化） |
| `server.ts` | `packages/server-runtime/src/index.ts` | 事件路由中枢（~250行 vs ~1000行） |
| `client.ts` | `packages/server-sdk/src/client.ts` | SDK 客户端（~250行 vs ~500行） |
| `webhook-adapter.ts` | `services/openclaw/src/adapters/airi-adapter.ts` | Webhook 适配器（通用化） |
| `mock-stage.ts` | `apps/stage-web/` (整个前端) | 模拟 LLM 回复 |
| `simulate.mjs` | `scripts/simulate-openclaw-message.mjs` | 测试脚本 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HUB_PORT` | `6121` | 事件中枢端口 |
| `WEBHOOK_PORT` | `6122` | Webhook 适配器端口 |
| `HUB_URL` | `ws://localhost:6121` | 事件中枢 URL |
| `AUTH_TOKEN` | (无) | 认证 token |
| `MODULE_NAME` | `openclaw` | 模块名称 |
