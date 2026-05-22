// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { unset, useForm } from '../../src/zod'
import type { UseFormConfigV4 } from '../../src/zod'
import { canonicalizePath } from '../../src/runtime/core/paths'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * Public API coverage for the `unset` symbol — declarative
 * (`defaultValues: { x: unset }`) and imperative
 * (`setValue('x', unset)`, `reset({ x: unset })`). Plus the bulk
 * `form.blankPaths` introspection accessor and the per-field
 * `getFieldState(...).value.blank` view.
 */

function setupForm<F extends z.ZodObject<Record<string, z.ZodType>>>(
  schema: F,
  defaultValues?: UseFormConfigV4<F>['defaultValues']
) {
  let captured!: UseFormReturnType<z.output<F> & Record<string, unknown>>
  const Probe = defineComponent({
    setup() {
      captured = useForm({
        schema,
        key: `te-${Math.random().toString(36).slice(2)}`,
        ...(defaultValues !== undefined ? { defaultValues } : {}),
      }) as unknown as UseFormReturnType<z.output<F> & Record<string, unknown>>
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  return { app, form: captured }
}

describe('defaultValues with `unset`', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('numeric leaf: storage holds the slim default, set is populated', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }), { count: unset })
    apps.push(app)
    expect(form.values.count).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
  })

  it('string leaf: storage is "", set is populated', () => {
    const { app, form } = setupForm(z.object({ name: z.string() }), { name: unset })
    apps.push(app)
    expect(form.values.name).toBe('')
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(true)
  })

  it('boolean leaf: storage is false, set is populated', () => {
    const { app, form } = setupForm(z.object({ agreed: z.boolean() }), { agreed: unset })
    apps.push(app)
    expect(form.values.agreed).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('agreed').key)).toBe(true)
  })

  it('multiple leaves can be marked', () => {
    const { app, form } = setupForm(z.object({ income: z.number(), name: z.string() }), {
      income: unset,
      name: unset,
    })
    apps.push(app)
    expect(form.blankPaths.value.size).toBe(2)
  })

  it('nested leaves are marked at their canonical paths', () => {
    const { app, form } = setupForm(
      z.object({ user: z.object({ name: z.string(), age: z.number() }) }),
      { user: { name: unset, age: unset } }
    )
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('user.name').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('user.age').key)).toBe(true)
  })

  it('mixed marked and unmarked leaves coexist', () => {
    const { app, form } = setupForm(z.object({ income: z.number(), name: z.string() }), {
      income: unset,
      name: 'alice',
    })
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('income').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(false)
    expect(form.values.name).toBe('alice')
  })

  // Reproduces the bug surfaced by the /docs/schemas/defaults demo:
  // `defaultValues: { count: unset }` against `z.number().default(10)`
  // should write the slim/blank primitive (`0`) and mark the path
  // blank, NOT honor the schema's `.default(10)`. `defaultValues` is
  // the higher-priority surface, and `unset` is the user's explicit
  // "blank this leaf" signal — the schema's declared default is
  // intentionally bypassed (see `getEmptyValueAtPath` docblock in
  // types-api.ts).
  it('unset overrides z.number().default(N) with slim 0', () => {
    const { app, form } = setupForm(z.object({ count: z.number().default(10) }), { count: unset })
    apps.push(app)
    expect(form.values.count).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
  })

  it('unset overrides z.string().default("...") with slim ""', () => {
    const { app, form } = setupForm(z.object({ tag: z.string().default('untitled') }), {
      tag: unset,
    })
    apps.push(app)
    expect(form.values.tag).toBe('')
    expect(form.blankPaths.value.has(canonicalizePath('tag').key)).toBe(true)
  })

  it('unset overrides z.boolean().default(true) with slim false', () => {
    const { app, form } = setupForm(z.object({ notify: z.boolean().default(true) }), {
      notify: unset,
    })
    apps.push(app)
    expect(form.values.notify).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('notify').key)).toBe(true)
  })
})

