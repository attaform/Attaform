<script setup lang="ts">
  import { unset, useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    notify: z.boolean().default(true),
    count: z.number().default(10),
    tag: z.string().default('untitled'),
  })

  // 1. Bare: defaults flow from the schema.
  const bare = useForm({ schema, key: 'docs-demo-schema-defaults-bare' })

  // 2. Overlay: per-form `defaultValues` wins for the leaves it names.
  const overlaid = useForm({
    schema,
    defaultValues: { count: 42, tag: 'work-in-progress' },
    key: 'docs-demo-schema-defaults-overlay',
  })

  // 3. unset: opt a specific leaf back to blank.
  const blanked = useForm({
    schema,
    defaultValues: { count: unset },
    key: 'docs-demo-schema-defaults-unset',
  })
</script>

<template>
  <div class="demo layout split3">
    <section>
      <h4>Schema defaults only</h4>
      <form class="stack" @submit.prevent>
        <label>
          notify
          <input v-register="bare.register('notify')" type="checkbox" />
        </label>
        <label>
          count
          <input v-register="bare.register('count')" type="number" />
        </label>
        <label>
          tag
          <input v-register="bare.register('tag')" />
        </label>
      </form>
      <pre>{{
        JSON.stringify(bare.values, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
    </section>

    <section>
      <h4>defaultValues overlay</h4>
      <form class="stack" @submit.prevent>
        <label>
          notify
          <input v-register="overlaid.register('notify')" type="checkbox" />
        </label>
        <label>
          count
          <input v-register="overlaid.register('count')" type="number" />
        </label>
        <label>
          tag
          <input v-register="overlaid.register('tag')" />
        </label>
      </form>
      <pre>{{
        JSON.stringify(overlaid.values, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
    </section>

    <section>
      <h4><code>unset</code> on count</h4>
      <form class="stack" @submit.prevent>
        <label>
          notify
          <input v-register="blanked.register('notify')" type="checkbox" />
        </label>
        <label>
          <span>count <small v-if="blanked.fields.count.blank" class="blank">(blank)</small></span>
          <input v-register="blanked.register('count')" type="number" />
          <em v-if="blanked.fields.count.showErrors">{{
            blanked.fields.count.firstError?.message
          }}</em>
        </label>
        <label>
          tag
          <input v-register="blanked.register('tag')" />
        </label>
      </form>
      <pre>{{
        JSON.stringify(blanked.values, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
    </section>
  </div>
</template>

<style scoped>
  .demo .blank {
    color: var(--color-warning);
    font-size: 0.75rem;
    font-style: normal;
  }
</style>
