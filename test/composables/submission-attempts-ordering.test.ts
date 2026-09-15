// @vitest-environment jsdom
/**
 * `form.meta.submissionAttempts` increments at the END of a submit, not
 * at the start. A callback reading it therefore still sees the count
 * from before this run.
 *
 * The natural reading is the opposite one, and the docs held that
 * reading until it was measured: both `docs/submitting/handle-submit.md`
 * and `docs/submitting/focus-scroll.md` opened their dispatch sequence
 * with "the submit count increments". Moving the increment to the front
 * is the exact shape of that "fix", it reads more logically, and the
 * whole suite passes with it applied, so nothing was holding the real
 * order.
 *
 * It is observable. An attempt counter wired up inside `onSubmit` or
 * `onError` ("retry 2 of 3", "stop after the third try") reads one less
 * than the run it is sitting in, and the default display heuristic
 * gates on this same counter, which is why a failed submit reveals
 * every field's errors once the submit SETTLES rather than while it is
 * still validating.
 *
 * Both callback arms are pinned, because they land on different sides
 * of the success branch and could drift apart.
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

type ProbeForm = {
  setValue: (path: string, value: unknown) => boolean
  handleSubmit: (
    onSubmit: (values: unknown) => void,
    onError?: (errors: unknown) => void
  ) => (event?: Event) => Promise<void>
  meta: { submissionAttempts: number }
}

type Adapter = {
  readonly name: string
  readonly useForm: AnyUseForm
  readonly schema: unknown
}

const adapters: readonly Adapter[] = [
  {
    name: 'zod-v4',
    useForm: useFormV4 as unknown as AnyUseForm,
    schema: zV4.object({ email: zV4.string().min(5, 'too short') }),
  },
  {
    name: 'zod-v3',
    useForm: useFormV3 as unknown as AnyUseForm,
    schema: zV3.object({ email: zV3.string().min(5, 'too short') }),
  },
]

function inSetup<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const Comp = defineComponent({
      setup() {
        try {
          Promise.resolve(fn()).then(resolve, reject)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        return () => null
      },
    })
    createApp(Comp).mount(document.createElement('div'))
  })
}

const settle = async (): Promise<void> => {
  await nextTick()
  await new Promise((r) => setTimeout(r, 20))
  await nextTick()
}

describe.each(adapters)('submissionAttempts ordering ($name)', (adapter) => {
  it('is still the pre-run count inside onSubmit, and has ticked once the call resolves', async () => {
    const seen = await inSetup(async () => {
      const form = adapter.useForm({ schema: adapter.schema }) as ProbeForm
      await settle()
      form.setValue('email', 'valid@example.com')
      await settle()

      let insideCallback = -1
      const submit = form.handleSubmit(() => {
        insideCallback = form.meta.submissionAttempts
      })
      await submit()
      await settle()
      return { atEntry: 0, insideCallback, afterAwait: form.meta.submissionAttempts }
    })

    expect(seen).toStrictEqual({ atEntry: 0, insideCallback: 0, afterAwait: 1 })
  })

  it('is still the pre-run count inside onError too', async () => {
    const seen = await inSetup(async () => {
      const form = adapter.useForm({ schema: adapter.schema }) as ProbeForm
      await settle()
      form.setValue('email', 'x')
      await settle()

      let insideOnError = -1
      let successRan = false
      const submit = form.handleSubmit(
        () => {
          successRan = true
        },
        () => {
          insideOnError = form.meta.submissionAttempts
        }
      )
      await submit()
      await settle()
      const afterFirst = form.meta.submissionAttempts

      // A second failing submit: onError sees 1 (the first run's tally),
      // not 2, which is the off-by-one an attempt counter would inherit.
      await submit()
      await settle()
      return {
        successRan,
        insideOnErrorSecondRun: insideOnError,
        afterFirst,
        afterSecond: form.meta.submissionAttempts,
      }
    })

    expect(seen).toStrictEqual({
      successRan: false,
      insideOnErrorSecondRun: 1,
      afterFirst: 1,
      afterSecond: 2,
    })
  })
})