describe('setValue(path, unset)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('marks the path and writes the slim default', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }))
    apps.push(app)
    form.setValue('count', 99)
    expect(form.blankPaths.value.size).toBe(0)

    form.setValue('count', unset)
    expect(form.values.count).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
  })

  it('subsequent regular write removes the path', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }))
    apps.push(app)
    form.setValue('count', unset)
    expect(form.blankPaths.value.size).toBe(1)

    form.setValue('count', 42)
    expect(form.blankPaths.value.size).toBe(0)
    expect(form.values.count).toBe(42)
  })

  it('callback returning unset is translated', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }))
    apps.push(app)
    form.setValue('count', 5)
    form.setValue('count', () => unset)
    expect(form.values.count).toBe(0)
    expect(form.blankPaths.value.size).toBe(1)
  })

  // setValue + unset shares the same translation pipeline as
  // defaultValues + unset (substituteUnsetSentinels). The contract is
  // identical: the schema's declared `.default(N)` is bypassed in
  // favor of the type's slim/blank primitive.
  it('unset overrides z.number().default(N) with slim 0 on setValue', () => {
    const { app, form } = setupForm(z.object({ count: z.number().default(10) }))
    apps.push(app)
    form.setValue('count', 99)
    form.setValue('count', unset)
    expect(form.values.count).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
  })

  it('unset overrides z.string().default("...") with slim "" on setValue', () => {
    const { app, form } = setupForm(z.object({ tag: z.string().default('untitled') }))
    apps.push(app)
    form.setValue('tag', 'work-in-progress')
    form.setValue('tag', unset)
    expect(form.values.tag).toBe('')
    expect(form.blankPaths.value.has(canonicalizePath('tag').key)).toBe(true)
  })
})

describe('reset(args) with unset', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('reset({ x: unset }) marks the path post-reset', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }))
    apps.push(app)
    form.setValue('count', 42)
    expect(form.blankPaths.value.size).toBe(0)

    form.reset({ count: unset })
    expect(form.values.count).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
    // Dirty resets to false: the new baseline is "blank for this path".
    expect(form.meta.dirty).toBe(false)
  })

  // reset + unset routes through the same translation pipeline; the
  // schema's declared `.default(N)` is bypassed in favor of the
  // slim/blank primitive.
  it('reset({ count: unset }) overrides z.number().default(N) with slim 0', () => {
    const { app, form } = setupForm(z.object({ count: z.number().default(10) }))
    apps.push(app)
    form.setValue('count', 42)

    form.reset({ count: unset })
    expect(form.values.count).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
  })
})

describe('getFieldState meta.blank + flat blank', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('reports blank for a path marked via defaultValues', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }), { count: unset })
    apps.push(app)
    const fs = form.fields.count
    expect((fs as unknown as { blank: boolean }).blank).toBe(true)
  })

  it('flips back to false after a real write', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }), { count: unset })
    apps.push(app)
    form.setValue('count', 5)
    const fs = form.fields.count
    expect((fs as unknown as { blank: boolean }).blank).toBe(false)
  })
})

describe('form.blankPaths bulk accessor', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('returns a readonly snapshot — consumers cannot mutate', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }), { count: unset })
    apps.push(app)
    const snapshot = form.blankPaths.value
    // The snapshot is a Proxy that traps add / delete / clear so
    // consumers can't pollute the cached view. `Object.isFrozen` is
    // not a meaningful test here: frozen Sets remain mutable, so the
    // real protection is the runtime throw on the mutating methods.
    expect(() => (snapshot as unknown as Set<string>).add('foo')).toThrow(TypeError)
    expect(() => (snapshot as unknown as Set<string>).delete('count')).toThrow(TypeError)
    expect(() => (snapshot as unknown as Set<string>).clear()).toThrow(TypeError)
  })

  it('reflects marks and unmarks reactively', () => {
    // Explicit defaults so the bulk view starts at size 0; the unspecified-
    // leaf auto-mark covered separately in the auto-mark suite below.
    const { app, form } = setupForm(z.object({ count: z.number() }), { count: 0 })
    apps.push(app)
    expect(form.blankPaths.value.size).toBe(0)
    form.setValue('count', unset)
    expect(form.blankPaths.value.size).toBe(1)
    form.setValue('count', 5)
    expect(form.blankPaths.value.size).toBe(0)
  })
})

