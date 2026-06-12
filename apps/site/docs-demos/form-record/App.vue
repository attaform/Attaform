<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      medals: z.record(z.string(), z.number()),
    }),
    defaultValues: {
      medals: { Ada: 3, Grace: 5, Katherine: 2 },
    },
    key: 'docs-demo-form-record',
  })

  const newAthlete = ref('')

  const total = computed(() =>
    Object.values(form.values.medals ?? {}).reduce((sum, count) => sum + (count ?? 0), 0)
  )

  function addAthlete(): void {
    const name = newAthlete.value.trim()
    if (name.length === 0) return
    form.setValue(`medals.${name}`, 0)
    newAthlete.value = ''
  }

  function removeAthlete(key: string): void {
    const next = { ...form.values.medals }
    delete next[key]
    form.setValue('medals', next)
  }
</script>

<template>
  <form class="demo" @submit.prevent>
    <ul class="rows">
      <li v-for="(field, key) in form.record('medals')" :key="key" class="row">
        <code class="token">{{ key }}</code>
        <input
          v-register="form.register(`medals.${key}`)"
          type="number"
          :aria-label="`Medals for ${key}`"
        />
        <span class="tally">{{ field.value }}</span>
        <button type="button" title="Remove" @click="removeAthlete(key)">×</button>
      </li>
    </ul>

    <div class="actions mono">
      <input
        v-model="newAthlete"
        placeholder="Add an athlete"
        @keydown.enter.prevent="addAthlete"
      />
      <button type="button" @click="addAthlete">form.setValue(…)</button>
    </div>

    <p class="hint">
      The keys come straight from <code>form.record('medals')</code>, not a list you maintain. Add
      an athlete and a new row joins the view; clear one and it leaves. Team total:
      <strong>{{ total }}</strong
      >.
    </p>
  </form>
</template>

<style scoped>
  .token {
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: var(--color-fg);
    background: var(--color-surface-2);
    border-radius: 0.25rem;
    padding: 0.15rem 0.5rem;
    min-width: 4.5rem;
    text-align: center;
  }
  input[type='number'] {
    width: 5rem;
  }
  .actions input {
    flex: 1;
  }
  .tally {
    font-size: 0.8rem;
    color: var(--color-fg-muted);
    min-width: 1.5rem;
  }
  .row button {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.25rem;
    border: 1px solid var(--color-border-strong);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 0.875rem;
    cursor: pointer;
  }
  .row button:hover {
    background: var(--color-surface-2);
  }
</style>
