<script setup lang="ts">
  import { useField } from 'vee-validate'
  import { onUpdated } from 'vue'
  import { recordRender } from '../../shared/render-count'

  /**
   * A vee-validate field through its per-field-component composition API.
   * `useField` injects the form context the host's `useForm` provides and
   * returns a granular value ref plus a change handler scoped to this path, so
   * the field re-renders only when its own value changes.
   *
   * The whole zod schema validates on each change. That is inherent to driving a
   * single typed schema (the recommended, fastest-correct zod setup), not a
   * strawman; the keystroke latency captures that cost honestly.
   */
  const props = defineProps<{ name: string; index: number; trigger: 'input' | 'blur' }>()

  const { value, handleChange, validate } = useField<string>(() => props.name, undefined, {
    validateOnValueUpdate: props.trigger === 'input',
  })

  onUpdated(() => recordRender(props.index))

  function onInput(event: Event): void {
    handleChange((event.target as HTMLInputElement).value, props.trigger === 'input')
  }

  function onBlur(): void {
    if (props.trigger === 'blur') void validate()
  }
</script>

<template>
  <input :data-bench-field="index" :value="value" @input="onInput" @blur="onBlur" />
</template>
