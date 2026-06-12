<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { assignKey, type CustomDirectiveRegisterAssignerFn } from 'attaform'
  import { z } from 'zod'
  import { onMounted, useTemplateRef } from 'vue'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      color: z.string(),
    }),
    defaultValues: { color: '#2563eb' },
    key: 'docs-demo-custom-assigners',
  })

  const swatches = ['#2563eb', '#16a34a', '#dc2626', '#f59e0b', '#a855f7']

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
  <form class="demo" @submit.prevent>
    <span class="label">Pick a color (no &lt;input&gt;, just a custom widget)</span>
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
  .label {
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .widget {
    display: flex;
    gap: 0.5rem;
    padding: 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    background: var(--color-bg);
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
    border-color: var(--color-fg);
  }
</style>
