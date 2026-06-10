<script setup lang="ts">
  import { useField } from '@formisch/vue'
  import { onUpdated } from 'vue'
  import { recordRender } from '../../shared/render-count'
  import type { FormischField } from './types'

  /**
   * A formisch field through the `useField` composable (formisch's `<Field>`
   * render-prop is a wrapper over it). Binding `:value` to the reactive `input`
   * getter makes the field controlled and granular: it re-renders only when its
   * own value changes. Assigning `input` runs formisch's input-mode validation,
   * so under the input-trigger pass the keystroke latency captures the valibot
   * parse for this field.
   */
  const props = defineProps<{
    form: unknown
    path: string
    index: number
    trigger: 'input' | 'blur'
  }>()

  // formisch addresses fields by an array path (['a', 0, 'b']); the harness's
  // dotted path maps to it, numeric segments coerced to array indices. useField
  // takes the form store directly; the dynamic schema collapses its path
  // generics, so the args are cast through to the call.
  const fieldPath = props.path.split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg))
  const field = useField(
    props.form as never,
    { path: fieldPath } as never
  ) as unknown as FormischField

  onUpdated(() => recordRender(props.index))

  function onInput(event: Event): void {
    field.input = (event.target as HTMLInputElement).value
  }

  function onBlur(): void {
    if (props.trigger === 'blur') field.props.onBlur()
  }
</script>

<template>
  <input :data-bench-field="index" :value="field.input" @input="onInput" @blur="onBlur" />
</template>
