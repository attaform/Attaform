<script setup lang="ts">
  import { onUpdated } from 'vue'
  import { recordRender } from '../../shared/render-count'
  import type { VuelidateField } from './types'

  /**
   * A Vuelidate field. Vuelidate is validation-only and model-based, so the
   * harness owns the input and binds it to the field's `$model` (the two-way model
   * that writes state and marks the field dirty). Reading `$model` subscribes to
   * this field alone, so it re-renders granularly.
   *
   * Vuelidate's validation is a lazy computed: it recomputes only when its result
   * is read. Binding `:aria-invalid` to `$error` reads it on every re-render, so
   * the per-keystroke validation actually runs and the latency reflects it. That
   * is also the idiomatic display path, since a real form surfaces error state.
   */
  const props = defineProps<{
    field: VuelidateField
    index: number
    trigger: 'input' | 'blur'
  }>()

  onUpdated(() => recordRender(props.index))

  function onInput(event: Event): void {
    props.field.$model = (event.target as HTMLInputElement).value
  }

  function onBlur(): void {
    if (props.trigger === 'blur') props.field.$touch()
  }
</script>

<template>
  <input
    :data-bench-field="index"
    :value="field.$model"
    :aria-invalid="field.$error"
    @input="onInput"
    @blur="onBlur"
  />
</template>
