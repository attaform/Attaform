// @vitest-environment jsdom
/**
 * Array.prototype pass-through gate for PASS2-10.
 *
 * `form.fields.<array>` / `form.errors.<array>` are array-shaped
 * Proxies (Array target → `Array.isArray` true, `v-for` enters the
 * indexed branch). Pre-fix every string key on the `get` trap routed
 * through schema descent — including `'map'`, `'forEach'`, `'find'`,
 * etc. — which produced one phantom FieldState child instead of the
 * Array.prototype method. Typed consumers were shielded by the type
 * surface, but duck-typed / vanilla JS callers ran into broken
 * iteration helpers.
 *
 * The fix routes Array.prototype keys through to the Array prototype
 * when the path is array-shaped AND the schema doesn't claim a literal
 * field at the would-be child path. Read-only methods (`map`,
 * `forEach`, `find`, etc.) work because they call `this[i]` /
 * `this.length` back through the proxy's own `get` trap, which still
 * returns the descended sub-proxy / FieldState. Mutating methods
 * (`push`, `pop`, `splice`, …) become reachable but the proxy's `set`
 * trap (warn-and-noop after PASS2-4) prevents any actual mutation.
 */
import { describe, expect, it, vi } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const schemaV4 = zV4.object({
  email: zV4.string(),
  tags: zV4.array(zV4.string()),
})
const schemaV3 = zV3.object({
  email: zV3.string(),
  tags: zV3.array(zV3.string()),
})

const adapters = [
  {
    name: 'v4',
    mount: makeMounter(useFormV4, schemaV4, {
      defaultValues: { email: '', tags: ['alpha', 'beta', 'gamma'] },
    }),
  },
  {
    name: 'v3',
    mount: makeMounter(useFormV3, schemaV3, {
      defaultValues: { email: '', tags: ['alpha', 'beta', 'gamma'] },
    }),
  },
] as const

describe.each(adapters)('Array.prototype on array-shaped proxies — $name', ({ mount }) => {
  it('form.fields.<array>.map iterates over the per-element FieldStates', () => {
    const { api, app } = mount()
    const values = (
      api.fields.tags as { map: (fn: (f: { value: string }) => string) => string[] }
    ).map((f) => f.value)
    app.unmount()
    expect(values).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('form.fields.<array>.forEach iterates exactly once per element', () => {
    const { api, app } = mount()
    const seen: string[] = []
    ;(
      api.fields.tags as {
        forEach: (fn: (f: { value: string }, i: number) => void) => void
      }
    ).forEach((f) => {
      seen.push(f.value)
    })
    app.unmount()
    expect(seen).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('form.fields.<array>.find returns the first matching FieldState', () => {
    const { api, app } = mount()
    const hit = (
      api.fields.tags as {
        find: (fn: (f: { value: string }) => boolean) => { value: string } | undefined
      }
    ).find((f) => f.value === 'beta')
    app.unmount()
    expect(hit?.value).toBe('beta')
  })

  it('form.fields.<array>.filter returns the kept FieldStates', () => {
    const { api, app } = mount()
    const kept = (
      api.fields.tags as {
        filter: (fn: (f: { value: string }) => boolean) => { value: string }[]
      }
    ).filter((f) => f.value !== 'beta')
    app.unmount()
    expect(kept.map((f) => f.value)).toEqual(['alpha', 'gamma'])
  })

  it('form.errors.<array>.map iterates over per-index error arrays', () => {
    const { api, app } = mount()
    api.setErrors([
      {
        path: ['tags', 1],
        message: 'bad tag',
        formKey: api.key,
        code: 'atta:server',
      },
    ])
    // Each element on `form.errors.tags` is the descended per-index
    // sub-proxy (call it via `.length` to materialise the error array;
    // resolved leaf shape is `ValidationError[] | undefined`).
    const lengths = (
      api.errors.tags as {
        map: (fn: (errs: unknown[] | undefined) => number) => number[]
      }
    ).map((errs) => (errs as unknown[] | undefined)?.length ?? 0)
    app.unmount()
    // Index 1 has an error; 0 and 2 don't. The middle element should
    // carry a non-zero count; the others zero.
    expect(lengths[1]).toBeGreaterThan(0)
    expect(lengths[0]).toBe(0)
    expect(lengths[2]).toBe(0)
  })

  it('Array.isArray + iteration still work alongside the prototype pass-through', () => {
    const { api, app } = mount()
    expect(Array.isArray(api.fields.tags)).toBe(true)
    const collected: string[] = []
    for (const f of api.fields.tags as Iterable<{ value: string }>) {
      collected.push(f.value)
    }
    app.unmount()
    expect(collected).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('mutating method (push) does not mutate the underlying form (PASS2-4 set trap)', () => {
    const { api, app } = mount()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => {
      ;(api.fields.tags as { push: (x: unknown) => number }).push({})
    }).not.toThrow()
    warnSpy.mockRestore()
    // Underlying form data unchanged — the readonly proxy didn't
    // propagate the write.
    expect(api.values.tags).toEqual(['alpha', 'beta', 'gamma'])
    app.unmount()
  })
})
