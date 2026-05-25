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
