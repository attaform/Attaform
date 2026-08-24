// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * P6 characterization pin — the imperative-validation contract.
 *
 * Pins the observable behaviors of the store-committing imperative
 * validation path so they survive the P6 fold verbatim: the verdict is
 * committed to the schema-error store at the validated scope, in-flight
 * per-field runs are cancelled so a late resolution cannot clobber the
 * authoritative result, derived blank-required errors compose into the
 * response scoped to the validated path, and the plain `parse(path?)`
 * read stays pure (no commit, no cancel). Asserted on BOTH zod majors.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'zod v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
  { name: 'zod v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
] as const

let keySeq = 0

async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 32 && !done(); i++) {
    await Promise.resolve()
    await nextTick()
  }
}

describe.each(adapters)('imperative validation contract — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mount(options: Record<string, unknown>): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let api: any
    const Root = defineComponent({
      setup() {
        api = useForm({ key: `imperative-contract-${keySeq++}`, strict: false, ...options })
        return () => h('div')
      },
    })
    const app = createApp(Root).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    return api
  }

  const schema = () =>
    z.object({
      email: z.string().email(),
      password: z.string().min(8),
    })

  it('commits the verdict to the error store at the validated scope', async () => {
    // validateOn: 'blur' keeps setValue from scheduling its own run, so
    // the ONLY writer of refinement errors here is the imperative call.
    const api = mount({ schema: schema(), validateOn: 'blur' })
    api.setValue('email', 'not-an-email')

    const failing = await api.validateAsync('email')
    expect(failing.success).toBe(false)
    // The verdict landed in the store: the aggregate now carries the
    // refinement entry at the validated scope.
    const committed = api.meta.errors.filter(
      (e: { code?: string }) => e.code !== 'atta:no-value-supplied'
    )
    expect(committed.length).toBeGreaterThan(0)
    expect(committed.every((e: { path: unknown[] }) => e.path[0] === 'email')).toBe(true)

    // Re-running against a now-valid value REPLACES the stale entry —
    // the committed scope drops to clean.
    api.setValue('email', 'alice@example.com')
    const passing = await api.validateAsync('email')
    expect(passing.success).toBe(true)
    const remaining = api.meta.errors.filter(
      (e: { code?: string }) => e.code !== 'atta:no-value-supplied'
    )
    expect(remaining).toEqual([])
  })

  it('cancels in-flight per-field validation (late run cannot clobber)', async () => {
    // `username` gates its async refine on a manual promise so the
    // per-field run stays in flight until we release it.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const gated = z.object({
      username: z.string().refine(async (v) => {
        if (v.startsWith('slow')) await gate
        return true
      }),
      password: z.string().min(8),
    })
    const api = mount({ schema: gated })

    api.setValue('username', 'slow-user')
    expect(api.fields.username.validating).toBe(true)

    // Path-scoped to the OTHER field, whose refinement is sync — but the
    // imperative call cancels ALL in-flight field runs (mirroring
    // handleSubmit), so username's gated run is dropped, not awaited.
    const response = await api.validateAsync('password')
    expect(response.success).toBe(false) // min(8) fails on ''
    expect(api.fields.username.validating).toBe(false)

    // Releasing the gate after the fact must not resurrect anything.
    release()
    await settle(() => false)
    expect(api.fields.username.validating).toBe(false)
  })

  it('composes derived blank-required errors scoped to the validated path', async () => {
    // Blank auto-mark is numeric-only: required number leaves with no
    // storable default mark blank at mount, so both start blank here.
    const numeric = z.object({ age: z.number(), score: z.number() })
    const api = mount({ schema: numeric, validateOn: 'blur' })

    const whole = await api.validateAsync()
    expect(whole.success).toBe(false)
    const wholeBlanks = (whole.errors ?? []).filter(
      (e: { code?: string }) => e.code === 'atta:no-value-supplied'
    )
    const wholePaths = wholeBlanks.map((e: { path: unknown[] }) => e.path[0])
    expect(wholePaths).toContain('age')
    expect(wholePaths).toContain('score')

    const scoped = await api.validateAsync('age')
    expect(scoped.success).toBe(false)
    const scopedBlanks = (scoped.errors ?? []).filter(
      (e: { code?: string }) => e.code === 'atta:no-value-supplied'
    )
    expect(scopedBlanks.length).toBeGreaterThan(0)
    expect(scopedBlanks.every((e: { path: unknown[] }) => e.path[0] === 'age')).toBe(true)
  })

  it('meta.validating flips for the imperative run and settles false', async () => {
    const api = mount({ schema: schema(), validateOn: 'blur' })
    const pending = api.validateAsync()
    await Promise.resolve()
    expect(api.meta.validating).toBe(true)
    await pending
    expect(api.meta.validating).toBe(false)
  })

  it('plain parse() stays a pure read: reports failure without committing', async () => {
    const api = mount({ schema: schema(), validateOn: 'blur' })
    api.setValue('email', 'not-an-email')

    const result = await api.parse()
    expect(result.success).toBe(false)
    // The response carries the refinement verdict...
    const refinementInResponse = (result.errors ?? []).filter(
      (e: { code?: string }) => e.code !== 'atta:no-value-supplied'
    )
    expect(refinementInResponse.length).toBeGreaterThan(0)
    // ...but the store does NOT: nothing was committed, so the aggregate
    // still holds only the derived blank-required class.
    const committed = api.meta.errors.filter(
      (e: { code?: string }) => e.code !== 'atta:no-value-supplied'
    )
    expect(committed).toEqual([])
  })

  it('plain parse() does not cancel an in-flight per-field run', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const gated = z.object({
      username: z.string().refine(async (v) => {
        if (v.startsWith('slow')) await gate
        return true
      }),
      password: z.string().min(8),
    })
    const api = mount({ schema: gated })

    api.setValue('username', 'slow-user')
    expect(api.fields.username.validating).toBe(true)

    // Path-scoped parse of the sync field: resolves while the gated run
    // stays in flight — parse never touches other fields' runs.
    const response = await api.parse('password')
    expect(response.success).toBe(false)
    expect(api.fields.username.validating).toBe(true)

    release()
    await settle(() => api.fields.username.validating === false)
    expect(api.fields.username.validating).toBe(false)
  })
})
