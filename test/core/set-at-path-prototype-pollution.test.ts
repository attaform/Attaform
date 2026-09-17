// @vitest-environment jsdom
/**
 * Prototype-pollution gate for the copy-on-write write spine
 * (path-walker.ts).
 *
 * `setAtPathWithSchemaFill` is that spine: every `form.setValue(path,
 * value)`, every history undo/redo patch apply, and every hydration
 * merge reaches it, and every consumer-controlled path arrives with it.
 * Without protection a `__proto__` segment lands at `rec[head] = …` on a
 * plain `{}` intermediate and the inherited `[[Set]]` accessor reassigns
 * the prototype chain. `setAtPath` is a thin call over the same spine.
 *
 * THAT SHAPE IS WHY THIS FILE EXISTS IN ITS CURRENT FORM. The hardening
 * originally landed on `setAtPath`, and this suite tested `setAtPath` —
 * but the write path had already moved to the schema-aware walker, which
 * was still writing through a raw `rec[head]`. Both facts were true and
 * the suite was green: it guarded a walker nothing called. The two
 * walkers are now one, and the end-to-end block at the bottom asserts
 * through `form.setValue`, so a future divergence cannot hide the same
 * way.
 *
 * The fix routes every untrusted-key write through `safeAssign`,
 * which lands the `__proto__` key via `Object.defineProperty`
 * (own data property, no chain mutation). Intermediate containers
 * carry `Object.prototype` so the resulting tree responds to
 * `.hasOwnProperty(...)`, `in`, and devalue / pinia-style payload
 * walkers; the spread (`{ ...root }`) at each copy-on-write step
 * uses `CreateDataProperty` per the spec, which bypasses the
 * inherited `__proto__` setter. Legitimate fields literally named
 * `prototype` / `constructor` / `__proto__` round-trip the same way
 * every other key does.
 *
 * Two invariants per case:
 *   1. No pollution — a fresh plain `{}` does NOT inherit any
 *      property the special-key write tried to plant.
 *   2. Positive roundtrip — `getAtPath` reads back the value at the
 *      declared path on the result.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { getAtPath, setAtPath } from '../../src/runtime/core/path-walker'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * The slice of the form surface these cases touch. Declared structurally
 * rather than as `ReturnType<typeof useForm<S>>`: the fixtures reach paths
 * by string through the call form, which the inferred path unions cannot
 * describe for a `z.record` key that does not exist until it is written.
 */
type FormProbe = {
  setValue(path: string, value: unknown): unknown
  values(path?: string): unknown
  fields(path: string): { value: unknown; dirty: boolean }
}

const SENTINEL = 'attaformSetAtPathProtoPollutionCanary'

