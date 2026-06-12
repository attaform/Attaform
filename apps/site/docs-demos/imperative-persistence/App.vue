<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const log = ref<string[]>([])
  function record(msg: string) {
    log.value = [`[${new Date().toLocaleTimeString()}] ${msg}`, ...log.value].slice(0, 5)
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
    record('form.persist(...) wrote both paths to sessionStorage')
  }

  async function clearAll() {
    await form.clearPersistedDraft()
    record('form.clearPersistedDraft() wiped the stored draft')
  }

  async function clearTitleOnly() {
    await form.clearPersistedDraft('title')
    record(`form.clearPersistedDraft('title') wiped just one path`)
  }
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      Title
      <input v-register="form.register('title')" placeholder="Type freely" />
    </label>
    <label>
      Body
      <textarea v-register="form.register('body')" rows="3" placeholder="Type freely"></textarea>
    </label>

    <p class="hint">
      Neither field opted into persistence via <code>register</code>.
      <code>form.persist()</code> bypasses that gate and writes the current snapshot anyway, useful
      for &quot;Save draft&quot; buttons and <code>beforeunload</code> handlers.
    </p>

    <div class="actions mono">
      <button type="button" @click="saveNow">persist('title') + persist('body')</button>
      <button type="button" @click="clearTitleOnly">clearPersistedDraft('title')</button>
      <button type="button" @click="clearAll">clearPersistedDraft()</button>
    </div>

    <ul v-if="log.length" class="log">
      <li v-for="entry in log" :key="entry">{{ entry }}</li>
    </ul>
  </form>
</template>
