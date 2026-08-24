// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormConfigV4, UseFormReturnV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { getAtPath, hasAtPath, setAtPath } from '../../src/runtime/core/path-walker'
import { isShadowedKey, safeOwnRead } from '../../src/runtime/core/safe-assign'

/**
 * Prototype-shadowed key names (`__proto__`, `hasOwnProperty`,
 * `toString`, …) must be treated as ordinary data keys everywhere: they
 * round-trip through storage, read back the stored value on every
 * surface, serialise faithfully, and — for `__proto__` / `constructor`
 * — never reach `Object.prototype`. The hazard is twofold: `target[key]`
 * / `key in target` leak the inherited member when no own slot exists,
 * and Vue additionally shims `hasOwnProperty` on every reactive proxy.
 */

const SHADOWED = [
  'hasOwnProperty',
  'toString',
  'valueOf',
  'constructor',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__proto__',
]

// Guard against a regression leaking onto the shared prototype mid-suite.
afterEach(() => {
  for (const sentinel of ['polluted', 'pwned', 'val-__proto__']) {
    if (Object.prototype.hasOwnProperty.call(Object.prototype, sentinel)) {
      delete (Object.prototype as Record<string, unknown>)[sentinel]
    }
  }
})

describe('shadowed-key safety — path-walker primitives', () => {
  it('isShadowedKey flags exactly the Object.prototype member names', () => {
    for (const k of SHADOWED) expect(isShadowedKey(k)).toBe(true)
    for (const k of ['email', 'city', 'wrap', '0', 'tags', 'value', 'dirty']) {
      expect(isShadowedKey(k)).toBe(false)
    }
  })

  it('setAtPath / getAtPath round-trip every shadowed key', () => {
    let tree: unknown = {}
    for (const k of SHADOWED) tree = setAtPath(tree, ['wrap', k], `val-${k}`)
    for (const k of SHADOWED) {
      expect(getAtPath(tree, ['wrap', k])).toBe(`val-${k}`)
    }
  })

  it('getAtPath returns undefined for a purely-inherited slot (no own data)', () => {
    const plain = { a: 1 }
    expect(getAtPath(plain, ['hasOwnProperty'])).toBeUndefined()
    expect(getAtPath(plain, ['toString'])).toBeUndefined()
    expect(getAtPath(plain, ['constructor'])).toBeUndefined()
  })

  it('hasAtPath is own-only for shadowed keys', () => {
    expect(hasAtPath({ a: 1 }, ['hasOwnProperty'])).toBe(false)
    expect(hasAtPath({ a: 1 }, ['toString'])).toBe(false)
    const withOwn = setAtPath({}, ['hasOwnProperty'], 'x')
    expect(hasAtPath(withOwn, ['hasOwnProperty'])).toBe(true)
  })

  it('safeOwnRead returns the own value or undefined, never the inherited member', () => {
    expect(safeOwnRead({}, 'hasOwnProperty')).toBeUndefined()
    expect(safeOwnRead({}, 'toString')).toBeUndefined()
    const o: Record<string, unknown> = {}
    o['hasOwnProperty'] = 'mine'
    expect(safeOwnRead(o, 'hasOwnProperty')).toBe('mine')
  })
})

describe('shadowed-key safety — no prototype pollution', () => {
  it('a __proto__ write lands as own data, never on Object.prototype', () => {
    const tree = setAtPath({}, ['evil', '__proto__'], { polluted: true })
    // Own data property at the literal key — not the prototype.
    expect(getAtPath(tree, ['evil', '__proto__'])).toEqual({ polluted: true })
    const fresh: Record<string, unknown> = {}
    expect(fresh['polluted']).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false)
  })

  it('a deep __proto__ chain in a write does not poison the chain', () => {
    const tree = setAtPath({}, ['a', '__proto__', 'b'], 'pwned')
    expect(getAtPath(tree, ['a', '__proto__', 'b'])).toBe('pwned')
    const fresh: Record<string, unknown> = {}
    expect(fresh['b']).toBeUndefined()
  })

  it('restoring a hostile JSON payload (simulated persistence) stays own-data', () => {
    // JSON.parse already lands `__proto__` as an own enumerable key; the
    // restore path writes it back through `setAtPath` (own-property
    // writes), so it never reaches the prototype.
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"name":"ok"}') as Record<
      string,
      unknown
    >
    let tree: unknown = {}
    for (const key of Object.keys(hostile)) {
      tree = setAtPath(tree, [key], hostile[key])
    }
    const fresh: Record<string, unknown> = {}
    expect(fresh['polluted']).toBeUndefined()
    expect(getAtPath(tree, ['name'])).toBe('ok')
  })
})

