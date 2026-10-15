// @vitest-environment jsdom
/**
 * Capability answers the majors gave differently for the same schema,
 * each changing what a form showed (#691).
 *
 * A refine on a `z.map`. Each keystroke re-validates only the edited
 * subtree when every check in the schema is leaf-local, and the whole
 * form otherwise. v3's container-refine test never looked below a map,
 * and did not count a map as a container, so a refine on an entry's
 * object, or on the map itself, read as leaf-local: an edit inside an
 * entry re-validated the edited leaf alone and the refine did not run
 * again until submit. v4 counts both and shows the error as the user
 * types; v3 now does too.
 *
 * A leaf with an async transform. A field's `valid` waits for the first
 * async pass when its sub-schema holds async work, as `meta.valid` does.
 * The sub-schema v4 builds for a path counted only async refines, so
 * the field read valid while the pass was still running and `meta.valid`
 * read false. v3's sub-schemas, and both majors' roots, count the
 * transform; v4's sub-schemas now do too.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { awaitSettle, makeMounter, wait } from '../utils/form-harness'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ADAPTERS = [
  { name: 'v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

/**
 * Long enough for a validation pass to land. v3 counts every refine as
 * possibly async, so its forms settle through the async pass.
 */
async function settle(): Promise<void> {
  await wait(50)
  await awaitSettle()
}

async function write(api: any, path: string, value: unknown): Promise<void> {
  api.setValue(path, value)
  await settle()
}

describe.each(ADAPTERS)('a refine on a map re-runs as the user types ($name)', (a) => {
  it("on an entry's object", async () => {
    const room = a.z
      .object({ a: a.z.string(), b: a.z.string() })
      .refine((v: { a: string; b: string }) => v.a === v.b, { message: 'mismatch', path: ['b'] })
    const schema = a.z.object({ rooms: a.z.map(a.z.string(), room), other: a.z.string() })
    const { api, app } = makeMounter(a.useForm, schema, {
      defaultValues: { rooms: new Map([['k', { a: 'x', b: 'x' }]]), other: '' },
    })()
    apps.push(app)
    await settle()
    expect(api.meta.valid).toBe(true)

    await write(api, 'rooms.k.a', 'y')
    expect(api.fields('rooms.k.b').errors.map((e: any) => e.message)).toEqual(['mismatch'])
    expect(api.meta.valid).toBe(false)

    await write(api, 'rooms.k.b', 'y')
    expect(api.fields('rooms.k.b').errors).toEqual([])
    expect(api.meta.valid).toBe(true)
  })

  it('on the map itself', async () => {
    const scores = a.z
      .map(a.z.string(), a.z.number())
      .refine((m: Map<string, number>) => [...m.values()].every((n) => n <= 100), 'over 100')
    const schema = a.z.object({ scores })
    const { api, app } = makeMounter(a.useForm, schema, {
      defaultValues: { scores: new Map([['ann', 50]]) },
    })()
    apps.push(app)
    await settle()
    expect(api.meta.valid).toBe(true)

    await write(api, 'scores.ann', 150)
    expect(api.fields('scores').errors.map((e: any) => e.message)).toEqual(['over 100'])
    expect(api.meta.valid).toBe(false)

    await write(api, 'scores.ann', 90)
    expect(api.meta.valid).toBe(true)
  })
})
describe.each(ADAPTERS)('a field with an async transform waits for the first pass ($name)', (a) => {
  it('reads not valid until the first async pass settles, like meta.valid', async () => {
    const schema = a.z.object({
      code: a.z.string().transform(async (v: string) => {
        await Promise.resolve()
        return v
      }),
      name: a.z.string().min(1),
    })
    const { api, app } = makeMounter(a.useForm, schema, {
      defaultValues: { code: 'x', name: 'ok' },
    })()
    apps.push(app)
    expect(api.meta.valid).toBe(false)
    expect(api.fields.code.valid).toBe(false)
    // A sync-only sibling has nothing to wait on.
    expect(api.fields.name.valid).toBe(true)
    await settle()
    expect(api.meta.valid).toBe(true)
    expect(api.fields.code.valid).toBe(true)
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */
