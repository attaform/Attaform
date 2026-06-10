<script setup lang="ts">
  import { useField } from '@tanstack/vue-form'
  import { onUpdated } from 'vue'
  import { recordRender } from '../../shared/render-count'
  import type { TanstackField, TanstackForm } from './types'

  /**
   * A TanStack field through the `useField` composable: TanStack's first-class
   * primitive for a custom field component (the `form.Field` render-prop is a thin
   * wrapper over this exact call). useField subscribes to a granular slice of the
   * form store keyed to this path, so the field re-renders only when its own value
   * changes. The form-level `onChange` validator (the schema, attached as a
   * Standard Schema, which is the recommended setup) runs on every edit; the
   * keystroke latency captures that whole-schema pass honestly.
   */
  const props = defineProps<{
    form: TanstackForm
    name: string
    index: number
    trigger: 'input' | 'blur'
  }>()

  // useField takes the form instance directly (no provide/inject). The dynamic
  // schema collapses its generics, so the opts are cast through to the call.
  const field = useField({
    form: props.form,
    name: props.name,
  } as never) as unknown as TanstackField

  onUpdated(() => recordRender(props.index))

  function onInput(event: Event): void {
    field.api.handleChange((event.target as HTMLInputElement).value)
  }

  // Always funnel through handleBlur; whether a blur validates is decided by the
  // adapter's validator config (onBlur attached only on the blur-trigger pass).
  function onBlur(): void {
    field.api.handleBlur()
  }
</script>

<template>
  <input :data-bench-field="index" :value="field.state.value" @input="onInput" @blur="onBlur" />
</template>
