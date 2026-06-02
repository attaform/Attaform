<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const sessionCounter = ref(0)

  const schema = z.object({
    sessionId: z.string(),
    createdAt: z.string(),
    topic: z.string().min(1, 'Add a topic to continue'),
  })

  function buildDefaults() {
    sessionCounter.value += 1
    const id = String(sessionCounter.value).padStart(4, '0')
    return {
      sessionId: `sess-${id}`,
      createdAt: new Date().toISOString(),
      topic: '',
    }
  }

  const form = useForm({
    schema,
    defaultValues: buildDefaults,
    key: 'docs-demo-defaults-sync-factory',
  })

  async function onNewSession() {
    await form.rehydrate()
  }

  const lastSubmitted = ref<unknown>(null)
  const onSubmit = form.handleSubmit((values) => {
    lastSubmitted.value = values
  })
</script>

<template>
  <div class="layout">
    <form class="card" @submit.prevent="onSubmit">
      <header>
        <h4>Report session</h4>
        <button type="button" class="ghost" @click="onNewSession">New session</button>
      </header>

      <label>
        <span>Session ID</span>
        <input v-register="form.register('sessionId')" readonly />
      </label>

      <label>
        <span>Created at</span>
        <input v-register="form.register('createdAt')" readonly />
      </label>

      <label>
        <span>Topic</span>
        <input v-register="form.register('topic')" placeholder="What's this report about?" />
        <em v-if="form.fields.topic.showErrors">{{ form.fields.topic.firstError?.message }}</em>
      </label>

      <button type="submit">Submit</button>
    </form>

    <section>
      <h4>Reactive state</h4>
      <dl>
        <dt>Factory invocations</dt>
        <dd>{{ sessionCounter }}</dd>
        <dt><code>form.hydrating</code></dt>
        <dd>{{ form.hydrating }}</dd>
        <dt><code>form.values.sessionId</code></dt>
        <dd>{{ form.values.sessionId }}</dd>
      </dl>

      <h4>Last submitted</h4>
      <pre v-if="lastSubmitted">{{ JSON.stringify(lastSubmitted, null, 2) }}</pre>
      <p v-else class="muted">Fill in the topic and submit to see the parsed payload.</p>
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
  input {
    padding: 0.375rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.8125rem;
    font-family: inherit;
    background: white;
  }
  input:read-only {
    background: #f9fafb;
    color: #4b5563;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  button {
    align-self: flex-start;
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
  button.ghost {
    background: white;
    color: #374151;
    border-color: #d1d5db;
    align-self: auto;
  }
  button.ghost:hover {
    background: #f3f4f6;
  }
  em {
    color: #dc2626;
    font-size: 0.75rem;
    font-style: normal;
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
  .muted {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
    font-style: italic;
  }
</style>
