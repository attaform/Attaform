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
  const server = reactive<Record<string, unknown>>({})
  const events = ref<string[]>([])
  const failNext = ref(false)

  const statusOf = (path: string): SaveStatus => status[path] ?? 'idle'

  function pushEvent(line: string) {
    events.value = [line, ...events.value].slice(0, 8)
  }

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  async function persist(
    path: string,
    value: unknown,
    ctx: { signal: AbortSignal; attempt: number }
  ) {
    status[path] = 'saving'
    await delay(700)
    if (ctx.signal.aborted) {
      pushEvent(`${path}: superseded, dropped`)
      return
    }
    if (failNext.value && ctx.attempt === 0) {
      throw new Error('transient server error')
    }
    server[path] = value
    status[path] = 'saved'
    pushEvent(`${path}: saved${ctx.attempt > 0 ? ` (attempt ${ctx.attempt + 1})` : ''}`)
  }

  for (const path of ['email', 'profile.displayName', 'profile.bio'] as const) {
    form.onChange(path, (value, ctx) => persist(ctx.path, value, ctx), {
      onError: (_error, ctx) => {
        if (ctx.attempt === 0) {
          failNext.value = false
          pushEvent(`${ctx.path}: save failed, retrying`)
          ctx.retry()
        } else {
          status[ctx.path] = 'error'
          pushEvent(`${ctx.path}: save failed`)
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
    pushEvent('hydrated via setValue({ silent: true }), no save fired')
  }

  function resetForm() {
    form.reset()
    for (const field of fields) status[field.path] = 'idle'
    pushEvent('reset(), no save fired')
  }

  const labels: Record<SaveStatus, string> = {
    idle: 'Idle',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Failed',
  }
</script>

<template>
  <div class="layout">
    <form @submit.prevent>
      <label v-for="field in fields" :key="field.path">
        <span class="row">
          {{ field.label }}
          <span class="status" :class="statusOf(field.path)">{{
            labels[statusOf(field.path)]
          }}</span>
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

    <section>
      <h4>SERVER snapshot</h4>
      <p>What the simulated autosave has persisted. Edits land here, hydration and reset don't.</p>
      <pre>{{
        Object.keys(server).length > 0 ? JSON.stringify(server, null, 2) : '(nothing saved yet)'
      }}</pre>
    </section>

    <section>
      <h4>EVENTS</h4>
      <p>Type fast to watch a stale save get superseded; tick the box to watch a retry recover.</p>
      <ol v-if="events.length > 0" class="log">
        <li v-for="(line, i) in events" :key="i">{{ line }}</li>
      </ol>
      <p v-else class="muted">No saves yet. Edit a field and pause for ~700ms.</p>
    </section>
  </div>
</template>

<style scoped>
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.25rem;
  }
  @media (min-width: 760px) {
    .layout {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: #374151;
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
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  .toggle {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: #6b7280;
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
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: #1d4ed8;
  }
  button.ghost {
    background: white;
    color: #374151;
    border-color: #d1d5db;
  }
  button.ghost:hover {
    background: #f3f4f6;
  }
  .status {
    font-weight: 500;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.7rem;
  }
  .status.idle {
    background: #f3f4f6;
    color: #6b7280;
  }
  .status.saving {
    background: #fef3c7;
    color: #92400e;
  }
  .status.saved {
    background: #d1fae5;
    color: #065f46;
  }
  .status.error {
    background: #fee2e2;
    color: #991b1b;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  h4 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  section p {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
  }
  pre {
    margin: 0;
    padding: 0.5rem 0.625rem;
    background: #0f172a;
    color: #a5f3fc;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    overflow: auto;
  }
  .log {
    margin: 0;
    padding: 0 0 0 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: #374151;
  }
  .muted {
    font-style: italic;
  }
</style>