describe('auto-mark: unspecified numeric leaves are blank on construction', () => {
  // Rationale: numeric primitives (`number`, `bigint`) have a
  // genuine storage / display divergence — storage is forced to `0`
  // / `0n` while the DOM input shows `''`, so the runtime needs the
  // `blank` side-channel to tell "user typed 0" from "user supplied
  // nothing." Strings and booleans don't have this divergence (`''`
  // / `false` match what the DOM shows natively), so they are NOT
  // auto-marked — the schema is the authority on whether `''` /
  // `false` is acceptable. See `docs/blank.md` for the conceptual
  // model. Explicit `unset` opts ANY primitive in regardless of type.
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('z.string() leaf is NOT auto-marked at mount', () => {
    const { app, form } = setupForm(z.object({ email: z.string() }))
    apps.push(app)
    // Storage `''` matches DOM `''` — no side-channel needed; the
    // schema (`z.string()`) accepts `''` and the library doesn't
    // override that verdict.
    expect(form.blankPaths.value.has(canonicalizePath('email').key)).toBe(false)
    expect(form.blankPaths.value.size).toBe(0)
  })

  it('marks numeric leaves only when defaultValues is omitted entirely', () => {
    const { app, form } = setupForm(
      z.object({ name: z.string(), age: z.number(), agreed: z.boolean() })
    )
    apps.push(app)
    // String / boolean: storage matches DOM; no auto-mark.
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('agreed').key)).toBe(false)
    // Number: storage `0` ≠ DOM `''`; auto-mark fires.
    expect(form.blankPaths.value.has(canonicalizePath('age').key)).toBe(true)
    expect(form.blankPaths.value.size).toBe(1)
  })

  it('partial defaults: auto-marks only unspecified leaves', () => {
    const { app, form } = setupForm(z.object({ name: z.string(), age: z.number() }), {
      name: 'alice',
    })
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('age').key)).toBe(true)
    expect(form.values.name).toBe('alice')
    expect(form.values.age).toBe(0)
  })

  it('explicit slim-default value still opts the leaf out of auto-mark', () => {
    // `defaultValues: { count: 0 }` — the consumer wrote 0 explicitly,
    // so the leaf is NOT blank even though storage matches
    // the slim default. The opt-out signal is "consumer supplied a
    // non-`unset` value", not "consumer supplied a non-default value".
    const { app, form } = setupForm(z.object({ count: z.number() }), { count: 0 })
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(false)
    expect(form.blankPaths.value.size).toBe(0)
  })

  it('nested object: marks unspecified leaves at their canonical paths', () => {
    const { app, form } = setupForm(
      z.object({ user: z.object({ name: z.string(), age: z.number() }) }),
      { user: { name: 'alice' } }
    )
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('user.name').key)).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('user.age').key)).toBe(true)
  })

  it('nested object: omitting the outer object recurses, marks numeric children only', () => {
    const { app, form } = setupForm(
      z.object({ user: z.object({ name: z.string(), age: z.number() }) })
    )
    apps.push(app)
    // String child: not auto-marked.
    expect(form.blankPaths.value.has(canonicalizePath('user.name').key)).toBe(false)
    // Numeric child: auto-marked.
    expect(form.blankPaths.value.has(canonicalizePath('user.age').key)).toBe(true)
    // The object path itself is NOT marked — only primitive leaves are.
    expect(form.blankPaths.value.has(canonicalizePath('user').key)).toBe(false)
  })

  it('optional string leaf is NOT auto-marked (slim is undefined, no divergence)', () => {
    const { app, form } = setupForm(z.object({ note: z.string().optional() }))
    apps.push(app)
    // `undefined` isn't a numeric primitive — no auto-mark.
    expect(form.blankPaths.value.has(canonicalizePath('note').key)).toBe(false)
    expect(form.values.note).toBeUndefined()
  })

  it('nullable string leaf is NOT auto-marked (slim is null, no divergence)', () => {
    const { app, form } = setupForm(z.object({ note: z.string().nullable() }))
    apps.push(app)
    // `null` isn't a numeric primitive — no auto-mark.
    expect(form.blankPaths.value.has(canonicalizePath('note').key)).toBe(false)
    expect(form.values.note).toBeNull()
  })

  it('.default(N) for non-zero N: storage holds N, path is NOT marked blank', () => {
    // `.default(7)` is the schema author's "start the form at 7"
    // signal. The `<input type="number">` renders 7 natively (no
    // storage/display divergence), so the auto-mark side-channel
    // MUST NOT fire — auto-marking here would hide the prefill from
    // the user even though storage holds 7. The contract: auto-mark
    // exists only to bridge the slim-numeric (`0` / `0n`) display
    // gap; any other declared default short-circuits it.
    const { app, form } = setupForm(z.object({ count: z.number().default(7) }))
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(false)
    expect(form.values.count).toBe(7)
  })

  it('.default(0): storage holds 0, path IS marked blank (slim divergence)', () => {
    // `.default(0)` declares the slim value explicitly. Auto-mark
    // still fires because storage holds `0` and the input would
    // otherwise render "0" — the schema author asked for 0 as the
    // starting baseline but the field should display empty until
    // the user interacts (otherwise "user typed 0" and "user
    // supplied nothing" are visually identical).
    const { app, form } = setupForm(z.object({ count: z.number().default(0) }))
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
    expect(form.values.count).toBe(0)
  })

  it('arrays: pass through without marking elements (runtime-added)', () => {
    const { app, form } = setupForm(z.object({ tags: z.array(z.string()) }))
    apps.push(app)
    // `tags` itself is a non-primitive leaf — not marked.
    expect(form.blankPaths.value.has(canonicalizePath('tags').key)).toBe(false)
    // No spurious indexed marks either.
    expect(form.blankPaths.value.size).toBe(0)
  })

  it('explicit value at a leaf does NOT mark even if value happens to equal slim default', () => {
    const { app, form } = setupForm(z.object({ name: z.string(), age: z.number() }), {
      name: '',
      age: 0,
    })
    apps.push(app)
    // Both leaves had user-supplied values (matching slim defaults)
    // — neither is auto-marked.
    expect(form.blankPaths.value.size).toBe(0)
  })

  it('explicit unset opts string leaves in (universal opt-in beats type-gated auto-mark)', () => {
    // `count` via explicit unset, `name` ALSO via explicit unset.
    // Auto-mark is numeric-only, but `unset` is the documented
    // consumer signal that overrides the type gate — explicit intent
    // wins everywhere.
    const { app, form } = setupForm(z.object({ count: z.number(), name: z.string() }), {
      count: unset,
      name: unset,
    })
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(true)
  })

  it('explicit unset on numeric + omitted string: only numeric is marked', () => {
    // Without an explicit `unset` for `name`, the string leaf isn't
    // auto-marked (storage `''` already matches what the DOM shows).
    const { app, form } = setupForm(z.object({ count: z.number(), name: z.string() }), {
      count: unset,
    })
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(false)
  })

  it('auto-marks ride into the post-construction baseline (reset restores them)', () => {
    const { app, form } = setupForm(z.object({ count: z.number() }))
    apps.push(app)
    // Construction auto-marks `count`.
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
    // User types a value — mark is removed.
    form.setValue('count', 42)
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(false)
    // reset() with no args should restore the construction baseline.
    form.reset()
    expect(form.blankPaths.value.has(canonicalizePath('count').key)).toBe(true)
  })

  it('reset(args) auto-marks unspecified leaves in the new defaults', () => {
    const { app, form } = setupForm(z.object({ name: z.string(), age: z.number() }), {
      name: 'alice',
      age: 30,
    })
    apps.push(app)
    expect(form.blankPaths.value.size).toBe(0)
    // Reset with a partial — `age` is omitted, so it gets auto-marked.
    form.reset({ name: 'bob' })
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('age').key)).toBe(true)
    expect(form.values.name).toBe('bob')
    expect(form.values.age).toBe(0)
  })

  it('dirty stays false on construction even with auto-marks', () => {
    // Construction-time auto-marks ARE the baseline — they shouldn't
    // count as "dirty" (the user hasn't done anything yet).
    const { app, form } = setupForm(z.object({ count: z.number(), name: z.string() }))
    apps.push(app)
    expect(form.meta.dirty).toBe(false)
  })
})

