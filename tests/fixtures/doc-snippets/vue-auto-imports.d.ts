// Ambient shim for the Vue reactivity helpers that docs SFC `<script setup>`
// blocks reach for without an explicit import, because Nuxt auto-imports them.
// Declaring them as globals keeps an extracted snippet honest about the
// `attaform` surface it exercises, without false-failing on an unimported
// `ref`. A block that DOES import these from `vue` simply shadows the global.
import type * as vue from 'vue'

declare global {
  const ref: typeof vue.ref
  const computed: typeof vue.computed
  const reactive: typeof vue.reactive
  const watch: typeof vue.watch
  const watchEffect: typeof vue.watchEffect
  const onMounted: typeof vue.onMounted
  const nextTick: typeof vue.nextTick
  const shallowRef: typeof vue.shallowRef
  const toRef: typeof vue.toRef
  const toRefs: typeof vue.toRefs
}

export {}