describe('setAtPath proto-less intermediates', () => {
  beforeEach(() => {
    const preProbe: Record<string, unknown> = {}
    expect(preProbe[SENTINEL]).toBeUndefined()
  })

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>)[SENTINEL]
  })

  it("path ['__proto__', X] writes own property and leaves Object.prototype clean", () => {
    const root = setAtPath({}, ['__proto__', SENTINEL], 'attempted-pollution')

    // Negative invariant — Object.prototype is unchanged.
    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    // Positive roundtrip — the value lands at the declared path. The
    // result's `__proto__` is an own property on a prototype-less
    // container, so reading walks the own property (NOT the inherited
    // accessor that would return Object.prototype).
    expect(getAtPath(root, ['__proto__', SENTINEL])).toBe('attempted-pollution')
  })

  it("path ['constructor', X] writes own property and leaves Object.prototype clean", () => {
    const root = setAtPath({}, ['constructor', SENTINEL], 'legit-value')

    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    expect(getAtPath(root, ['constructor', SENTINEL])).toBe('legit-value')
  })

  it("path ['prototype', X] writes own property and leaves Object.prototype clean", () => {
    const root = setAtPath({}, ['prototype', SENTINEL], 'building-A')

    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    expect(getAtPath(root, ['prototype', SENTINEL])).toBe('building-A')
  })

  it('intermediate copy-on-write preserves a prior __proto__ own property through a sibling write', () => {
    // Sequence: write tree['__proto__']['a'] = 'first', then write
    // tree['__proto__']['b'] = 'second'. The spread at each copy-on-
    // write step uses `CreateDataProperty`, so the prior `__proto__`
    // own data property carries through without invoking the inherited
    // accessor on the new container.
    const step1 = setAtPath({}, ['__proto__', 'a'], 'first')
    const step2 = setAtPath(step1, ['__proto__', 'b'], 'second')

    expect(getAtPath(step2, ['__proto__', 'a'])).toBe('first')
    expect(getAtPath(step2, ['__proto__', 'b'])).toBe('second')

    const probe: Record<string, unknown> = {}
    expect(probe['a']).toBeUndefined()
    expect(probe['b']).toBeUndefined()
  })

  it("the resulting tree's `__proto__` slot is an own data property (shadows the inherited accessor)", () => {
    // Containers now carry `Object.prototype` so `.hasOwnProperty()` /
    // `in` / serializer walkers work. The defense lives in the
    // descriptor at `__proto__`: `safeAssign` installs an own data
    // property with `configurable: true` so the inherited setter never
    // fires. Reading `root.__proto__` returns the own value
    // (`{ y: … }`), not `Object.prototype`.
    const root = setAtPath({}, ['__proto__', 'y'], { z: 1 }) as Record<string, unknown>

    const descriptor = Object.getOwnPropertyDescriptor(root, '__proto__')
    expect(descriptor).toBeDefined()
    expect(descriptor?.value).toBeDefined()
    expect(descriptor?.enumerable).toBe(true)
    // Container is a normal `Object.prototype`-backed record — the
    // own `__proto__` data property shadows the accessor for reads,
    // but `getPrototypeOf` reports the real chain.
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype)
  })

  it('object intermediates carry Object.prototype and respond to `.hasOwnProperty()` / `in`', () => {
    const root = setAtPath({}, ['x', 'y', 'z'], 1) as Record<string, unknown>

    expect(Object.getPrototypeOf(root)).toBe(Object.prototype)
    // Direct `.hasOwnProperty(...)` calls below are the consumer
    // pattern this test guards against; routing through
    // `Object.prototype.hasOwnProperty.call` would erase the regression.
    // eslint-disable-next-line no-prototype-builtins
    expect(root.hasOwnProperty('x')).toBe(true)
    expect('x' in root).toBe(true)

    const xNode = root['x'] as Record<string, unknown>
    expect(Object.getPrototypeOf(xNode)).toBe(Object.prototype)
    // eslint-disable-next-line no-prototype-builtins
    expect(xNode.hasOwnProperty('y')).toBe(true)

    const yNode = xNode['y'] as Record<string, unknown>
    expect(Object.getPrototypeOf(yNode)).toBe(Object.prototype)
    // eslint-disable-next-line no-prototype-builtins
    expect(yNode.hasOwnProperty('z')).toBe(true)
  })

  it('array intermediates stay as Array instances (unchanged behavior)', () => {
    const root = setAtPath({}, ['items', 0, 'name'], 'first') as Record<string, unknown>

    const items = root['items']
    expect(Array.isArray(items)).toBe(true)
    const first = (items as Array<Record<string, unknown>>)[0]
    expect(first).toBeDefined()
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype)
    expect(first?.['name']).toBe('first')
  })
})

