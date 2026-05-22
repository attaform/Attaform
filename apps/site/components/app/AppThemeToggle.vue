<script setup lang="ts">
  import { Sun, Moon, Monitor } from 'lucide-vue-next'

  type Pref = 'system' | 'light' | 'dark'
  const ORDER: readonly Pref[] = ['system', 'light', 'dark'] as const

  const colorMode = useColorMode()

  // Server doesn't know the user's stored preference, so during the
  // initial SSR + hydration pass render a neutral default (system /
  // Monitor) and swap to the real value post-mount. That avoids the
  // hydration mismatch a naive `colorMode.preference`-bound render
  // would produce.
  //
  // For SPA navigations (no SSR pass for the new component instance),
  // there's no DOM to match against — the first paint can show the
  // real preference directly, so the icon doesn't flash Monitor →
  // real every time the user changes layouts (`default.vue` ↔
  // `docs.vue` both render `<AppHeader>`).
  //
  // Both conditions must hold for "render the real label immediately"
  // to be safe: `import.meta.client` (we're not on the server) AND
  // `!nuxtApp.isHydrating` (we're not currently reconciling against
  // SSR markup). Either alone is wrong:
  //
  //   - Gating only on `!isHydrating` ships a real label from SSR
  //     (where `isHydrating === false` because there's nothing to
  //     hydrate yet) but a placeholder during initial hydration on
  //     the client (where `isHydrating === true`) — direct mismatch.
  //   - Gating only on `import.meta.client` would always render the
  //     placeholder on the client's first paint, including SPA nav
  //     mounts where there's no SSR markup at all, reintroducing
  //     the Monitor→real icon flash.
  //
  // The pair narrows to exactly: SSR + initial-hydration → placeholder
  // (matching DOM both ways), SPA-nav mount → real label, post-
  // hydration → real label.
  const nuxtApp = useNuxtApp()
  const mounted = ref(import.meta.client && !nuxtApp.isHydrating)
  onMounted(() => {
    mounted.value = true
  })

  const current = computed<Pref>(() => {
    if (!mounted.value) return 'system'
    return (colorMode.preference as Pref) ?? 'system'
  })

  function cycle() {
    const i = ORDER.indexOf(current.value)
    colorMode.preference = ORDER[(i + 1) % ORDER.length] ?? 'system'
  }

  const icon = computed(() => {
    if (current.value === 'light') return Sun
    if (current.value === 'dark') return Moon
    return Monitor
  })

  const label = computed(() => {
    if (!mounted.value) return 'Toggle theme'
    if (current.value === 'system') return 'Theme: system. Switch to light.'
    if (current.value === 'light') return 'Theme: light. Switch to dark.'
    return 'Theme: dark. Switch to system.'
  })
</script>

<template>
  <button
    type="button"
    :aria-label="label"
    :title="label"
    class="relative inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-md text-fg-muted transition-colors duration-(--duration-fast) ease-(--ease-out-quart) hover:bg-surface hover:text-fg focus-visible:ring-4 focus-visible:ring-accent-ring focus-visible:outline-none"
    @click="cycle"
  >
    <!-- Vue's <Transition> with mode="out-in" runs the leaver fully
         before the enterer starts. The `theme-spin` keyframes (in
         tailwind.css) rotate the leaving icon 90° clockwise off-stage
         while the entering icon arrives from -90°, meeting the eye
         at 0°. Result: the cycle reads as a single wheel turn rather
         than a swap. `:key="current"` forces Vue to swap component
         instances on each cycle so the transition fires; without it,
         Vue would just patch the icon's `is` and skip the choreography. -->
    <Transition name="theme-spin" mode="out-in">
      <component :is="icon" :key="current" class="h-4 w-4" aria-hidden="true" />
    </Transition>
  </button>
</template>
