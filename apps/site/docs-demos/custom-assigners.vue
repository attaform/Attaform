<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { assignKey, type CustomDirectiveRegisterAssignerFn } from 'attaform'
  import { z } from 'zod'
  import { onMounted, useTemplateRef } from 'vue'

  const form = useForm({
    schema: z.object({
      color: z.string(),
    }),
    defaultValues: { color: '#2563eb' },
    key: 'docs-demo-custom-assigners',
  })

  const swatches = ['#2563eb', '#16a34a', '#dc2626', '#f59e0b', '#a855f7']

  // Widget element — a faux color picker that stores its currently
  // picked color in dataset, dispatches a plain `input` event when
  // it changes. The default v-register extractor reads `el.value`,
  // which doesn't exist here. A custom assigner reads the value off
  // dataset instead and writes it to form state.
  const widgetEl = useTemplateRef<HTMLDivElement>('widget')

  const colorAssigner: CustomDirectiveRegisterAssignerFn = (_value, rv) => {
    const el = widgetEl.value
    if (!el || !rv) return false
    rv.setValueWithInternalPath(el.dataset.color ?? '')
    return true
  }

  onMounted(() => {
    const el = widgetEl.value
    if (!el) return
    ;(el as HTMLDivElement & { [k: symbol]: CustomDirectiveRegisterAssignerFn })[assignKey] =
      colorAssigner
  })

  function pickColor(c: string) {
    const el = widgetEl.value
    if (!el) return
    el.dataset.color = c
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
</script>

<template>
  <form @submit.prevent>
    <span class="label">Pick a color (no &lt;input&gt; — a custom widget)</span>
    <div
      ref="widget"
      v-register="form.register('color')"
      class="widget"
      :data-color="form.values.color"
    >
      <button
        v-for="c in swatches"
        :key="c"
        type="button"
        :style="{ background: c }"
        :aria-pressed="form.values.color === c"
        @click="pickColor(c)"
      />
    </div>

    <pre>form.values.color = {{ JSON.stringify(form.values.color) }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 26rem;
  }
  .label {
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .widget {
    display: flex;
    gap: 0.5rem;
    padding: 0.6rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    background: #fff;
  }
  .widget button {
    width: 2rem;
    height: 2rem;
    border-radius: 9999px;
    border: 2px solid transparent;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }
  .widget button[aria-pressed='true'] {
    border-color: #111827;
  }
  pre {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #111827;
    margin: 0;
  }
</style>
