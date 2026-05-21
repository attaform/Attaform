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
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.875rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    background: white;
  }
  .card[aria-busy='true'] {
    opacity: 0.85;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h4 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #1f2937;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: #374151;
  }
  input[type='text'],
  input:not([type]),
  input[type='email'],
  select {
    padding: 0.375rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.8125rem;
    font-family: inherit;
    background: white;
  }
  input:focus,
  select:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  input:disabled,
  select:disabled {
    background: #f9fafb;
    color: #9ca3af;
    cursor: progress;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.25rem;
  }
  button {
    padding: 0.4rem 0.75rem;
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
  .toggle {
    flex-direction: row;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: #6b7280;
  }
  .toggle input {
    margin: 0;
  }
  .badge {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-weight: 500;
  }
  .badge.hydrating {
    background: #fef3c7;
    color: #92400e;
  }
  .badge.ready {
    background: #d1fae5;
    color: #065f46;
  }
  .badge.error {
    background: #fee2e2;
    color: #991b1b;
  }
  .error-row {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
    border-radius: 0.375rem;
    padding: 0.4rem 0.55rem;
    font-size: 0.75rem;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.75rem;
    row-gap: 0.25rem;
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
  }
  dt {
    font-weight: 500;
    color: #374151;
  }
  dd {
    margin: 0;
    font-family: ui-monospace, monospace;
    color: #0f172a;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.7rem;
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
</style>
