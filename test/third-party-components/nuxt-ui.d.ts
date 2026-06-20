// Ambient shims for the Nuxt UI slice of the cross-library matrix
// (`nuxt-ui.cross.ts`). Plain `tsc` (what `pnpm typecheck` runs) cannot parse
// `.vue` single-file components, and Nuxt UI only ships its components as `.vue`.
// These narrow, glob-scoped declarations stub the component modules as generic
// Vue components so the surrounding test LOGIC is still fully type-checked,
// without dragging in `vue-tsc`. At runtime `@nuxt/ui/vite` (see
// `vitest.nuxt-ui.config.ts`) compiles the real components.
declare module '@nuxt/ui/components/*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, object, unknown>
  export default component
}