/**
 * Container-level `unset` — recursive primitive mark.
 *
 * `unset` is admitted at every position in `defaultValues`, `setValue`,
 * and `reset`, not just primitive leaves. At a bare object container
 * the walker recurses into the schema's slim/empty subtree and marks
 * EVERY primitive descendant blank (strings + booleans + bigints +
 * numerics — the auto-mark side-channel's numeric-only rule is for
 * UNSPECIFIED leaves, not for explicit `unset`). At array, tuple, and
 * record containers the walker writes the slim/empty value with NO
 * per-element marks (matching the "always the falsy version" principle
 * — per-element opt-in via explicit `[unset, unset]` still works).
 * Wrappers (`.optional()` / `.nullable()`) write the wrapper's absent
 * value (`undefined` / `null`) and mark the wrapper path itself. The
 * container path itself does NOT enter `blankPaths`; the
 * `fields.containerPath.blank` aggregate derives from descendants via
 * the existing `buildContainerFieldStateBase` conjunction.
 *
 * Casts: pre-widening, `DefaultValuesShape<T>` only admits `Unset` at
 * primitive leaves, so container-position `unset` is a TS error. The
 * tests cast through `as never` to exercise the runtime contract. The
 * type widening lands alongside the runtime fix and the casts go away
 * with it.
 */

