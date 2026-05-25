<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const formatPhone = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    const digits = v.replace(/\D/g, '')
    return digits.length === 10
      ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
      : v
  }

  const schema = z.object({
    flag: z.boolean().default(true),
    phone: z.preprocess(formatPhone, z.string()),
    ratio: z.string().transform((v) => Number(v) / 100),
  })

  const form = useForm({
    schema,
    defaultValues: { phone: '5551234567', ratio: '50' },
    key: 'docs-demo-storage-shape',
  })

  const submittedShape = ref<unknown>(null)
  const onSubmit = form.handleSubmit(async (values) => {
    submittedShape.value = values
  })
</script>

<template>
  <div class="layout">
    <form @submit.prevent="onSubmit">
      <label>
        flag (boolean)
        <input v-register="form.register('flag')" type="checkbox" />
      </label>
      <label>
        phone (raw in storage, formatted at submit)
        <input v-register="form.register('phone')" />
      </label>
      <label>
        ratio (string in storage, number at submit)
        <input v-register="form.register('ratio')" />
      </label>
      <button type="submit">Submit to see the parsed shape</button>
    </form>

    <section>
      <h4>READ: <code>form.values</code></h4>
      <p
        >Concrete types after defaults resolve. Preprocess + transforms have NOT run; storage holds
        raw input.</p
      >
      <pre>{{
        JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
    </section>

    <section>
      <h4>SUBMIT: <code>handleSubmit</code> argument</h4>
      <p>Post-parse output. <code>phone</code> is formatted, <code>ratio</code> is a number.</p>
      <pre v-if="submittedShape">{{
        JSON.stringify(submittedShape, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
      <pre v-else class="placeholder">Submit to populate</pre>
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
  form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: #374151;
  }
  input {
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  button {
    align-self: flex-start;
    padding: 0.5rem 0.875rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: #1d4ed8;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  h4 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  p {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
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
  pre.placeholder {
    background: #f3f4f6;
    color: #9ca3af;
    border: 1px dashed #d1d5db;
    font-style: italic;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
</style>
