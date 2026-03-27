import process, { env } from 'node:process'

import { Format, LogLevel, setGlobalFormat, setGlobalLogLevel, useLogg } from '@guiiai/logg'

import { OpenClawAdapter } from './adapters/airi-adapter'

setGlobalFormat(Format.Pretty)
setGlobalLogLevel(LogLevel.Log)
const log = useLogg('OpenClaw').useGlobalConfig()

async function main() {
  // Env vars are resolved inside OpenClawAdapter with defaults; pass undefined to use them.
  const adapter = new OpenClawAdapter({
    airiToken: env.AIRI_TOKEN ?? 'abcd',
    airiUrl: env.AIRI_URL ?? 'ws://localhost:6121/ws',
  })

  await adapter.start()

  async function gracefulShutdown(signal: string) {
    log.log(`Received ${signal}, shutting down...`)
    adapter.stop()
    process.exit(0)
  }

  process.on('SIGINT', async () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', async () => gracefulShutdown('SIGTERM'))
}

main().catch(err => log.withError(err).error('An error occurred'))
