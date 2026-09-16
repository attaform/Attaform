// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm as useZodForm } from '../../src/zod'
import { useAbstractForm } from '../../src/abstract'
import { fakeSchema } from '../utils/fake-schema'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Shared-key collision detection.
 *
 * Two `useForm({ key: 'x', schema })` calls resolve to the same
 * `FormStore` by design — the shared-store semantic. When the second
 * call's schema is structurally different from the first's, the library
 * emits a dev-mode `console.warn` showing both sketches. The second
 * call's schema is silently ignored in favour of the first's (matching
 * the existing "only first caller wires the state" behaviour).
 *
 * The comparison is a sketch taken over the public `AbstractSchema`
 * surface — accepted primitive kinds, requiredness, leaf-ness and tuple
 * arity at every path reachable from the schema's own default shape.
 * That is the same surface the form runtime itself walks, so the check
 * cannot disagree with the behaviour it is diagnosing. It replaced a
 * pair of per-adapter structural walkers, which could.
 *
 * NOTE: `injectForm()` (no key) emits a separate `console.warn`
 * lazily when it walks up to an ancestor that registered multiple
 * useForm() calls (covers the anonymous-forms footgun — see PR
 * #117). The fixtures here drive shared-store resolution by calling
 * `useForm()` twice with the same key in one component; that pattern
 * doesn't itself trigger the ambient warning (which now only fires
 * when a descendant consumes ambient context), but the filter on
 * `warnSpy.mock.calls` by marker stays as a defensive guard. The
 * mismatch-warning marker is `"use different schemas"` — unique to
 * this subsystem.
 */

const MISMATCH_WARN_MARKER = 'use different schemas'

type Form = { name: string }
const defaults: Form = { name: '' }

