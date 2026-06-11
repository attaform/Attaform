<script setup lang="ts">
  import { useField } from '@formisch/vue'
  import { onUpdated } from 'vue'
  import { recordRender } from '../../shared/render-count'
  import type { FormischField } from './types'

  /**
   * A formisch array row. formisch hands each row a stable key (the parent keys
   * the v-for by it), so a reorder moves the DOM node. The row therefore binds to
   * its CURRENT positional path through a getter config: useField takes a
   * `MaybeRefOrGetter`, so re-deriving the array path from `props.path` re-points
   * the field when a reorder moves this row to a new slot. The flat field caches
   * its path in setup, which an identity-keyed reorderable row cannot.
   */
  const props = defineProps<{
    form: unknown
    path: string
    index: number
    trigger: 'input' | 'blur'
  }>()

  onUpdated(() => recordRender(props.index))

  const field = useField(
    props.form as never,
    (() => ({
      path: props.path.split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg)),
    })) as never
  ) as unknown as FormischField

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
