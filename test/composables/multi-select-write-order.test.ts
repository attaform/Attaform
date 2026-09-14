// @vitest-environment jsdom
/**
 * `<select multiple v-register>` writes picked values in MARKUP order.
 *
 * The order the array comes back in is a contract a consumer can build
 * on (a tag list rendered back in a stable sequence, a diff against a
 * stored array, a "first pick wins" rule), and the docs stated the
 * opposite of the truth until this landed: they promised SELECTION
 * order, which the directive has never produced.
 *
 * It cannot produce it, by construction. The change handler reads
 * `el.options` and filters for `selected`, so it sees the DOM's own
 * document-ordered collection and has no record of the sequence the
 * user clicked in. `test/composables/multi-select-cmd-click.test.ts`
 * already asserts an array that proves this (a green added last lands
 * in the middle), but that file is about Cmd+click re-sync and the
 * ordering is incidental to its setup, so nothing named the contract.
 *
 * The discriminator here is incremental: each pick dispatches its own
 * `change`, the way a browser does. An implementation that accumulated
 * selection order would return `['ops', 'design']` for a user who
 * picked Ops and then Design; reading `el.options` returns
 * `['design', 'ops']`.
 *
 * Both container leaves are covered. A Set model routes through
 * `new Set(selectedVal)`, whose iteration order is insertion order, so
 * the same guarantee has to hold there and through a different
 * constructor.
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
  readonly list: unknown
  readonly set: unknown
}

const adapters: readonly Adapter[] = [
  {
    name: 'v4',
    useFormFn: useFormV4,
    list: zV4.object({ picks: zV4.array(zV4.string()) }),
    set: zV4.object({ picks: zV4.set(zV4.string()) }),
  },
  {
    name: 'v3',
    useFormFn: useFormV3,
    list: zV3.object({ picks: zV3.array(zV3.string()) }),
    set: zV3.object({ picks: zV3.set(zV3.string()) }),
  },
]

type Container = {
  readonly label: string
  readonly leaf: 'list' | 'set'
  readonly empty: () => unknown
  /** Normalize to a plain array so both containers assert identically. */
  readonly read: (value: unknown) => readonly unknown[]
}

const CONTAINERS: readonly Container[] = [
  {
    label: 'array leaf',
    leaf: 'list',
    empty: () => [],
    read: (value) => (Array.isArray(value) ? value : []),
  },
  {
    label: 'set leaf',
    leaf: 'set',
    empty: () => new Set<string>(),
    read: (value) => (value instanceof Set ? Array.from(value) : []),
  },
]

// Markup order is design, eng, ops. The user picks ops first.
const TEMPLATE = `<select data-testid="c" multiple v-register="form.register('picks')">
  <option value="design">Design</option>
  <option value="eng">Engineering</option>
  <option value="ops">Ops</option>
</select>`

describe.each(adapters)('$name: <select multiple> write order', ({ useFormFn, list, set }) => {
  const appOut: { app: App | undefined } = { app: undefined }
  afterEach(() => {
    appOut.app?.unmount()
    appOut.app = undefined
    document.body.innerHTML = ''
  })

  it.each(CONTAINERS.map((c) => [c.label, c] as const))(
    '%s writes in markup order, not the order picked',
    async (_label, container) => {
      const formOut: { form?: Record<string, never> } = {}
      const Comp = defineComponent({
        setup() {
          const form = useFormFn({
            schema: container.leaf === 'set' ? set : list,
            key: `mso-${_label}-${Math.random().toString(36).slice(2)}`,
            strict: false,
            defaultValues: { picks: container.empty() },
          })
          formOut.form = form
          return { form }
        },
        render: compileToRender(`<div>${TEMPLATE}</div>`),
      })

      const app = createApp(Comp).use(createAttaform())
      installVRegister(app)
      const root = document.createElement('div')
      document.body.appendChild(root)
      app.mount(root)
      appOut.app = app
      await waitUntil(() => root.querySelector('[data-testid="c"]'))
      await nextTick()

      const select = root.querySelector<HTMLSelectElement>('[data-testid="c"]')
      expect(select).not.toBeNull()
      if (select === null) return

      const read = (): readonly unknown[] =>
        container.read((formOut.form as unknown as { values: { picks: unknown } }).values.picks)

      // The user picks the LAST option first. Each pick dispatches its
      // own `change`, which is what a real multi-select does and what
      // gives an order-accumulating implementation somewhere to store
      // the sequence.
      const ops = select.options[2]
      expect(ops).not.toBeUndefined()
      if (ops === undefined) return
      ops.selected = true
      select.dispatchEvent(new Event('change'))
      await nextTick()
      expect(read()).toEqual(['ops'])

      // Then adds the FIRST option, which the markup puts ahead of it.
      const design = select.options[0]
      expect(design).not.toBeUndefined()
      if (design === undefined) return
      design.selected = true
      select.dispatchEvent(new Event('change'))
      await nextTick()

      // The whole pin. Selection order would be `['ops', 'design']`.
      expect(read()).toEqual(['design', 'ops'])
    }
  )
})
