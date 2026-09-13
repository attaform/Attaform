// @vitest-environment jsdom
/**
 * Retention pins for the per-path caches behind `form.fields` and
 * `form.errors` (#617).
 *
 * Every read surface memoises per canonical path so repeated reads stay
 * cheap, and none of those caches was ever evicted: they grew with the
 * number of paths the form had ever resolved rather than the number it
 * currently has. Churning 500 keys of a `z.record` of objects through
 * every read surface left, on the unfixed tree:
 *
 * | cache                        | before | after |
 * | ---------------------------- | ------ | ----- |
 * | `viewCache` (fields)         | 500    | 0     |
 * | `containerCache` (fields)    | 502    | 2     |
 * | `existsCache` (fields)       | 501    | 1     |
 * | `containerCache` (errors)    | 502    | 2     |
 * | `existsCache` (errors)       | 501    | 1     |
 * | `treeCache` (errors)         | 500    | 0     |
 *
 * against a form whose `prefs` was `{}`.
 *
 * These entries hold proxies, closures and path strings rather than
 * form data, which is what made this milder than the field-state cache
 * #612 fixed. The pins below prove the release rather than the size,
 * since a reachable proxy is the observable consequence.
 *
 * The correctness half matters as much as the release half. The pinned
 * contract in `surface-contract-pins.test.ts` is that `form.fields.x`
 * returns an identity-stable view, so evicting the view of a path the
 * form still HAS would break it outright. Only a path the form no
 * longer has may be dropped, and the last group here holds that line.
 */
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod-v4'
import { makeMounter } from '../utils/form-harness'

const hasGc = typeof globalThis.gc === 'function'

const schema = z.object({
  prefs: z.record(z.string(), z.object({ at: z.date() })),
  rows: z.array(z.object({ label: z.string() })),
  fixed: z.object({ name: z.string() }),
})

function mountForm() {
  return makeMounter(useForm, schema, {
    defaultValues: { prefs: {}, rows: [], fixed: { name: '' } },
  })().api
}

type Form = ReturnType<typeof mountForm>

/** Force collection hard enough for a WeakRef to clear. */
async function collect(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    globalThis.gc?.()
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

/**
 * The sweep walks a bounded slice per write, so a path only comes up
 * for collection once the cursor reaches it. These writes advance the
 * cursor without adding cached paths of their own: they touch one
 * schema-bounded path, which the sweep never tracks.
 */
const SETTLE_WRITES = 60
function churn(api: Form): void {
  for (let i = 0; i < SETTLE_WRITES; i++) {
    api.setValue('fixed.name', `n${i}`)
  }
}

/**
 * Resolve `count` record entries through `touch`, dropping each one
 * immediately, and report how many of the proxies the surfaces handed
 * back are still reachable afterwards.
 */
async function survivingProxies(
  count: number,
  touch: (api: Form, key: string) => object | undefined
): Promise<number> {
  const api = mountForm()
  const refs: WeakRef<object>[] = []
  for (let i = 0; i < count; i++) {
    const key = `k${i}`
    api.setValue(`prefs.${key}`, { at: new Date(i) })
    // The IIFE keeps the test's own scope from holding the proxy, which
    // would retain the very thing under measurement.
    const ref = ((): WeakRef<object> | undefined => {
      const proxy = touch(api, key)
      return proxy === undefined ? undefined : new WeakRef(proxy)
    })()
    if (ref !== undefined) refs.push(ref)
    api.setValue('prefs', {})
  }
  churn(api)
  await nextTick()
  await collect()
  return refs.filter((ref) => ref.deref() !== undefined).length
}

describe.skipIf(!hasGc)('a churned path releases its cached proxies', () => {
  const COUNT = 40

  it('releases nothing it was never given (control)', async () => {
    // The control run resolves no proxy at all, so nothing can survive.
    // It proves the harness reports zero for the right reason before
    // any of the runs below report zero for the fixed reason.
    expect(await survivingProxies(COUNT, () => undefined)).toBe(0)
  })

  it('releases a leaf view resolved through dot access', async () => {
    expect(
      await survivingProxies(COUNT, (api, key) => api.fields.prefs[key].at as unknown as object)
    ).toBe(0)
  })

  it('releases a leaf view resolved through the call form', async () => {
    expect(
      await survivingProxies(
        COUNT,
        (api, key) => api.fields(`prefs.${key}.at`) as unknown as object
      )
    ).toBe(0)
  })

  it('releases the container proxy of an entry', async () => {
    expect(
      await survivingProxies(COUNT, (api, key) => api.fields.prefs[key] as unknown as object)
    ).toBe(0)
  })

  it('releases the errors container of an entry', async () => {
    expect(
      await survivingProxies(COUNT, (api, key) => api.errors.prefs[key] as unknown as object)
    ).toBe(0)
  })

  it('releases an entry materialised through JSON.stringify', async () => {
    expect(
      await survivingProxies(COUNT, (api, key) => {
        void JSON.stringify(api.errors.prefs[key])
        return api.errors.prefs[key] as unknown as object
      })
    ).toBe(0)
  })

  it('releases array-index proxies the same way', async () => {
    const api = mountForm()
    const refs: WeakRef<object>[] = []
    for (let i = 0; i < COUNT; i++) {
      api.setValue('rows', [{ label: `r${i}` }])
      refs.push(
        ((): WeakRef<object> => new WeakRef(api.fields.rows[0].label as unknown as object))()
      )
      api.setValue('rows', [])
    }
    churn(api)
    await nextTick()
    await collect()
    expect(refs.filter((ref) => ref.deref() !== undefined).length).toBe(0)
  })
})

describe('what the sweep must never drop', () => {
  it('keeps a live path identity-stable across many writes', async () => {
    const api = mountForm()
    api.setValue('prefs.keep', { at: new Date(1) })
    await nextTick()
    const view = api.fields.prefs.keep.at
    const container = api.fields.prefs.keep
    const errors = api.errors.prefs.keep
    churn(api)
    await nextTick()
    expect(api.fields.prefs.keep.at).toBe(view)
    expect(api.fields.prefs.keep).toBe(container)
    expect(api.errors.prefs.keep).toBe(errors)
  })

  it('never sweeps a path a fixed object shape bounds', async () => {
    const api = mountForm()
    const view = api.fields.fixed.name
    churn(api)
    await nextTick()
    expect(api.fields.fixed.name).toBe(view)
  })

  it('reads a rebuilt path correctly after its entry was swept', async () => {
    const api = mountForm()
    api.setValue('prefs.gone', { at: new Date(1) })
    await nextTick()
    void api.fields.prefs.gone.at.value
    api.setValue('prefs', {})
    churn(api)
    await nextTick()

    api.setValue('prefs.gone', { at: new Date(2) })
    await nextTick()
    expect(api.fields.prefs.gone.at.value).toEqual(new Date(2))
    expect(api.fields('prefs.gone.at')?.value).toEqual(new Date(2))
    expect(api.fields.prefs.gone.at).toBe(api.fields('prefs.gone.at'))
  })

  it('still reports errors at a path that outlived a sweep pass', async () => {
    const api = mountForm()
    api.setValue('prefs.live', { at: new Date(1) })
    await nextTick()
    churn(api)
    api.setErrors([{ path: ['prefs', 'live', 'at'], message: 'Bad date' }])
    await nextTick()
    expect(api.errors.prefs.live.at).toHaveLength(1)
    expect(api.fields.prefs.live.at.firstError?.message).toBe('Bad date')
  })
})
