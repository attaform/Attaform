<script setup lang="ts">
  import { reactive, ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

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
      <span class="row">
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

    <label class="toggle">
      <input type="checkbox" v-model="failNext" />
      Make the next save fail once (auto-retries)
    </label>

    <div class="actions">
      <button type="button" @click="hydrate">Load saved profile (silent)</button>
      <button type="button" class="ghost" @click="resetForm">Reset</button>
    </div>
  </form>
</template>

<style scoped>
  .demo {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    color: var(--color-fg);
  }
  .lede {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: var(--color-fg);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  input {
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: -1px;
  }
  .toggle {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--color-fg-subtle);
  }
  .toggle input {
    width: auto;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  button {
    align-self: flex-start;
    padding: 0.5rem 0.875rem;
    border-radius: 0.375rem;
    border: 1px solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-accent-fg);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
  }
  button.ghost {
    background: var(--color-bg);
    color: var(--color-fg);
    border-color: var(--color-border);
  }
  button.ghost:hover {
    background: var(--color-surface);
  }
  .status {
    font-weight: 500;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.7rem;
  }
  .status.idle {
    background: var(--color-surface-2);
    color: var(--color-fg-muted);
  }
  .status.saving {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }
  .status.saved {
    background: var(--color-success-soft);
    color: var(--color-success);
  }
  .status.error {
    background: var(--color-danger-soft);
    color: var(--color-danger);
  }
</style>
