<script setup lang="ts">
  import { reactive, ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    email: z.string(),
    profile: z.object({
      displayName: z.string(),
      bio: z.string(),
    }),
  })

  const form = useForm({ schema, key: 'docs-demo-on-change' })

  type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

  const fields = [
    { path: 'email', label: 'Email', placeholder: 'ada@example.com' },
    { path: 'profile.displayName', label: 'Display name', placeholder: 'Ada' },
    { path: 'profile.bio', label: 'Bio', placeholder: 'A short bio' },
  ] as const

  const status = reactive<Record<string, SaveStatus>>({
    email: 'idle',
    'profile.displayName': 'idle',
    'profile.bio': 'idle',
  })
  const failNext = ref(false)

  const statusOf = (path: string): SaveStatus => status[path] ?? 'idle'
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  async function persist(
    path: string,
    value: unknown,
    ctx: { signal: AbortSignal; attempt: number }
  ) {
    status[path] = 'saving'
    await delay(700)
    if (ctx.signal.aborted) return
    if (failNext.value && ctx.attempt === 0) {
      throw new Error('transient server error')
    }
    status[path] = 'saved'
    toast.success(`Saved ${path}`, { description: String(value) })
  }

  for (const path of ['email', 'profile.displayName', 'profile.bio'] as const) {
    form.onChange(path, (value, ctx) => persist(ctx.path, value, ctx), {
      onError: (_error, ctx) => {
        if (ctx.attempt === 0) {
          failNext.value = false
          toast.warning(`Save failed for ${ctx.path}, retrying`)
          ctx.retry()
        } else {
          status[ctx.path] = 'error'
          toast.error(`Save failed for ${ctx.path}`)
        }
      },
    })
  }

  function hydrate() {
    form.setValue(
      {
        email: 'ada@analytical.engine',
        profile: { displayName: 'Ada Lovelace', bio: 'Mathematician, first programmer.' },
      },
      { silent: true }
    )
    toast.info('Hydrated with { silent: true }, no save fired')
  }

  function resetForm() {
    form.reset()
    for (const field of fields) status[field.path] = 'idle'
    toast.info('reset(), no save fired')
  }

  const labels: Record<SaveStatus, string> = {
    idle: 'Idle',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Failed',
  }
</script>

<template>
  <form class="demo" @submit.prevent>
    <p class="lede">
      Each field autosaves ~700ms after you stop typing. Type fast to watch a stale save get
      superseded, tick the box to watch a failed save retry, then hydrate or reset to watch a write
      land with no save at all.
    </p>

    <label v-for="field in fields" :key="field.path">
      <span class="spread">
        {{ field.label }}
        <span class="status" :class="statusOf(field.path)">{{ labels[statusOf(field.path)] }}</span>
      </span>
      <input
        v-register="form.register(field.path)"
        :placeholder="field.placeholder"
        autocomplete="off"
        spellcheck="false"
      />
    </label>

    <label class="row compact">
      <input type="checkbox" v-model="failNext" />
      Make the next save fail once (auto-retries)
    </label>

    <div class="actions">
      <button type="button" class="primary" @click="hydrate">Load saved profile (silent)</button>
      <button type="button" class="ghost" @click="resetForm">Reset</button>
    </div>
  </form>
</template>