describe('shadowed-key safety — live form surfaces', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mount<Schema extends z.ZodObject>(
    schema: Schema,
    defaultValues: UseFormConfigV4<Schema>['defaultValues']
  ): UseFormReturnV4<Schema> {
    let captured: unknown
    const App = defineComponent({
      setup() {
        captured = (useForm as unknown as (config: unknown) => unknown)({
          schema,
          key: `sk-${Math.random().toString(36).slice(2)}`,
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
    return captured as UseFormReturnV4<Schema>
  }

  const schema = z.object({
    wrap: z.object({
      hasOwnProperty: z.string(),
      toString: z.string(),
      valueOf: z.string(),
      constructor: z.string(),
      city: z.string(),
    }),
  })
  const dv = {
    wrap: { hasOwnProperty: 'h', toString: 't', valueOf: 'v', constructor: 'c', city: 'NYC' },
  }
  // Reach the shadowed leaves through a permissive view (their names
  // collide with built-ins at the type level).
  const fieldVal = (form: UseFormReturnV4<typeof schema>, key: string): unknown => {
    const fields = form.fields as unknown as Record<string, Record<string, { value: unknown }>>
    return fields['wrap']?.[key]?.value
  }

  it('shadowed leaves stay reachable: coercion names via the call form, the rest by dot', () => {
    const form = mount(schema, dv)
    // `hasOwnProperty` / `toString` / `valueOf` resolve their built-in
    // handlers on dot-access (so coercion and membership probes always
    // work); the call form addresses the data fields by path.
    expect(form.fields('wrap.hasOwnProperty').value).toBe('h')
    expect(form.fields('wrap.toString').value).toBe('t')
    expect(form.fields('wrap.valueOf').value).toBe('v')
    // Names with no built-in collision on the surface keep dot access.
    expect(fieldVal(form, 'constructor')).toBe('c')
  })

  it('form.fields(path) call-form reads the stored value', () => {
    const form = mount(schema, dv)
    expect(form.fields('wrap.hasOwnProperty').value).toBe('h')
    expect(form.fields('wrap.constructor').value).toBe('c')
  })

  it('form.values(path) call-form reads the stored value', () => {
    const form = mount(schema, dv)
    expect(form.values('wrap.hasOwnProperty')).toBe('h')
    expect(form.values('wrap.toString')).toBe('t')
    expect(form.values('wrap.constructor')).toBe('c')
  })

  it('JSON.stringify(form.values) serialises shadowed keys faithfully', () => {
    const form = mount(schema, dv)
    const parsed = JSON.parse(JSON.stringify(form.values)) as { wrap: Record<string, unknown> }
    expect(parsed.wrap['hasOwnProperty']).toBe('h')
    expect(parsed.wrap['toString']).toBe('t')
    expect(parsed.wrap['valueOf']).toBe('v')
    expect(parsed.wrap['constructor']).toBe('c')
    expect(parsed.wrap['city']).toBe('NYC')
  })

  it('JSON.stringify(form.fields) carries a FieldState at each shadowed leaf', () => {
    const form = mount(schema, dv)
    const parsed = JSON.parse(JSON.stringify(form.fields)) as {
      wrap: Record<string, { value: unknown }>
    }
    expect(parsed.wrap['hasOwnProperty']?.value).toBe('h')
    expect(parsed.wrap['constructor']?.value).toBe('c')
  })

  it('setValue at a shadowed leaf round-trips through every read surface', () => {
    const form = mount(schema, dv)
    form.setValue('wrap.hasOwnProperty', 'changed')
    expect(form.values('wrap.hasOwnProperty')).toBe('changed')
    expect(form.fields('wrap.hasOwnProperty').value).toBe('changed')
    const parsed = JSON.parse(JSON.stringify(form.values)) as { wrap: Record<string, unknown> }
    expect(parsed.wrap['hasOwnProperty']).toBe('changed')
  })

  it('form.values.hasOwnProperty(k) still works as the real method when no such field exists', () => {
    const plain = z.object({ email: z.string(), city: z.string() })
    const form = mount(plain, { email: 'a@b.com', city: 'NYC' })
    const has = (form.values as unknown as { hasOwnProperty(k: string): boolean }).hasOwnProperty
    expect(typeof has).toBe('function')
    expect(has.call(form.values, 'email')).toBe(true)
    expect(has.call(form.values, 'nope')).toBe(false)
  })
})
