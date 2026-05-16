<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const log = ref<string[]>([])
  function record(msg: string) {
    log.value = [`${new Date().toLocaleTimeString()} — ${msg}`, ...log.value].slice(0, 5)
  }

  const form = useForm({
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    key: 'docs-demo-imperative-persistence',
    persist: 'session',
  })

  async function saveNow() {
    await form.persist('title')
    await form.persist('body')
    record('form.persist(...) — wrote both paths to sessionStorage')
  }

  async function clearAll() {
    await form.clearPersistedDraft()
    record('form.clearPersistedDraft() — wiped the stored draft')
  }

  async function clearTitleOnly() {
    await form.clearPersistedDraft('title')
    record(`form.clearPersistedDraft('title') — wiped just one path`)
  }
</script>

<template>
  <form @submit.prevent>
    <label>
      Title
      <input v-register="form.register('title')" type="text" placeholder="Type freely" />
    </label>
    <label>
      Body
      <textarea v-register="form.register('body')" rows="3" placeholder="Type freely"></textarea>
    </label>

    <p class="hint">
      Neither field opted into persistence via <code>register</code>.
      <code>form.persist()</code> bypasses that gate and writes the current snapshot anyway — useful
      for &quot;Save draft&quot; buttons and <code>beforeunload</code> handlers.
    </p>

    <div class="actions">
      <button type="button" @click="saveNow">persist('title') + persist('body')</button>
      <button type="button" @click="clearTitleOnly">clearPersistedDraft('title')</button>
      <button type="button" @click="clearAll">clearPersistedDraft()</button>
    </div>

    <ul v-if="log.length" class="log">
      <li v-for="entry in log" :key="entry">{{ entry }}</li>
    </ul>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input,
  textarea {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus,
  textarea:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .actions button {
    padding: 0.375rem 0.75rem;
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .actions button:hover {
    background: #f9fafb;
  }
  .log {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: #0f172a;
    color: #a5f3fc;
    border-radius: 0.375rem;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
</style>
