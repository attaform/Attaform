// @vitest-environment jsdom
/**
 * A form derives its schema's defaults once per construction (#691).
 *
 * The `unset` pre-pass reads the schema's defaults to mark a numeric leaf
 * blank where it starts at the slim `0`, and the store stores the starting
 * value it derives from them. Each used to derive them on its own, so a
 * `.default(fn)` factory ran once for each, and a factory that does not
 * return the same value on every call could leave a leaf marked blank over
 * a stored value the pre-pass never saw. One derivation now feeds both.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ADAPTERS = [
  { name: 'v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

describe.each(ADAPTERS)('schema defaults are derived once per construction ($name)', (a) => {
  it('runs a .default factory once to build a form without defaultValues', () => {
    let calls = 0
    const schema = a.z.object({
      count: a.z.number().default(() => {
        calls += 1
        return 0
      }),
      name: a.z.string(),
    })
    // A form on the schema first: Zod v3 also calls the factory once, the
    // first time it builds the schema's copy for synchronous parses.
    apps.push(makeMounter(a.useForm, schema)().app)
    const before = calls
    const { api, app } = makeMounter(a.useForm, schema)()
    apps.push(app)
    expect(calls - before).toBe(1)
    expect(api.values.count).toBe(0)
  })

  it('marks blank exactly the numeric leaf it stores at the slim 0', () => {
    let calls = 0
    // 0 on the first call and 7 after it.
    const schema = a.z.object({
      count: a.z.number().default(() => (calls++ === 0 ? 0 : 7)),
    })
    const { api, app } = makeMounter(a.useForm, schema)()
    apps.push(app)
    expect(api.values.count).toBe(0)
    expect(api.blankPaths.value.has('count')).toBe(true)
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */
