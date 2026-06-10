<script setup lang="ts">
  import { onUpdated } from 'vue'
  import { recordRender } from '../../shared/render-count'
  import type { AttaformForm } from './types'

  /**
   * An Attaform field, wired the way the `v-register` directive wires one: the
   * granular `register(path).displayValue` drives `:value` (exactly the string
   * the compile-time `:value` injection reads), and the public `setValue` funnel
   * takes the keystroke (the same funnel the directive's input listener and the
   * render-isolation lock test drive). Reading `displayValue` and writing
   * `setValue` is runtime-equivalent to the directive, so the measured keystroke
   * and render-scope figures are Attaform's real ones, with no compiler-plugin
   * magic in the harness.
   *
   * The keystroke cost reflects Attaform's subtree-scoped validation: under
   * `validateOn: 'change'` with no root refine, a write validates only the
   * changed leaf, not the whole form.
   */
  const props = defineProps<{
    form: AttaformForm
    path: string
    index: number
    trigger: 'input' | 'blur'
  }>()

  // register() returns a fresh binding per call; call once and reuse the
  // granular read.
  const rv = props.form.register(props.path)

  // One-line render-scope instrumentation: fires once per re-render, off the
  // reactive path. The template reads only `rv.displayValue`, so this field
  // re-renders solely when its own value changes.
  onUpdated(() => recordRender(props.index))

  function onInput(event: Event): void {
    props.form.setValue(props.path, (event.target as HTMLInputElement).value)
  }

  function onBlur(): void {
    if (props.trigger === 'blur') props.form.validate(props.path)
  }
</script>

<template>
  <input :data-bench-field="index" :value="rv.displayValue.value" @input="onInput" @blur="onBlur" />
</template>
