<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      avatar: z.file().nullable(),
      attachments: z.array(z.file()),
    }),
    defaultValues: { avatar: null, attachments: [] },
    key: 'docs-demo-file',
  })

  const describe = (f: File | null) =>
    f === null ? 'null' : `${f.name} (${Math.round(f.size / 1024)} KB · ${f.type || 'unknown'})`
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Avatar (single)</span>
      <input v-register="form.register('avatar')" type="file" accept="image/*" />
    </label>

    <label>
      <span>Attachments (multiple)</span>
      <input v-register="form.register('attachments')" type="file" multiple />
    </label>

    <div class="panel">
      <p class="panel-title">form.values.avatar</p>
      <p>{{ describe(form.values.avatar) }}</p>

      <p class="panel-title">form.values.attachments</p>
      <p v-if="form.values.attachments.length === 0">[]</p>
      <ul v-else>
        <li v-for="f in form.values.attachments" :key="f.name + f.lastModified">{{
          describe(f)
        }}</li>
      </ul>
    </div>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 26rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input {
    padding: 0.4rem 0;
    font-size: 0.875rem;
  }
  .panel {
    margin-top: 0.25rem;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.6rem 0.75rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #111827;
  }
  .panel-title {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 0.2rem 0;
  }
  .panel p,
  .panel li {
    margin: 0 0 0.3rem 0;
  }
  .panel ul {
    margin: 0;
    padding-left: 1rem;
  }
</style>
