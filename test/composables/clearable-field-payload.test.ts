// @vitest-environment jsdom
/**
 * A cleared `.optional()` leaf leaves the payload; a cleared required
 * one sends `''`.
 *
 * This is the contract behind the Agent Skill's schema guidance in
 * `skills/attaform/references/validation.md` ("A clearable edit field is
 * a required string"), which tells authors to spell a field the user
 * must be able to empty as `z.string()` rather than
 * `z.string().optional()`. The reasoning is that a partial-update
 * backend reads an absent key as "leave unchanged", so an optional leaf
 * turns a deliberate clear into a silent no-op against the server.
 *
 * That advice is only sound while the two spellings actually differ in
 * the snapshot, and the skill is the one surface with no compiler and no
 * demo behind its prose (#570). Advice that quietly stops being true
 * there is expensive: it reaches consumers through
 * `npx attaform skill`, reads as authoritative, and the failure lands in
 * their product rather than their build.
 *
 * The existing coverage is adjacent rather than on point.
 * `clear.test.ts` pins `form.clear('optionalBio') -> undefined` and
 * `blank.test.ts` pins which leaves get auto-marked, both at the store.
 * Neither asks what `form.values()` looks like after a USER empties the
 * control, which is the path the guidance is about and the one that
 * routes through the host's empty-signal handling (#518).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { installVRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { compileToRender } from '../utils/ssr-cross-path'
import { waitUntil } from '../utils/form-harness'

// The v3 and v4 `useForm` overload sets don't unify into one callable
// signature, so an adapter-agnostic caller types the function the way
// `makeMounter` in `test/utils/form-harness.ts` does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (options: any) => any

type Adapter = {
  readonly name: string
  readonly useFormFn: AnyUseForm
  readonly required: unknown
  readonly optional: unknown
}

const adapters: readonly Adapter[] = [
  {
    name: 'v4',
    useFormFn: useFormV4,
    required: zV4.object({ nickname: zV4.string() }),
    optional: zV4.object({ nickname: zV4.string().optional() }),
  },
  {
    name: 'v3',
    useFormFn: useFormV3,
    required: zV3.object({ nickname: zV3.string() }),
    optional: zV3.object({ nickname: zV3.string().optional() }),
  },
]

describe.each(adapters)('$name: clearing a text field', ({ useFormFn, required, optional }) => {
  const appOut: { app: App | undefined } = { app: undefined }
  afterEach(() => {
    appOut.app?.unmount()
    appOut.app = undefined
    document.body.innerHTML = ''
  })

  const typeThenClear = async (schema: unknown): Promise<Record<string, unknown>> => {
    const formOut: { form?: { values: () => Record<string, unknown> } } = {}
    const Comp = defineComponent({
      setup() {
        const form = useFormFn({
          schema,
          key: `clearable-${Math.random().toString(36).slice(2)}`,
          strict: false,
        })
        formOut.form = form
        return { form }
      },
      render: compileToRender(
        `<div><input data-testid="c" v-register="form.register('nickname')" /></div>`
      ),
    })

    const app = createApp(Comp).use(createAttaform())
    installVRegister(app)
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    appOut.app = app
    await waitUntil(() => root.querySelector('[data-testid="c"]'))
    await nextTick()

    const input = root.querySelector<HTMLInputElement>('[data-testid="c"]')
    expect(input).not.toBeNull()
    if (input === null) throw new Error('unreachable')

    // The user types, then empties the field.
    input.value = 'ozzy'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(formOut.form?.values()).toEqual({ nickname: 'ozzy' })

    input.value = ''
    input.dispatchEvent(new Event('input'))
    await nextTick()
    return formOut.form?.values() ?? {}
  }

  it('a required string sends the empty string, so the clear reaches the server', async () => {
    expect(await typeThenClear(required)).toEqual({ nickname: '' })
  })

  it('an optional string drops the key, which a partial update reads as unchanged', async () => {
    expect(await typeThenClear(optional)).toEqual({})
  })
})
