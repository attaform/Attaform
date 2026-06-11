<script setup lang="ts">
  import { computed, onUpdated } from 'vue'
  import { recordRender } from '../../shared/render-count'
  import type { AttaformForm } from './types'

  /**
   * An Attaform array row, wired the way the canonical `form.list` demo wires
   * one: the row is keyed by its stable `row.key` (set by the parent v-for), and
   * the input registers the CURRENT positional path. Re-deriving the binding
   * from `props.path` on each render is exactly what the `v-register` directive
   * does, so when a reorder moves this keyed row to a new slot, it rebinds to the
   * new `rows.${i}.v` and shows that slot's value. The cached-in-setup binding of
   * the flat/nested field would go stale across a reorder; an array row cannot.
   */
  const props = defineProps<{
    form: AttaformForm
    path: string
    index: number
    trigger: 'input' | 'blur'
  }>()

  onUpdated(() => recordRender(props.index))

  const displayValue = computed(() => props.form.register(props.path).displayValue.value)

  function onInput(event: Event): void {
    props.form.setValue(props.path, (event.target as HTMLInputElement).value)
  }

  function onBlur(): void {
    if (props.trigger === 'blur') props.form.validate(props.path)
  }
</script>

<template>
  <input :data-bench-field="index" :value="displayValue" @input="onInput" @blur="onBlur" />
</template>
