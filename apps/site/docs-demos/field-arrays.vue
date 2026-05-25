<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      checkpoints: z.array(z.string()),
    }),
    defaultValues: { checkpoints: ['Warm-up', 'Sprint', 'Cooldown'] },
    key: 'docs-demo-field-arrays',
  })
</script>

<template>
  <form @submit.prevent>
    <ol class="rows">
      <li v-for="(_, i) in form.values.checkpoints" :key="i" class="row">
        <input v-register="form.register(`checkpoints.${i}` as const)" />
        <div class="row-actions">
          <button
            type="button"
            title="Move up"
            @click="i > 0 && form.move('checkpoints', i, i - 1)"
          >
            ↑
          </button>
          <button
            type="button"
            title="Move down"
            @click="i < form.values.checkpoints.length - 1 && form.move('checkpoints', i, i + 1)"
          >
            ↓
          </button>
          <button type="button" title="Remove" @click="form.remove('checkpoints', i)">×</button>
        </div>
      </li>
    </ol>

    <div class="actions">
      <button type="button" @click="form.append('checkpoints', 'New checkpoint')">
        form.append(…)
      </button>
      <button type="button" @click="form.prepend('checkpoints', 'First!')">form.prepend(…)</button>
      <button type="button" @click="form.insert('checkpoints', 1, 'Inserted at index 1')">
        form.insert(1, …)
      </button>
      <button
        type="button"
        :disabled="form.values.checkpoints.length < 2"
        @click="form.swap('checkpoints', 0, form.values.checkpoints.length - 1)"
      >
        form.swap(first, last)
      </button>
      <button
        type="button"
        :disabled="form.values.checkpoints.length === 0"
        @click="form.replace('checkpoints', 0, 'Replaced item 0')"
      >
        form.replace(0, …)
      </button>
    </div>

    <pre>{{
      JSON.stringify(form.values.checkpoints, (_, v) => (v === undefined ? '(undefined)' : v), 2)
    }}</pre>
  </form>
</template>
