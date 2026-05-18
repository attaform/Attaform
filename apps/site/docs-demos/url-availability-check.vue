<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const EMPTY_URL = '__atta:empty-url__'
  const INVALID_URL = '__atta:invalid-url__'

  const TAKEN = new Set(['https://google.com', 'https://apple.com', 'https://github.com'])
  const TAKEN_DISPLAY = ['google.com', 'apple.com', 'github.com']
  const availabilityCache = new Map<string, boolean>()
  const cacheLog = ref<Array<{ url: string; available: boolean; fromCache: boolean }>>([])

  async function checkAvailability(url: string): Promise<boolean> {
    const cached = availabilityCache.get(url)
    if (cached !== undefined) {
      cacheLog.value = [...cacheLog.value, { url, available: cached, fromCache: true }]
      return cached
    }
    await new Promise((r) => setTimeout(r, 350))
    const available = !TAKEN.has(url)
    availabilityCache.set(url, available)
    cacheLog.value = [...cacheLog.value, { url, available, fromCache: false }]
    return available
  }

  function formatUrl(v: unknown): string {
    if (typeof v !== 'string') return INVALID_URL
    const trimmed = v.trim()
    if (trimmed.length === 0) return EMPTY_URL
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    try {
      new URL(withProtocol)
      return withProtocol
    } catch {
      return INVALID_URL
    }
  }

  const schema = z.object({
    url: z.preprocess(
      formatUrl,
      z.string().refine(
        async (val) => {
          if (val === EMPTY_URL || val === INVALID_URL) return false
          return checkAvailability(val)
        },
        {
          error: (issue) => {
            const val = issue.input as string
            if (val === EMPTY_URL) return 'Please enter a URL.'
            if (val === INVALID_URL) return "That doesn't look like a URL."
            return `${val} is already taken.`
          },
        }
      )
    ),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-url-availability-check',
    validateOn: 'blur',
  })

  const submittedShape = ref<unknown>(null)
  const onSubmit = form.handleSubmit((data) => {
    submittedShape.value = data
  })

  function clearCache() {
    availabilityCache.clear()
    cacheLog.value = []
  }
</script>

<template>
  <div class="layout">
    <form @submit.prevent="onSubmit">
      <label>
        Your site URL
        <input
          v-register="form.register('url')"
          placeholder="example.com"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <p v-if="form.fields.url.showErrors" class="error" role="alert">
        {{ form.fields.url.firstError?.message }}
      </p>
      <p v-else class="hint">
        Taken in this demo:
        <code v-for="(url, i) in TAKEN_DISPLAY" :key="url"
          >{{ url }}<span v-if="i < TAKEN_DISPLAY.length - 1">, </span></code
        >. Anything else (or <code>###</code>) is fair game.
      </p>

      <div class="actions">
        <button type="submit" :disabled="form.meta.validating">
          {{ form.meta.validating ? 'Checking…' : 'Submit' }}
        </button>
        <button type="button" class="ghost" @click="clearCache">Clear cache</button>
      </div>
    </form>

    <section>
      <h4>READ: <code>form.values.url</code></h4>
      <p>Storage holds your raw input verbatim. Sentinels never reach this surface.</p>
      <pre>{{
        form.values.url === undefined || form.values.url === '' ? '(empty)' : form.values.url
      }}</pre>
    </section>

    <section>
      <h4>CACHE log</h4>
      <p
        >Each unique post-preprocess URL hits the simulated API once. Repeats reuse the cached
        answer.</p
      >
      <ol v-if="cacheLog.length > 0" class="log">
        <li v-for="(entry, i) in cacheLog" :key="i" :class="{ cached: entry.fromCache }">
          <code>{{ entry.url }}</code>
          <span class="status" :class="entry.available ? 'free' : 'taken'">
            {{ entry.available ? 'available' : 'taken' }}
          </span>
          <span v-if="entry.fromCache" class="badge">from cache</span>
        </li>
      </ol>
      <p v-else class="muted">No URLs checked yet. Type a value and blur the input.</p>
    </section>

    <section v-if="submittedShape">
      <h4>SUBMIT: <code>handleSubmit</code> argument</h4>
      <p>Post-parse value. Preprocess augmented the URL, refine confirmed availability.</p>
      <pre>{{ JSON.stringify(submittedShape, null, 2) }}</pre>
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
    gap: 0.625rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: #374151;
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
  button:hover:not(:disabled) {
    background: #1d4ed8;
  }
  button:disabled {
    background: #9ca3af;
    border-color: #9ca3af;
    cursor: progress;
  }
  button.ghost {
    background: white;
    color: #374151;
    border-color: #d1d5db;
  }
  button.ghost:hover {
    background: #f3f4f6;
  }
  .error {
    margin: 0;
    color: #b91c1c;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
  .hint code,
  section code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
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
  }
  .log li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .log li code {
    flex: 0 1 auto;
  }
  .status {
    font-weight: 500;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    font-size: 0.7rem;
  }
  .status.free {
    background: #d1fae5;
    color: #065f46;
  }
  .status.taken {
    background: #fee2e2;
    color: #991b1b;
  }
  .badge {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .muted {
    font-style: italic;
  }
</style>
