// @vitest-environment jsdom
/**
 * Prototype-pollution gate for `placeAt` (errors-proxy.ts).
 *
 * `setFieldErrors` accepts a `path` from consumer input — server
 * replies, manual marks. Without a guard, a path whose first segment
 * is `__proto__` reaches `placeAt`'s `cursorRecord[lastKey] = errors`
 * writes (errors-proxy.ts:360,368, CodeQL alerts #12 and #13, rule
 * `js/prototype-polluting-assignment`). The two-segment shape
 * `['__proto__', 'polluted']` walks via `tree.__proto__` straight onto
 * `Object.prototype` and assigns the global there, breaking every
 * object in the process.
 *
 * The guard at the top of `placeAt` matches the SEC-2 shape from the
 * persistence layer's `mergeDeep` — `isDangerousSegment` rejects
 * `__proto__`, `constructor`, and `prototype`, and the whole placement
 * is dropped.
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

describe.each(adapters)('errors-proxy `placeAt` prototype-pollution guard — $name', ({ mount }) => {
  beforeEach(() => {
    // Pre-test invariant: the canary must NOT be present. A leaked
    // pollution from earlier in the test process would otherwise
    // false-positive the post-test assertion.
    const preProbe: Record<string, unknown> = {}
    expect(preProbe[SENTINEL]).toBeUndefined()
  })

  afterEach(() => {
    // Defensive cleanup: even though the fix should prevent any
    // mutation, scrub the canary so a leak from a regression never
    // bleeds into the rest of the suite.
    delete (Object.prototype as Record<string, unknown>)[SENTINEL]
  })

  it("setFieldErrors with path: ['__proto__', X] does not pollute Object.prototype", () => {
    const { api, app } = mount()
    api.setFieldErrors([
      {
        path: ['__proto__', SENTINEL],
        message: 'attempted pollution',
        formKey: api.key,
        code: 'atta:server',
      },
    ])
    // Reading `form.errors` triggers materialisation, which is the
    // codepath that invokes `placeAt`. Without that read, the guard
    // is never exercised.
    void api.errors
    const probe: Record<string, unknown> = {}
    app.unmount()
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it("setFieldErrors with path: ['constructor', X] does not surface on plain objects", () => {
    const { api, app } = mount()
    api.setFieldErrors([
      {
        path: ['constructor', SENTINEL],
        message: 'attempted pollution',
        formKey: api.key,
        code: 'atta:server',
      },
    ])
    void api.errors
    const probe: Record<string, unknown> = {}
    app.unmount()
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it("setFieldErrors with path: ['prototype', X] does not surface on plain objects", () => {
    const { api, app } = mount()
    api.setFieldErrors([
      {
        path: ['prototype', SENTINEL],
        message: 'attempted pollution',
        formKey: api.key,
        code: 'atta:server',
      },
    ])
    void api.errors
    const probe: Record<string, unknown> = {}
    app.unmount()
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it('setFormErrors at the synthetic root path is unaffected by the guard', () => {
    const { api, app } = mount()
    api.setFormErrors([{ message: 'root-level error' }])
    const formLevel = api.errors('')
    app.unmount()
    expect(formLevel).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'root-level error' })])
    )
  })
})
