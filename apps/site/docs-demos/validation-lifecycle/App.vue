<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import { ref } from 'vue'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      age: z.number().int().min(18, 'Must be 18 or older'),
    }),
    defaultValues: { age: 0 },
    key: 'docs-demo-validation-lifecycle',
  })

  const lastResult = ref<string>('idle')

  function runValidate() {
    const status = form.validate()
    const s = status.value
    lastResult.value = s.pending
      ? 'form.validate() → pending'
      : `form.validate() → ${s.success ? '✓ valid' : '✗ invalid'}`
  }

  async function runCommittingParse() {
    lastResult.value = 'form.parse({ commit: true }) → awaiting…'
    const res = await form.parse({ commit: true })
    lastResult.value = `form.parse({ commit: true }) → ${res.success ? '✓ valid' : '✗ invalid'}`
  }

  async function runParse() {
    lastResult.value = 'form.parse() → awaiting…'
    const res = await form.parse()
    lastResult.value = res.success
      ? `form.parse() → ✓ parsed: ${JSON.stringify(res.data, (_, v) => (v === undefined ? '(undefined)' : v))}`
      : `form.parse() → ✗ invalid`
  }
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      <span>Email</span>
      <input v-register="form.register('email')" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <label>
      <span>Age</span>
      <input v-register="form.register('age')" type="number" />
      <em v-if="form.fields.age.showErrors">{{ form.fields.age.firstError?.message }}</em>
    </label>

    <div class="actions mono">
      <button type="button" @click="runValidate">form.validate() (sync)</button>
      <button type="button" @click="runCommittingParse"
        >form.parse({ commit: true }) (awaited)</button
      >
      <button type="button" @click="runParse">form.parse() (parsed payload)</button>
    </div>

    <pre>{{ lastResult }}</pre>
  </form>
</template>
