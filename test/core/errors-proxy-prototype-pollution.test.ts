// @vitest-environment jsdom
/**
 * Prototype-pollution gate for `placeAt` (errors-proxy.ts).
 *
 * `setErrors` accepts a `path` from consumer input — server
 * replies, manual marks. Without protection, a path whose first segment
 * is `__proto__` reaches `placeAt`'s `cursorRecord[lastKey] = errors`
 * write and pollutes `Object.prototype` for the whole process (CodeQL
 * alerts #12 and #13, rule `js/prototype-polluting-assignment`).
 *
 * The fix sanitises the storage shape, not the input. The error-tree
 * containers are allocated via `Object.create(null)` so a `__proto__`
 * segment is just another own-property key with no path to
 * `Object.prototype`. Legitimate fields named `prototype` (an
 * architecture firm tracking building prototypes, a JS-tooling form
 * mentioning `__proto__` literally) land their errors at the declared
 * path the consumer asked for, instead of being silently dropped by a
 * dangerous-segment guard.
 *
 * Each special-key case asserts two invariants in sequence:
 *   1. Positive roundtrip — the errors are present in the materialised
 *      error tree at the path the consumer set them at. Probed via
 *      `form.errors.toJSON()` because the `form.errors(path)` callable
 *      applies the active-path filter for unreachable paths (correct
 *      for the schema-error case it's tuned for, irrelevant for raw
 *      placement verification here).
 *   2. No pollution — a fresh plain `{}` does NOT inherit the canary
 *      property, confirming the write never reached `Object.prototype`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const schemaV4 = zV4.object({ email: zV4.string() })
const schemaV3 = zV3.object({ email: zV3.string() })

const adapters = [
  {
    name: 'v4',
    mount: makeMounter(useFormV4, schemaV4, { defaultValues: { email: '' } }),
  },
  {
    name: 'v3',
    mount: makeMounter(useFormV3, schemaV3, { defaultValues: { email: '' } }),
  },
] as const

// Sentinel property name unique to this test run. If pollution lands,
// every plain object inherits this key — easy to detect from a fresh
// `{}` without disturbing global state for unrelated suites.
const SENTINEL = 'attaformProtoPollutionCanary'

type ErrorTree = Record<string, unknown>

function materialisedErrorTree(api: { errors: unknown }): ErrorTree {
  const errors = api.errors as { toJSON?: () => ErrorTree }
  if (typeof errors.toJSON !== 'function') {
    throw new Error('form.errors did not expose toJSON — surface-proxy contract changed')
  }
  return errors.toJSON()
}

describe.each(adapters)('errors-proxy `placeAt` proto-less storage — $name', ({ mount }) => {
  beforeEach(() => {
    // Pre-test invariant: the canary must NOT be present. A leaked
    // pollution from earlier in the test process would otherwise
    // false-positive the post-test assertion.
    const preProbe: Record<string, unknown> = {}
    expect(preProbe[SENTINEL]).toBeUndefined()
  })

  afterEach(() => {
    // Defensive cleanup: even though the prototype-less tree should
    // prevent any mutation, scrub the canary so a regression never
    // bleeds into the rest of the suite.
    delete (Object.prototype as Record<string, unknown>)[SENTINEL]
  })

  it("['__proto__', X] lands at the declared path AND does not pollute Object.prototype", () => {
    const { api, app } = mount()
    const message = 'legit field literally named __proto__'
    api.setErrors([
      {
        path: ['__proto__', SENTINEL],
        message,
        formKey: api.key,
        code: 'atta:server',
      },
    ])

    // Positive roundtrip — the materialised tree carries the entry as
    // a plain own-property pair on prototype-less containers, so
    // bracket access lands exactly where the consumer set the path.
    const tree = materialisedErrorTree(api)
    const protoSlot = tree['__proto__'] as ErrorTree | undefined

    // Negative invariant — Object.prototype is unchanged. A plain `{}`
    // probe inherits nothing because the tree's `__proto__` slot is a
    // regular own property on a prototype-less container, not the
    // accessor that would walk into Object.prototype.
    const probe: Record<string, unknown> = {}

    app.unmount()

    expect(protoSlot).toBeDefined()
    expect(protoSlot?.[SENTINEL]).toEqual(
      expect.arrayContaining([expect.objectContaining({ message })])
    )
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it("['constructor', X] lands at the declared path AND does not pollute Object.prototype", () => {
    const { api, app } = mount()
    const message = 'legit field literally named constructor'
    api.setErrors([
      {
        path: ['constructor', SENTINEL],
        message,
        formKey: api.key,
        code: 'atta:server',
      },
    ])

    const tree = materialisedErrorTree(api)
    const ctorSlot = tree['constructor'] as ErrorTree | undefined
    const probe: Record<string, unknown> = {}

    app.unmount()

    expect(ctorSlot).toBeDefined()
    expect(ctorSlot?.[SENTINEL]).toEqual(
      expect.arrayContaining([expect.objectContaining({ message })])
    )
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it("['prototype', X] lands at the declared path AND does not pollute Object.prototype", () => {
    const { api, app } = mount()
    const message = 'building-A spec mismatch (architecture firm prototype field)'
    api.setErrors([
      {
        path: ['prototype', SENTINEL],
        message,
        formKey: api.key,
        code: 'atta:server',
      },
    ])

    const tree = materialisedErrorTree(api)
    const protoSlot = tree['prototype'] as ErrorTree | undefined
    const probe: Record<string, unknown> = {}

    app.unmount()

    expect(protoSlot).toBeDefined()
    expect(protoSlot?.[SENTINEL]).toEqual(
      expect.arrayContaining([expect.objectContaining({ message })])
    )
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it('setErrors lands in the global bucket, read via meta.ownErrors', () => {
    const { api, app } = mount()
    api.setErrors([{ message: 'root-level error' }])
    const global = api.meta.ownErrors
    app.unmount()
    expect(global).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'root-level error' })])
    )
  })
})
