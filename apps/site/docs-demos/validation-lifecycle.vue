<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import { ref } from 'vue'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      age: z.number().int().min(18, 'Must be 18 or older'),
    }),
    defaultValues: { age: 0 },
    key: 'docs-demo-validation-lifecycle',
  })

  const lastResult = ref<string>('—')

  function runValidate() {
    const status = form.validate()
    const s = status.value
    lastResult.value = s.pending
      ? 'form.validate() → pending'
      : `form.validate() → ${s.success ? '✓ valid' : '✗ invalid'}`
  }

  async function runValidateAsync() {
    lastResult.value = 'form.validateAsync() → awaiting…'
    const res = await form.validateAsync()
    lastResult.value = `form.validateAsync() → ${res.success ? '✓ valid' : '✗ invalid'}`
  }

  async function runProcess() {
    lastResult.value = 'form.process() → awaiting…'
    const res = await form.process()
    lastResult.value = res.success
      ? `form.process() → ✓ parsed: ${JSON.stringify(res.data, (_, v) => (v === undefined ? '(undefined)' : v))}`
      : `form.process() → ✗ invalid`
  }
</script>

<template>
  <form @submit.prevent>
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

    <div class="actions">
      <button type="button" @click="runValidate">form.validate() — sync</button>
      <button type="button" @click="runValidateAsync">form.validateAsync() — awaited</button>
      <button type="button" @click="runProcess">form.process() — parsed payload</button>
    </div>

    <p class="result">{{ lastResult }}</p>
  </form>
</template>