describe('defaultValues with container `unset` — bare object', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('marks every primitive descendant blank (string + number + boolean)', () => {
    const { app, form } = setupForm(
      z.object({
        profile: z.object({
          name: z.string(),
          age: z.number(),
          subscribed: z.boolean(),
        }),
      }),
      { profile: unset } as never
    )
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('profile.name').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('profile.age').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('profile.subscribed').key)).toBe(true)
    expect(form.values.profile.name).toBe('')
    expect(form.values.profile.age).toBe(0)
    expect(form.values.profile.subscribed).toBe(false)
  })

  it('does NOT add the container path itself to blankPaths', () => {
    const { app, form } = setupForm(
      z.object({ profile: z.object({ name: z.string(), age: z.number() }) }),
      { profile: unset } as never
    )
    apps.push(app)
    expect(form.blankPaths.value.has(canonicalizePath('profile').key)).toBe(false)
  })

  it('bypasses .default(N): storage = slim, not the declared default', () => {
    // Same contract as primitive `unset`: the schema's declared
    // `.default(N)` is intentionally skipped in favor of the slim/empty
    // primitive.
    const { app, form } = setupForm(
      z.object({
        profile: z.object({
          name: z.string().default('N/A'),
          age: z.number().default(18),
        }),
      }),
      { profile: unset } as never
    )
    apps.push(app)
    expect(form.values.profile.name).toBe('')
    expect(form.values.profile.age).toBe(0)
  })

  it("form.fields('profile').blank reads true via the descendant aggregate", () => {
    // Container `.blank` lives on the FieldState terminal — invoke
    // `form.fields('profile')` (call-form) to resolve it. Bare
    // `form.fields.profile.blank` would descend into a non-existent
    // `profile.blank` schema path and return another callable proxy.
    const { app, form } = setupForm(
      z.object({ profile: z.object({ name: z.string(), age: z.number() }) }),
      { profile: unset } as never
    )
    apps.push(app)
    const profileField = (form.fields as unknown as (p: string) => { blank: boolean })('profile')
    expect(profileField.blank).toBe(true)
  })

  it("typing one descendant flips form.fields('profile').blank false (reactive)", () => {
    const { app, form } = setupForm(
      z.object({ profile: z.object({ name: z.string(), age: z.number() }) }),
      { profile: unset } as never
    )
    apps.push(app)
    const callable = form.fields as unknown as (p: string) => { blank: boolean }
    expect(callable('profile').blank).toBe(true)
    form.setValue('profile.name', 'alice')
    expect(callable('profile').blank).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('profile.name').key)).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('profile.age').key)).toBe(true)
  })
})

