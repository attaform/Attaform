<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    email: z.email(),
    displayName: z.string().min(1),
    tier: z.enum(['free', 'pro', 'team']),
  })

  const failNext = ref(false)
  const fetchCount = ref(0)

  async function fetchDraft() {
    fetchCount.value += 1
    await new Promise((r) => setTimeout(r, 700))
    if (failNext.value) {
      failNext.value = false
      throw new Error('Network unreachable')
    }
    return {
      email: `user-${fetchCount.value}@example.com`,
      displayName: `User ${fetchCount.value}`,
      tier: 'pro' as const,
    }
  }

  const form = useForm({
    schema,
    key: 'docs-demo-defaults-async-factory',
    defaultValues: fetchDraft,
  })

  async function onRehydrate() {
    await form.rehydrate().catch(() => undefined)
  }
</script>

<template>
  <div class="layout">
    <form class="card" :aria-busy="form.hydrating" @submit.prevent>
      <header>
        <h4>Draft loader</h4>
        <span v-if="form.hydrating" class="badge hydrating">loading draft…</span>
        <span v-else-if="form.hydrateError" class="badge error">load failed</span>
        <span v-else class="badge ready">ready</span>
      </header>

      <label>
        <span>Email</span>
        <input v-register="form.register('email')" :disabled="form.hydrating" />
      </label>

      <label>
        <span>Display name</span>
        <input v-register="form.register('displayName')" :disabled="form.hydrating" />
      </label>

      <label>
        <span>Tier</span>
        <select v-register="form.register('tier')" :disabled="form.hydrating">
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="team">Team</option>
        </select>
      </label>

      <div v-if="form.hydrateError" class="error-row" role="alert">
        {{ form.hydrateError.message }}. Click <strong>Rehydrate</strong> to retry.
      </div>

      <div class="actions">
        <button type="button" :disabled="form.hydrating" @click="onRehydrate">
          {{ form.hydrating ? 'Loading…' : 'Rehydrate' }}
        </button>
        <label class="toggle">
          <input v-model="failNext" type="checkbox" />
          <span>Next call rejects</span>
        </label>
      </div>
    </form>

    <section>
      <h4>Reactive state</h4>
      <dl>
        <dt><code>form.hydrating</code></dt>
        <dd>{{ form.hydrating }}</dd>
        <dt><code>form.hydrateError?.code</code></dt>
        <dd>{{ form.hydrateError?.code ?? 'null' }}</dd>
        <dt><code>form.hydrateError?.message</code></dt>
        <dd>{{ form.hydrateError?.message ?? 'null' }}</dd>
        <dt>Factory invocations</dt>
        <dd>{{ fetchCount }}</dd>
      </dl>
      <h4>Storage</h4>
      <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
    </section>
  </div>
</template>
