<script setup lang="ts">
import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import { ChatHistory } from '@proj-airi/stage-ui/components'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { Button, BasicTextarea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

const chatStreamStore = useChatStreamStore()
const chatSessionStore = useChatSessionStore()
const chatOrchestratorStore = useChatOrchestratorStore()
const consciousnessStore = useConsciousnessStore()

const { streamingMessage } = storeToRefs(chatStreamStore)
const { messages } = storeToRefs(chatSessionStore)
const { sending } = storeToRefs(chatOrchestratorStore)
const { activeProvider, activeModel } = storeToRefs(consciousnessStore)

const historyMessages = computed(() => messages.value as unknown as ChatHistoryItem[])

// Whether an LLM provider is configured so we can offer the "real send" path
const isProviderReady = computed(() => !!activeProvider.value && !!activeModel.value)

// --- Simulated response injection (no LLM required) ---
const simulatedText = ref('こんにちは！これはテストメッセージです。アバターのチャットバブルが表示されているか確認してください。')
const isSimulating = ref(false)

/** Type each character with a short delay to mimic streaming. */
async function injectSimulatedResponse() {
  if (isSimulating.value)
    return

  isSimulating.value = true
  chatStreamStore.beginStream()

  const text = simulatedText.value || 'Hello! This is a test response from the chat devtools.'

  for (const char of text) {
    chatStreamStore.appendStreamLiteral(char)
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>(r => setTimeout(r, 30))
  }

  chatStreamStore.finalizeStream(text)
  isSimulating.value = false
}

function clearHistory() {
  chatStreamStore.resetStream()
  chatSessionStore.messages.length = 0
}
</script>

<template>
  <div flex="~ col gap-4" h-full p-4>
    <div flex="~ col gap-1">
      <h2 text="lg font-semibold">
        Chat Devtools
      </h2>
      <p text="sm neutral-500 dark:neutral-400">
        Directly inject a simulated assistant response into the chat bubble, or send a real message if an LLM provider is configured.
      </p>
    </div>

    <!-- Provider status -->
    <div
      flex="~ row items-center gap-2"
      rounded-lg px-3 py-2 text-sm
      :class="isProviderReady
        ? 'bg-green-100/60 dark:bg-green-900/30 text-green-700 dark:text-green-300'
        : 'bg-yellow-100/60 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300'"
    >
      <div
        :class="[
          'h-2 w-2 rounded-full',
          isProviderReady ? 'bg-green-500' : 'bg-yellow-500',
        ]"
      />
      <span v-if="isProviderReady">
        LLM provider ready: <strong>{{ activeProvider }}</strong> / {{ activeModel }}
      </span>
      <span v-else>
        No LLM provider configured — only simulated injection available.
        Configure a provider in <strong>Settings → Modules → Consciousness</strong>.
      </span>
    </div>

    <!-- Chat history preview -->
    <div
      :class="[
        'flex flex-col',
        'h-64 min-h-40',
        'rounded-xl border border-neutral-200 dark:border-neutral-800',
        'bg-neutral-50/50 dark:bg-neutral-900/50',
        'overflow-hidden',
      ]"
    >
      <ChatHistory
        :messages="historyMessages"
        :sending="sending || isSimulating"
        :streaming-message="streamingMessage"
        h-full
        variant="mobile"
      />
    </div>

    <!-- Simulated injection -->
    <div flex="~ col gap-2">
      <label text="sm font-medium">Simulated response text</label>
      <BasicTextarea
        v-model="simulatedText"
        placeholder="Type the response text the avatar should 'say'…"
        min-h="[80px]"
        rounded-lg border border-neutral-200 dark:border-neutral-700
        bg-transparent p-2 text-sm outline-none
      />
      <div flex="~ row gap-2">
        <Button
          :disabled="isSimulating"
          @click="injectSimulatedResponse"
        >
          <span v-if="isSimulating" class="i-svg-spinners:3-dots-scale mr-1"></span>
          {{ isSimulating ? 'Streaming…' : '▶ Inject simulated response' }}
        </Button>
        <Button
          variant="secondary"
          @click="clearHistory"
        >
          Clear history
        </Button>
      </div>
    </div>

    <!-- How to see the popup on the main stage -->
    <div
      rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700
      p-4 text-sm text-neutral-500 dark:text-neutral-400
      flex="~ col gap-1"
    >
      <p font-semibold text-neutral-700 dark:text-neutral-200>
        How to see the chat bubble on the avatar:
      </p>
      <ol list-decimal list-inside space-y-1>
        <li>Return to the main stage page.</li>
        <li>The bottom drawer shows chat history — that is the message popup area on mobile.</li>
        <li>
          For messages to be generated automatically (via OpenClaw or voice), a LLM provider
          must be configured in <strong>Settings → Modules → Consciousness</strong>.
        </li>
      </ol>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: plain
</route>