// The shared-key mismatch warning fires from an async path: the collision
// diagnostics live in a dev-only module loaded via dynamic import (so a
// prod build drops them), and the check is dispatched fire-and-forget.
// `beforeAll` warms that module so its import resolves from cache on a
// microtask; draining the timer queue here then lets the whole chain
// settle before asserting (or provably not, for the silent cases).
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('schema-mismatch shared-key warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeAll(async () => {
    // Warm the dev-only collision-warning module so each test's dynamic
    // import is a cached microtask rather than a first-load transform that
    // would land after `flushAsync`'s timer. A bundled app ships this chunk
    // ready to load; this mirrors that here.
    await import('../../src/runtime/core/dev-key-collision-warnings')
  })
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  const mismatchWarnCalls = (): readonly unknown[][] =>
    warnSpy.mock.calls.filter((args: readonly unknown[]) =>
      String(args[0] ?? '').includes(MISMATCH_WARN_MARKER)
    )

  function mountTwo(schemaA: z.ZodObject, schemaB: z.ZodObject, key = 'shared-form'): () => void {
    const App = defineComponent({
      setup() {
        useZodForm({ schema: schemaA, key })
        useZodForm({ schema: schemaB, key })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    return () => app.unmount()
  }

  it('stays silent for two separately-built schemas of the same shape', async () => {
    // Distinct instances, identical structure. This is the case that
    // makes reference identity useless as the test: two files declaring
    // the same shape must not warn about each other.
    const unmount = mountTwo(
      z.object({ name: z.string(), age: z.number() }),
      z.object({ name: z.string(), age: z.number() })
    )
    await flushAsync()
    expect(mismatchWarnCalls()).toHaveLength(0)
    unmount()
  })

  it('stays silent when the same keys are declared in a different order', async () => {
    const unmount = mountTwo(
      z.object({ name: z.string(), age: z.number() }),
      z.object({ age: z.number(), name: z.string() }),
      'order-form'
    )
    await flushAsync()
    expect(mismatchWarnCalls()).toHaveLength(0)
    unmount()
  })

  it('warns when the second call adds a field', async () => {
    const unmount = mountTwo(
      z.object({ name: z.string() }),
      z.object({ name: z.string(), age: z.number() }),
      'added-field-form'
    )
    await flushAsync()
    const calls = mismatchWarnCalls()
    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.[0] ?? '')).toContain('added-field-form')
    unmount()
  })

  it('warns when a shared field changes primitive type', async () => {
    const unmount = mountTwo(
      z.object({ id: z.string() }),
      z.object({ id: z.number() }),
      'retyped-form'
    )
    await flushAsync()
    expect(mismatchWarnCalls()).toHaveLength(1)
    unmount()
  })

  it('warns when a shared field changes requiredness', async () => {
    const unmount = mountTwo(
      z.object({ nickname: z.string() }),
      z.object({ nickname: z.string().optional() }),
      'optionality-form'
    )
    await flushAsync()
    expect(mismatchWarnCalls()).toHaveLength(1)
    unmount()
  })

  it('warns when a nested shape diverges below the root', async () => {
    // The sketch has to descend, not just compare top-level keys.
    const unmount = mountTwo(
      z.object({ user: z.object({ email: z.string() }) }),
      z.object({ user: z.object({ email: z.number() }) }),
      'nested-form'
    )
    await flushAsync()
    expect(mismatchWarnCalls()).toHaveLength(1)
    unmount()
  })

  it('catches a throwing adapter method and surfaces it in dev', async () => {
    // A custom adapter whose introspection throws is third-party code
    // running inside our walk. It must NOT crash the form lifecycle — we
    // allow the inconsistency and skip the mismatch check. In dev the
    // exception is logged via console.error so the adapter bug is
    // visible; no mismatch warning fires because the comparison never ran.
    //
    // Schema-embedded consumer functions (a `.default(() => { throw })`
    // factory) do NOT reach here: `consumer-code.ts` contains those at
    // the point of invocation, so the walk sees a fallback value and
    // compares normally. This catch is the backstop for the SPI surface,
    // which has no such containment.
    const thrown = new Error('adapter bug')
    const throwing = fakeSchema<Form>(defaults)
    throwing.getSlimPrimitiveTypesAtPath = () => {
      throw thrown
    }
    const App = defineComponent({
      setup() {
        useAbstractForm<Form>({ schema: throwing, key: 'throwing-form' })
        useAbstractForm<Form>({ schema: fakeSchema<Form>(defaults), key: 'throwing-form' })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await flushAsync()
    expect(mismatchWarnCalls()).toHaveLength(0)
    const skipped = errorSpy.mock.calls.filter((args: readonly unknown[]) =>
      String(args[0] ?? '').includes('skipping mismatch check')
    )
    expect(skipped).toHaveLength(1)
    expect(String(skipped[0]?.[0] ?? '')).toContain('throwing-form')
    expect(skipped[0]?.[1]).toBe(thrown)
    app.unmount()
  })

  it('no false positive on shared key with a zod factory default', async () => {
    // The trap that shaped the whole design. `.default(() => new Date())`
    // mints a fresh value per call, so any comparison that reads default
    // VALUES makes a schema disagree with itself a millisecond later and
    // warns about a form against itself. The sketch reads kinds, never
    // values, so it is immune by construction rather than by a special
    // case. Pinned because a future "make the sketch more precise" change
    // is exactly how this comes back.
    const schema = z.object({ created: z.date().default(() => new Date()) })
    const unmount = mountTwo(schema, schema, 'factory-default-form')
    await flushAsync()
    expect(mismatchWarnCalls()).toHaveLength(0)
    unmount()
  })

  it('no false positive for two separate schemas that both use factory defaults', async () => {
    const unmount = mountTwo(
      z.object({ created: z.date().default(() => new Date()) }),
      z.object({ created: z.date().default(() => new Date()) }),
      'twin-factory-form'
    )
    await flushAsync()
    expect(mismatchWarnCalls()).toHaveLength(0)
    unmount()
  })
})