describe('defaultValues with container `unset` — discriminated union', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('lands the discriminator-kind blank, no variant body', () => {
    // Per the disc-path stub contract: writing `unset` at a DU
    // container produces `{ <discKey>: <kind-blank> }` with no
    // variant-specific keys. The first-variant slim would silently
    // ACTIVATE the boat variant — that's the bug this contract
    // forbids.
    const schema = z.object({
      cargo: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('boat'), length: z.number() }),
        z.object({ kind: z.literal('truck'), payload: z.number() }),
      ]),
    })
    const { app, form } = setupForm(schema, { cargo: unset } as never)
    apps.push(app)
    expect((form.values.cargo as { kind: string }).kind).toBe('')
    // No variant body — the first-variant keys must NOT have been
    // seeded.
    expect((form.values.cargo as Record<string, unknown>)['length']).toBeUndefined()
    expect((form.values.cargo as Record<string, unknown>)['payload']).toBeUndefined()
    // The discriminator path is blank-marked (kind-appropriate
    // blank '' for a string-typed discriminator).
    expect(form.blankPaths.value.has(canonicalizePath('cargo.kind').key)).toBe(true)
  })
})

describe('defaultValues with container `unset` — array / tuple / record', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('array: writes [] with no per-element marks', () => {
    const { app, form } = setupForm(z.object({ tags: z.array(z.string()) }), {
      tags: unset,
    } as never)
    apps.push(app)
    expect(form.values.tags).toEqual([])
    expect(form.blankPaths.value.size).toBe(0)
  })

  it('tuple: writes slim tuple with no per-position marks', () => {
    const { app, form } = setupForm(z.object({ coords: z.tuple([z.string(), z.number()]) }), {
      coords: unset,
    } as never)
    apps.push(app)
    expect(form.values.coords).toEqual(['', 0])
    expect(form.blankPaths.value.has(canonicalizePath('coords.0').key)).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('coords.1').key)).toBe(false)
  })

  it('record: writes {} with no per-entry marks', () => {
    const { app, form } = setupForm(z.object({ counts: z.record(z.string(), z.number()) }), {
      counts: unset,
    } as never)
    apps.push(app)
    expect(form.values.counts).toEqual({})
    expect(form.blankPaths.value.size).toBe(0)
  })
})

describe('defaultValues with container `unset` — wrappers', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('.optional() wrapper: writes undefined, marks the wrapper path', () => {
    const { app, form } = setupForm(
      z.object({
        profile: z.object({ name: z.string(), age: z.number() }).optional(),
      }),
      { profile: unset } as never
    )
    apps.push(app)
    expect(form.values.profile).toBeUndefined()
    expect(form.blankPaths.value.has(canonicalizePath('profile').key)).toBe(true)
  })

  it('.nullable() wrapper: writes null, marks the wrapper path', () => {
    const { app, form } = setupForm(
      z.object({
        profile: z.object({ name: z.string(), age: z.number() }).nullable(),
      }),
      { profile: unset } as never
    )
    apps.push(app)
    expect(form.values.profile).toBeNull()
    expect(form.blankPaths.value.has(canonicalizePath('profile').key)).toBe(true)
  })
})