/**
 * The same guarantee, asserted where a consumer can see it.
 *
 * The exposure is a key the target does not already own. A fixed object
 * schema that declares `__proto__` seeds the own data property at
 * construction, and from then on a plain `rec['__proto__'] = v` finds the
 * own slot and shadows the inherited accessor — which is why the defect
 * survived a suite that only ever wrote to declared fields. `z.record`
 * is the case where the key is genuinely new on first write, and it
 * fails two different ways depending on the value's type:
 *
 *  - a STRING (or any primitive) makes the inherited setter a no-op. The
 *    write is silently discarded. `setValue` returns normally, no error
 *    is raised, and the value is simply gone.
 *  - an OBJECT makes the inherited setter do exactly what it is for: it
 *    reassigns the container's prototype. The datum disappears off the
 *    own-property list into the chain, and the form's own value tree now
 *    carries an attacker-supplied prototype.
 *
 * `{ __proto__: ... }` in an object literal sets the prototype rather
 * than declaring a key, so the fixed-schema fixture uses a computed key.
 * That is also part of why this was easy to miss by hand.
 */
describe('a __proto__ key round-trips through setValue', () => {
  const apps: App[] = []
  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount()
  })

  function mountForm(schema: z.ZodObject, defaultValues: unknown): FormProbe {
    let captured: unknown
    const App = defineComponent({
      setup() {
        captured = (useForm as unknown as (config: unknown) => unknown)({
          schema,
          key: `proto-${Math.random().toString(36).slice(2)}`,
          defaultValues,
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.createElement('div'))
    apps.push(app)
    if (captured === undefined) throw new Error('useForm did not return')
    return captured as FormProbe
  }

  const stringRecord = z.object({ meta: z.record(z.string(), z.string()) })
  const objectRecord = z.object({ meta: z.record(z.string(), z.object({ z: z.number() })) })

  it('a new __proto__ key on a record keeps a primitive instead of dropping it', () => {
    const form = mountForm(stringRecord, { meta: { a: '1' } })
    form.setValue('meta.__proto__', 'written')
    expect(form.values('meta.__proto__')).toBe('written')
    // Asserted through the descriptor rather than a deep-equal against an
    // object literal, because `{ __proto__: 'written' }` in the EXPECTED
    // literal sets the prototype instead of declaring a key — the same
    // trap the code under test is about, one level up.
    const meta = (JSON.parse(JSON.stringify(form.values())) as Record<string, object>)['meta']
    expect(meta).toBeDefined()
    expect(Object.keys(meta as object).sort()).toEqual(['__proto__', 'a'])
    expect(Object.getOwnPropertyDescriptor(meta as object, '__proto__')?.value).toBe('written')
  })

  it('a new __proto__ key holding an object does not reassign the container prototype', () => {
    const form = mountForm(objectRecord, { meta: {} })
    form.setValue('meta.__proto__', { z: 9 })
    const meta = (form.values() as Record<string, object>)['meta'] as object
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype)
    expect(form.values('meta.__proto__')).toEqual({ z: 9 })
  })

  it('leaves Object.prototype itself clean', () => {
    const form = mountForm(objectRecord, { meta: {} })
    form.setValue('meta.__proto__', { z: 9 })
    const probe: Record<string, unknown> = {}
    expect(probe['z']).toBeUndefined()
  })

  it('marks the field dirty, so the write is visible to the rest of the form', () => {
    // A discarded write is not just an unreadable value: every derived
    // signal agrees with the storage, so the field reports itself clean
    // and a submit ships the stale value without anything looking wrong.
    const form = mountForm(stringRecord, { meta: { a: '1' } })
    form.setValue('meta.__proto__', 'written')
    expect(form.fields('meta.__proto__').dirty).toBe(true)
  })

  it('a declared __proto__ field still round-trips (the pre-seeded case)', () => {
    const declared = z.object({
      wrap: z.object({ ['__proto__']: z.string(), city: z.string() }),
    })
    const form = mountForm(declared, { wrap: { ['__proto__']: 'initial', city: 'NYC' } })
    form.setValue('wrap.__proto__', 'written')
    expect(form.values('wrap.__proto__')).toBe('written')
    expect(form.values('wrap.city')).toBe('NYC')
  })
})
