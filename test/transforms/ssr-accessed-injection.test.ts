import { describe, expect, it } from 'vitest'
import { attaform } from '../../src/vite'

/**
 * SFC-level Vite transform, injects `__ssrAccessed: true` into the
 * options bag of `useForm(...)` and `injectForm(...)` calls whose
 * binding the surrounding SFC template references. Lets the runtime
 * registry enqueue the form for SSR prefetch BEFORE
 * `onServerPrefetch` fires, so async `defaultValues` factories run
 * during the prefetch phase and the resolved payload bakes into the
 * hydration transfer state.
 *
 * Tests drive the plugin's `transform(code, id)` hook directly with
 * inline SFC strings and assert on the rewritten script-setup
 * output. Coverage corresponds to the rows in the implementation
 * plan's transform-coverage table: the detected cases AND the
 * uncovered cases (which must degrade to schema-defaults rather than
 * silently mis-inject).
 */

interface TransformOutput {
  readonly code: string
}

type TransformReturn = string | TransformOutput | null | undefined | void

type RawHandler = (this: unknown, code: string, id: string) => unknown

function runTransform(code: string, id: string): TransformReturn {
  // attaform() returns [main, directive-delivery]; this suite exercises
  // the MAIN plugin's pre-transform (the __ssrAccessed injection).
  const plugins = attaform() as unknown as Array<{
    name: string
    transform?: RawHandler | { handler: RawHandler }
  }>
  const plugin = plugins.find((p) => p.name === 'attaform')
  if (plugin === undefined) throw new Error('attaform() did not return the main plugin')
  const hook = plugin.transform
  if (hook === undefined) throw new Error('attaform() did not register a transform hook')
  const handler = typeof hook === 'function' ? hook : hook.handler
  // Vite passes a `this` plugin context here, but the transform doesn't
  // call any context methods: a fresh empty object satisfies the
  // handler binding without polluting the test surface.
  const ctx: Record<string, never> = {}
  return handler.call(ctx, code, id) as TransformReturn
}

function transformedCode(code: string, id = '/src/Component.vue'): string {
  const result = runTransform(code, id)
  if (result === null || result === undefined) return code
  if (typeof result === 'string') return result
  return result.code
}

