<script setup lang="ts">
  // No attaform import lines: every composable referenced below is
  // auto-imported by attaform/nuxt. If the module failed to register any
  // of them, this component would fail to compile or ReferenceError
  // during SSR, and the e2e assertions would never see their markers.
  //
  // Adding a manifest entry? Run `pnpm dev:prepare` before `pnpm lint`.
  // eslint.config.js sources its Nuxt globals from the docs site's
  // generated apps/site/.nuxt/imports.d.ts, so a stale copy reports the
  // new name as `no-undef` here rather than where the staleness is. CI
  // never sees it: matrix.yml runs dev:prepare ahead of lint.
  import { z } from 'zod'

  const schema = z.object({ greeting: z.string().default('auto-import-ok') })
  const form = useForm({ schema, key: 'auto-import-probe' })

  // The non-throwing ancestor lookup with no provider present.
  const parent = injectForm()

  // Reference the rest of the auto-imported surface so a missing
  // registration surfaces here. A name that is not auto-imported at all
  // would ReferenceError during SSR (500); a name that is injected but is
  // not a real export of attaform/zod would resolve to `undefined`. Both
  // are caught. Note `fieldMeta` is a registry object, not a function
  // (used as `schema.register(fieldMeta, payload)`), so this checks for a
  // defined binding rather than a callable. `useRegister` is referenced
  // and not called: calling it outside a `v-register` host is the
  // no-parent case it warns about, and the binding is what #573 was
  // about.
  const surface: Record<string, unknown> = {
    useForm,
    useWizard,
    injectForm,
    injectWizard,
    fieldMeta,
    withMeta,
    lazy,
    gate,
    useRegister,
  }
  const missing = Object.keys(surface).filter((k) => surface[k] === undefined)
  const allResolved = missing.length === 0
</script>

<template>
  <div>
    <span id="probe-greeting">{{ form.values.greeting }}</span>
    <span id="probe-parent">{{ parent ? 'has-parent' : 'no-parent' }}</span>
    <span id="probe-surface">{{
      allResolved ? 'all-composables-resolved' : `missing-composable:${missing.join(',')}`
    }}</span>
  </div>
</template>
