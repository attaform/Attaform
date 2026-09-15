// @vitest-environment jsdom
/**
 * `form.clear()` is an ordinary write, so it leaves `dirty` and
 * `touched` exactly where it found them. `form.reset()` is a fresh
 * start, so it wipes both.
 *
 * The pair is a documented promise rather than an implementation
 * detail. `docs/writing-and-mutating/clear.md` tells readers that a
 * Discard button built on `clear` still counts as an edit, and
 * therefore that a submit gated on `!form.meta.dirty` stays enabled
 * afterwards. That is the opposite of what the page claimed before it
 * was measured, and the opposite of what "wipe to blank" sounds like,
 * so it is the kind of behaviour a later refactor could plausibly
 * "correct" into the intuitive-but-wrong answer.
 *
 * Nothing held it. The clear suite (`clear.test.ts`, `clear-v3.test.ts`,
 * `clear-blank-alignment.test.ts`) covers the written values and the
 * blank marks and never reads `dirty` or `touched` at all, so the whole
 * distinction between the two calls was ungated on the state half.
 *
 * The source agrees with the measurement: `clear` is documented as
 * "sugar over setValue(path, getEmptyValueAtPath(path)) — no separate
 * bookkeeping", and an ordinary write has no reason to forget that the
 * user was in the field.
 */
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, nextTick } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'

// The v3 and v4 `useForm` overload sets don't unify into one callable
// signature, so an adapter-agnostic caller types the function the way
// `makeMounter` in `test/utils/form-harness.ts` does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (options: any) => any

type Adapter = {
  readonly name: string
  readonly useFormFn: AnyUseForm
  readonly schema: unknown
}

const adapters: readonly Adapter[] = [
  { name: 'v4', useFormFn: useFormV4, schema: zV4.object({ title: zV4.string() }) },
  { name: 'v3', useFormFn: useFormV3, schema: zV3.object({ title: zV3.string() }) },
]

/**
 * The slice of the form handle this probe touches. Spelled out rather
 * than left as the adapter-agnostic `any`, so the assertions below are
 * checked against real member names.
 */
type ProbeForm = {
  setValue: (path: string, value: unknown) => boolean
  touch: (path: string) => void
  clear: (path: string) => boolean
  reset: () => void
  meta: { dirty: boolean }
  fields: { title: { dirty: boolean; touched: boolean } }
  values: { title: string }
}

type Snapshot = {
  readonly formDirty: boolean
  readonly fieldDirty: boolean
  readonly touched: boolean
  readonly value: string
}

/**
 * `useForm` has to run inside `setup`, so the probe mounts a component
 * and resolves once the body has run.
 */
function inSetup<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const Comp = defineComponent({
      setup() {
        try {
          fn().then(resolve, reject)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        return () => null
      },
    })
    createApp(Comp).mount(document.createElement('div'))
  })
}

describe.each(adapters)('$name: clear vs reset on edit state', ({ useFormFn, schema }) => {
  /** Edits and touches `title`, then runs `act` and reports the state. */
  const editThen = async (act: (form: ProbeForm) => void): Promise<Snapshot> =>
    inSetup(async () => {
      const form: ProbeForm = useFormFn({ schema, defaultValues: { title: 'A great draft' } })
      await nextTick()
      form.setValue('title', 'edited')
      form.touch('title')
      await nextTick()
      expect(form.meta.dirty).toBe(true)
      expect(form.fields.title.touched).toBe(true)

      act(form)
      await nextTick()
      return {
        formDirty: form.meta.dirty,
        fieldDirty: form.fields.title.dirty,
        touched: form.fields.title.touched,
        value: form.values.title,
      }
    })

  it('clear leaves dirty and touched alone, so a discard still reads as an edit', async () => {
    expect(await editThen((form) => form.clear('title'))).toStrictEqual({
      formDirty: true,
      fieldDirty: true,
      touched: true,
      value: '',
    })
  })

  it('reset wipes both, because a reset is a fresh start', async () => {
    expect(await editThen((form) => form.reset())).toStrictEqual({
      formDirty: false,
      fieldDirty: false,
      touched: false,
      value: 'A great draft',
    })
  })
})
