<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
  <div class="demo layout split">
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
      <p v-else class="hint">Fill in the topic and submit to see the parsed payload.</p>
    </section>
  </div>
</template>