describe('defaultValues: unset at root', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('marks every primitive leaf blank, slim subtree in storage', () => {
    // The housing-application use case: dev wants proof every field
    // was touched. With `defaultValues: unset` at root, every string /
    // number / boolean / bigint leaf enters `blankPaths`. As the user
    // fills fields, leaves leave the set. `blankPaths.value.size === 0`
    // becomes a clean audit signal for "every field touched".
    const schema = z.object({
      name: z.string().default('N/A'),
      income: z.number().default(0),
      agreed: z.boolean().default(true),
    })
    const { app, form } = setupForm(schema, unset as never)
    apps.push(app)
    expect(form.values.name).toBe('')
    expect(form.values.income).toBe(0)
    expect(form.values.agreed).toBe(false)
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('income').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('agreed').key)).toBe(true)
  })

  it('blankPaths.size === count of primitive leaves; touching one shrinks it', () => {
    const schema = z.object({
      name: z.string(),
      income: z.number(),
      agreed: z.boolean(),
    })
    const { app, form } = setupForm(schema, unset as never)
    apps.push(app)
    expect(form.blankPaths.value.size).toBe(3)
    form.setValue('income', 42_000)
    expect(form.blankPaths.value.size).toBe(2)
    expect(form.blankPaths.value.has(canonicalizePath('income').key)).toBe(false)
  })

  it('recurses through nested objects + arrays + DUs from root', () => {
    const schema = z.object({
      account: z.object({ email: z.string(), age: z.number() }),
      tags: z.array(z.string()),
      cargo: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('boat'), length: z.number() }),
        z.object({ kind: z.literal('truck'), payload: z.number() }),
      ]),
    })
    const { app, form } = setupForm(schema, unset as never)
    apps.push(app)
    // Object leaves: marked.
    expect(form.blankPaths.value.has(canonicalizePath('account.email').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('account.age').key)).toBe(true)
    // Array: no per-element marks (empty array per the array
    // contract).
    expect(form.values.tags).toEqual([])
    // DU: discriminator marked, no variant body.
    expect((form.values.cargo as { kind: string }).kind).toBe('')
    expect(form.blankPaths.value.has(canonicalizePath('cargo.kind').key)).toBe(true)
  })
})

describe('setValue(path, unset) on a container', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('object container: marks every primitive descendant, slim subtree in storage', () => {
    const { app, form } = setupForm(
      z.object({ profile: z.object({ name: z.string(), age: z.number() }) })
    )
    apps.push(app)
    // Fill some descendants first.
    form.setValue('profile.name', 'alice')
    form.setValue('profile.age', 30)
    expect(form.blankPaths.value.size).toBe(0)
    // Whole-container unset re-blanks.
    form.setValue('profile' as never, unset as never)
    expect(form.values.profile.name).toBe('')
    expect(form.values.profile.age).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('profile.name').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('profile.age').key)).toBe(true)
  })

  it('DU container: lands discriminator-kind blank, no variant body', () => {
    const schema = z.object({
      cargo: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('boat'), length: z.number() }),
        z.object({ kind: z.literal('truck'), payload: z.number() }),
      ]),
    })
    const { app, form } = setupForm(schema, {
      cargo: { kind: 'boat', length: 12 },
    })
    apps.push(app)
    form.setValue('cargo' as never, unset as never)
    expect((form.values.cargo as { kind: string }).kind).toBe('')
    expect((form.values.cargo as Record<string, unknown>)['length']).toBeUndefined()
  })
})

describe('reset({ container: unset })', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('object container in reset args: marks every primitive descendant', () => {
    const { app, form } = setupForm(
      z.object({ profile: z.object({ name: z.string(), age: z.number() }) }),
      { profile: { name: 'alice', age: 30 } }
    )
    apps.push(app)
    expect(form.blankPaths.value.size).toBe(0)
    form.reset({ profile: unset } as never)
    expect(form.values.profile.name).toBe('')
    expect(form.values.profile.age).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('profile.name').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('profile.age').key)).toBe(true)
    // Dirty is false post-reset (the marks ARE the new baseline).
    expect(form.meta.dirty).toBe(false)
  })

  it('reset(unset) at root: every primitive leaf marked, slim subtree', () => {
    const { app, form } = setupForm(z.object({ name: z.string(), income: z.number() }), {
      name: 'alice',
      income: 50_000,
    })
    apps.push(app)
    form.reset(unset as never)
    expect(form.values.name).toBe('')
    expect(form.values.income).toBe(0)
    expect(form.blankPaths.value.has(canonicalizePath('name').key)).toBe(true)
    expect(form.blankPaths.value.has(canonicalizePath('income').key)).toBe(true)
  })
})