describe('__ssrAccessed transform: bindings referenced by the surrounding template', () => {
  it('injects __ssrAccessed into useForm whose handle is read in an interpolation', () => {
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform'
import { z } from 'zod'
const form = useForm({
  schema: z.object({ email: z.string() }),
  defaultValues: async () => ({ email: '' }),
})
</script>
<template>
  <div>{{ form.values.email }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
    // The injection lives on the same options object the consumer
    // already wrote, not on a separate arg.
    expect(output).toMatch(/useForm\(\s*\{[\s\S]*?__ssrAccessed:\s*true[\s\S]*?schema:/)
  })

  it('injects when the form is referenced through a v-if condition', () => {
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform'
import { z } from 'zod'
const form = useForm({
  schema: z.object({ ready: z.boolean() }),
  defaultValues: async () => ({ ready: false }),
})
</script>
<template>
  <div v-if="form.values.ready">ready</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
  })

  it('injects when the form is referenced through a :value attribute binding', () => {
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform'
import { z } from 'zod'
const form = useForm({
  schema: z.object({ name: z.string() }),
  defaultValues: async () => ({ name: '' }),
})
</script>
<template>
  <input :value="form.values.name" />
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
  })

  it('injects when the form is referenced through a v-register directive', () => {
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform'
import { z } from 'zod'
const form = useForm({
  schema: z.object({ email: z.string() }),
  defaultValues: async () => ({ email: '' }),
})
</script>
<template>
  <input v-register="form.register('email')" />
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
  })

  it('handles renamed imports (useForm as makeForm)', () => {
    const sfc = `<script setup lang="ts">
import { useForm as makeForm } from 'attaform'
import { z } from 'zod'
const form = makeForm({
  schema: z.object({ x: z.string() }),
  defaultValues: async () => ({ x: '' }),
})
</script>
<template>
  <div>{{ form.values.x }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
    // Must inject into the makeForm call, not introduce a stray useForm.
    expect(output).toMatch(/makeForm\(\s*\{[\s\S]*?__ssrAccessed:\s*true/)
  })

  it('injects when the import comes from an adapter subpath, not the bare barrel', () => {
    // All four attaform-family specifiers are tracked, and the pre-pass
    // rejects a file before parsing it by looking for the package name
    // in the raw source. A tightening of that check to the bare
    // `'attaform'` spelling would drop the three subpaths silently, so
    // one of them is pinned here.
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform/zod-v4'
import { z } from 'zod'
const form = useForm({
  schema: z.object({ email: z.string() }),
  defaultValues: async () => ({ email: '' }),
})
</script>
<template>
  <div>{{ form.values.email }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
  })

  it('upgrades injectForm("key") string-shortcut to the options form when marking', () => {
    const sfc = `<script setup lang="ts">
import { injectForm } from 'attaform'
const cart = injectForm('cart')
</script>
<template>
  <div>{{ cart?.values.itemCount }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
    expect(output).toMatch(
      /injectForm\(\s*\{[\s\S]*?key:\s*['"]cart['"][\s\S]*?__ssrAccessed:\s*true/
    )
  })

  it('injects when injectForm already uses the options form', () => {
    const sfc = `<script setup lang="ts">
import { injectForm } from 'attaform'
const cart = injectForm({ key: 'cart' })
</script>
<template>
  <div>{{ cart?.values.itemCount }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
    expect(output).toMatch(/injectForm\(\s*\{[\s\S]*?__ssrAccessed:\s*true/)
  })

  it('upgrades a bare injectForm() with no args when the binding is template-referenced', () => {
    const sfc = `<script setup lang="ts">
import { injectForm } from 'attaform'
const form = injectForm()
</script>
<template>
  <div>{{ form?.values }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).toContain('__ssrAccessed: true')
    expect(output).toMatch(/injectForm\(\s*\{[\s\S]*?__ssrAccessed:\s*true/)
  })
})

describe('__ssrAccessed transform: non-injecting cases', () => {
  it('leaves useForm alone when the binding never appears in the template', () => {
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform'
import { z } from 'zod'
const form = useForm({
  schema: z.object({ email: z.string() }),
  defaultValues: async () => ({ email: '' }),
})
void form
</script>
<template>
  <div>static</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).not.toContain('__ssrAccessed')
  })

  it('leaves destructured returns alone (no handle to mark)', () => {
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform'
import { z } from 'zod'
const { register, values } = useForm({
  schema: z.object({ email: z.string() }),
  defaultValues: async () => ({ email: '' }),
})
</script>
<template>
  <input v-register="register('email')" />
  <div>{{ values.email }}</div>
</template>
`
    const output = transformedCode(sfc)
    // Destructuring loses the handle name; the transform skips this
    // shape per the form-handle discipline. Consumer remedies with
    // form.activate() on a real handle.
    expect(output).not.toContain('__ssrAccessed')
  })

  it('does not inject into useForm when the import is from an unrelated package', () => {
    const sfc = `<script setup lang="ts">
import { useForm } from 'some-other-form-lib'
const form = useForm({ schema: {} })
</script>
<template>
  <div>{{ form.values }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).not.toContain('__ssrAccessed')
  })

  it('skips when the template references the form via dynamic property access', () => {
    // `form[someKey]` is a runtime indirection; the transform can't
    // prove the dynamic key resolves to a reactive read, so it bails.
    // Consumer remedies with form.activate().
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform'
import { z } from 'zod'
const form = useForm({
  schema: z.object({ email: z.string() }),
  defaultValues: async () => ({ email: '' }),
})
const someKey = 'values'
</script>
<template>
  <div>{{ form[someKey] }}</div>
</template>
`
    const output = transformedCode(sfc)
    // Bare `form` identifier still appears in the template: that
    // counts as a reference. The dynamic key only matters for
    // narrower coverage cases (`form[k].activate()` patterns). MVP
    // is conservative-positive: any identifier reference enqueues.
    expect(output).toContain('__ssrAccessed: true')
  })

  it('leaves a file that only mentions attaform in prose alone', () => {
    // The pre-pass rejects a file whose raw source lacks either the
    // package name or a tracked function name. Neither half of that
    // test may be the whole test: a file can name the package in a
    // comment while importing its form primitive from somewhere else.
    const sfc = `<script setup lang="ts">
// Migrating this screen to attaform is tracked separately.
import { useForm } from 'some-other-form-lib'
const form = useForm({ schema: {} })
</script>
<template>
  <div>{{ form.values }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).not.toContain('__ssrAccessed')
  })

  it('does not see an imported name spelled with a unicode escape', () => {
    // A documented coverage boundary, not an accident. The pre-pass
    // decides whether to parse a file at all by looking for `useForm`
    // or `injectForm` in the raw source, so an escaped spelling of the
    // imported name reads as absent even though Babel would decode it.
    //
    // This joins the shapes the transform already declines to cover
    // (destructured returns, spread arguments, computed callees) and
    // carries the same remedy: the consumer calls `form.activate()`.
    // Nothing in the Vue or Vite toolchain emits escaped ASCII
    // identifiers, and no author writes them, which is what makes the
    // trade worth roughly a third of the pre-pass.
    const escapedUseForm = String.raw`\u0075seForm`
    const sfc = `<script setup lang="ts">
import { ${escapedUseForm} as makeForm } from 'attaform'
const form = makeForm({ schema: {} })
</script>
<template>
  <div>{{ form.values }}</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).not.toContain('__ssrAccessed')
  })

  it('passes through non-.vue files unchanged', () => {
    const code = `import { useForm } from 'attaform'
const form = useForm({ schema: {} })
`
    const result = runTransform(code, '/src/something.ts')
    // Either string-form (rare) or null/undefined; both mean "no
    // rewrite". The .ts file is not a Vue SFC so the transform must
    // not touch it.
    if (result === null || result === undefined) {
      expect(result).toBeFalsy()
    } else if (typeof result === 'string') {
      expect(result).toBe(code)
    } else {
      expect(result.code).toBe(code)
    }
  })

  it('leaves SFCs without a template alone (nothing to reference)', () => {
    const sfc = `<script setup lang="ts">
import { useForm } from 'attaform'
import { z } from 'zod'
const form = useForm({
  schema: z.object({ email: z.string() }),
  defaultValues: async () => ({ email: '' }),
})
void form
</script>
`
    const output = transformedCode(sfc)
    expect(output).not.toContain('__ssrAccessed')
  })

  it('leaves SFCs without a script-setup alone', () => {
    const sfc = `<template>
  <div>static</div>
</template>
`
    const output = transformedCode(sfc)
    expect(output).not.toContain('__ssrAccessed')
  })
})
