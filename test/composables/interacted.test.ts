// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z } from 'zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { waitUntil } from '../utils/form-harness'

// `name` is a required string defaulting to '' — clearing it back to empty
// returns to the pristine baseline, which is exactly the case that tells
// `interacted` apart from `dirty`.
const schema = z.object({ name: z.string().min(2) })
type Api = UseFormReturn<typeof schema>

type Mounted = { app: App; api: Api; input: HTMLInputElement }

async function mountField(): Promise<Mounted> {
  const handle: { api?: Api } = {}
  const Parent = defineComponent({
    setup() {
      const api = useForm({ schema, key: `interacted-${Math.random().toString(36).slice(2)}` })
      handle.api = api
      return () => withDirectives(h('input', { type: 'text' }), [[vRegister, api.register('name')]])
    },
  })
  const app = createApp(Parent).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  await waitUntil(() => (handle.api !== undefined && root.firstElementChild !== null ? true : null))
  if (handle.api === undefined) throw new Error('mountField: api never set')
  return { app, api: handle.api, input: root.firstElementChild as HTMLInputElement }
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('interacted — sticky value-mutation signal', () => {
  let mounted: Mounted | undefined
  afterEach(() => {
    mounted?.app.unmount()
    mounted = undefined
    document.body.innerHTML = ''
  })

  it('is false at registration', async () => {
    mounted = await mountField()
    expect(mounted.api.fields.name.interacted).toBe(false)
  })

  it('flips true on the first user edit and survives a net-pristine round trip', async () => {
    mounted = await mountField()
    typeInto(mounted.input, 'a')
    expect(mounted.api.fields.name.interacted).toBe(true)
    // Back to the empty baseline: net-pristine, yet still interacted.
    typeInto(mounted.input, '')
    expect(mounted.api.fields.name.dirty).toBe(false)
    expect(mounted.api.fields.name.interacted).toBe(true)
  })

  it('stays false when a field is tabbed through without editing', async () => {
    mounted = await mountField()
    mounted.input.dispatchEvent(new FocusEvent('focus'))
    mounted.input.dispatchEvent(new FocusEvent('blur'))
    // The blur flips touched; interacted only tracks value edits.
    expect(mounted.api.fields.name.touched).toBe(true)
    expect(mounted.api.fields.name.interacted).toBe(false)
  })

  it('is not set by a programmatic setValue', async () => {
    mounted = await mountField()
    mounted.api.setValue('name', 'preset')
    expect(mounted.api.fields.name.interacted).toBe(false)
  })

  it('is cleared by reset', async () => {
    mounted = await mountField()
    typeInto(mounted.input, 'champion')
    expect(mounted.api.fields.name.interacted).toBe(true)
    mounted.api.reset()
    expect(mounted.api.fields.name.interacted).toBe(false)
  })

  it('rolls up to the form meta as a disjunction', async () => {
    mounted = await mountField()
    expect(mounted.api.meta.interacted).toBe(false)
    typeInto(mounted.input, 'a')
    // form.meta is the root container rollup: interacted once any leaf is.
    expect(mounted.api.meta.interacted).toBe(true)
  })
})
