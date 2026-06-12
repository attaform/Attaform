<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
      // real-world domain shapes only, requiring a TLD of at least
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
  <div class="demo layout split">
    <form class="stack" @submit.prevent="onSubmit">
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
        <button type="submit" class="primary" :disabled="form.meta.validating">
          {{ form.meta.validating ? 'Checking…' : 'Submit' }}
        </button>
        <button type="button" @click="clearCache">Clear cache</button>
      </div>
    </form>

    <section>
      <h4>READ: <code>form.values.url</code></h4>
      <p class="hint">Storage holds your raw input verbatim. Sentinels never reach this surface.</p>
      <pre>{{
        form.values.url === undefined || form.values.url === '' ? '(empty)' : form.values.url
      }}</pre>
    </section>

    <section>
      <h4>CACHE log</h4>
      <p class="hint"
        >Each unique URL hits the simulated API once. Repeats reuse the cached answer.</p
      >
      <ol v-if="cacheLog.length > 0" class="checks">
        <li v-for="(entry, i) in cacheLog" :key="i" :class="{ cached: entry.fromCache }">
          <code>{{ entry.url }}</code>
          <span class="avail" :class="entry.available ? 'free' : 'taken'">
            {{ entry.available ? 'available' : 'taken' }}
          </span>
          <span v-if="entry.fromCache" class="cache-flag">from cache</span>
        </li>
      </ol>
      <p v-else class="hint">No URLs checked yet. Type a value and blur the input.</p>
    </section>

    <section v-if="submittedShape">
      <h4>SUBMIT: <code>handleSubmit</code> argument</h4>
      <p class="hint"
        >Post-parse value. Preprocess augmented the URL, refine confirmed availability.</p
      >
      <pre>{{ JSON.stringify(submittedShape, null, 2) }}</pre>
    </section>
  </div>
</template>

<style scoped>
  /* Domain-specific bits only: the availability pills and the cache-check
     list. Generic names would collide with the registry (log = dark
     terminal, badge = mono state badge, status = save-state pill), so
     these carry their own names and stay tokenized for dark mode. */
  .checks {
    margin: 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
  }
  .checks li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .checks li code {
    flex: 0 1 auto;
  }
  .avail {
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 500;
  }
  .avail.free {
    background: var(--color-success-soft);
    color: var(--color-success);
  }
  .avail.taken {
    background: var(--color-danger-soft);
    color: var(--color-danger);
  }
  .cache-flag {
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    background: var(--color-surface-2);
    color: var(--color-fg-muted);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>
