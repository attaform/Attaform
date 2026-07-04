<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

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
  <form class="demo" @submit.prevent>
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
      <pre>{{ describe(form.values.avatar) }}</pre>

      <p class="panel-title">form.values.attachments</p>
      <pre>{{
        form.values.attachments.length === 0
          ? '[]'
          : form.values.attachments.map(describe).join('\n')
      }}</pre>
    </div>
  </form>
</template>
