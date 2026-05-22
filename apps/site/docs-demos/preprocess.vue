<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const normalize = (v: unknown): unknown => (typeof v === 'string' ? v.trim().toLowerCase() : v)

  const schema = z.object({
    email: z.preprocess(normalize, z.email('Use the format you@domain.com')),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-preprocess',
    validateOn: 'blur',
  })

  const parsePreview = computed(() => normalize(form.values.email))

  const submittedShape = ref<unknown>(null)
  const onSubmit = form.handleSubmit((data) => {
    submittedShape.value = data
  })
</script>

<template>
  <div class="layout">
    <form @submit.prevent="onSubmit">
      <label>
        Email
        <input
          v-register="form.register('email')"
          placeholder="  Ada@Example.COM "
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <p v-if="form.fields.email.showErrors" class="error" role="alert">
        {{ form.fields.email.firstError?.message }}
      </p>
      <p v-else class="hint">
        Try stray whitespace or mixed case. Preprocess normalises before the email check runs;
        storage keeps what you typed.
      </p>

      <button type="submit">Submit</button>
    </form>

    <section>
      <h4>READ: <code>form.values.email</code></h4>
      <p>Storage holds your raw input verbatim. Preprocess has not run yet.</p>
      <pre>{{
        form.values.email === '' || form.values.email === undefined
          ? '(empty)'
          : JSON.stringify(form.values.email)
      }}</pre>
    </section>

    <section>
      <h4>PREVIEW: what preprocess returns</h4>
      <p>
        Recomputed live for the demo. The real call happens inside validation and submit; this is
        the value they see.
      </p>
      <pre>{{ JSON.stringify(parsePreview) }}</pre>
    </section>

    <section v-if="submittedShape">
      <h4>SUBMIT: <code>handleSubmit</code> argument</h4>
      <p>Post-parse output. The trimmed, lowercased email is what your handler receives.</p>
      <pre>{{ JSON.stringify(submittedShape, null, 2) }}</pre>
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
  .error {
    margin: 0;
    color: #b91c1c;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
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
  section p {
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
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
</style>
