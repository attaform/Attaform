<script setup lang="ts">
  import { onUpdated } from 'vue'
  import { recordRender } from '../../shared/render-count'
  import type { RegleField } from './types'

  /**
   * A Regle field. Regle is validation-only, so the harness owns the input and
   * binds it to the field status's `$value` (the model reference Regle exposes for
   * v-model). Reading `$value` subscribes to this field alone, so it re-renders
   * granularly; assigning it marks the field dirty and runs Regle's reactive
   * validation: a whole-schema re-parse in schema mode, this field's rules in
   * rules mode. The same component serves both modes because the binding is
   * identical; only the engine behind `r$` differs.
   */
  const props = defineProps<{
    field: RegleField
    index: number
    trigger: 'input' | 'blur'
  }>()

  onUpdated(() => recordRender(props.index))

  function onInput(event: Event): void {
    props.field.$value = (event.target as HTMLInputElement).value
  }

  function onBlur(): void {
    if (props.trigger === 'blur') props.field.$touch()
  }
</script>

<template>
  <input :data-bench-field="index" :value="field.$value" @input="onInput" @blur="onBlur" />
</template>
