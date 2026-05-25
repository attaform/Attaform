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
      const parsed = new URL(withProtocol)
      // WHATWG URL accepts `https://ersdg` and `https://a.b` as
      // structurally valid. For a site-availability demo we want
      // real-world domain shapes only — require a TLD of at least
      // two characters.
      const dot = parsed.hostname.lastIndexOf('.')
      if (dot === -1) return INVALID_URL
      if (parsed.hostname.length - dot - 1 < 2) return INVALID_URL
      return parsed.href.replace(/\/$/, '')
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
      <p>Each unique URL hits the simulated API once. Repeats reuse the cached answer.</p>
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
