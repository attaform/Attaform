// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { useForm } from '../../src'
import {
  attachRegistryToApp,
  createRegistry,
  type AttaformRegistry,
} from '../../src/runtime/core/registry'
import type { OnChangeContext, UseFormReturnType } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'

type Form = {
  email: string
  password: string
  profile: { name: string; age: number }
}

const defaults: Form = {
  email: '',
  password: '',
  profile: { name: '', age: 0 },
}

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

/** Mount a component whose setup runs `run` and grabs the form handle. */
function mount(
  run: (form: UseFormReturnType<Form>) => void,
  options?: {
    key?: string
    registry?: AttaformRegistry
    onChange?: Parameters<typeof useForm<Form>>[0]['onChange']
  }
) {
  let form!: UseFormReturnType<Form>
  const Probe = defineComponent({
    setup() {
      form = useForm<Form>({
        schema: fakeSchema<Form>(defaults),
        key: options?.key ?? `oc-${Math.random().toString(36).slice(2)}`,
        ...(options?.onChange ? { onChange: options.onChange } : {}),
      })
      run(form)
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, options?.registry ?? createRegistry())
  app.mount(document.createElement('div'))
  apps.push(app)
  return { app, form }
}

describe('form.onChange (composable surface)', () => {
  it('fires on a matching write and returns an idempotent stop()', () => {
    const calls: unknown[] = []
    let stop!: () => void
    const { form } = mount((f) => {
      stop = f.onChange('email', (value) => {
        calls.push(value)
      })
    })

    form.setValue('email', 'a@b.c')
    expect(calls).toEqual(['a@b.c'])

    stop()
    stop() // idempotent
    form.setValue('email', 'second')
    expect(calls).toEqual(['a@b.c'])
  })

  it('reports the prior leaf value across edits', () => {
    const previous: unknown[] = []
    const { form } = mount((f) => {
      f.onChange('email', (_value, ctx) => {
        previous.push(ctx.previous)
      })
    })

    form.setValue('email', 'a')
    form.setValue('email', 'b')
    expect(previous).toEqual(['', 'a'])
  })

  it('a root handler fires for the whole form with ctx.path empty', () => {
    let seen: { value: Form; ctx: OnChangeContext } | undefined
    const { form } = mount((f) => {
      f.onChange((value, ctx) => {
        seen = { value, ctx }
      })
    })

    form.setValue('profile.name', 'Ada')
    expect(seen?.ctx.path).toBe('')
    expect(seen?.value.profile.name).toBe('Ada')
    expect(seen?.ctx.changed).toEqual(['profile.name'])
  })

  it('ctx.form resolves to the public form handle', () => {
    let ctxForm: unknown
    const { form } = mount((f) => {
      f.onChange('email', (_value, ctx) => {
        ctxForm = ctx.form
      })
    })

    form.setValue('email', 'x')
    expect(ctxForm).toBe(form)
  })

  it('auto-stops when its component unmounts, leaving a sibling consumer’s writes unheard', () => {
    // Share one store across two consumers via a shared registry + key. The
    // driver stays mounted; the listener unmounts. onScopeDispose must remove
    // the listener's handler while the store (and driver) live on.
    const registry = createRegistry()
    const calls: unknown[] = []

    const driver = mount(() => {}, { key: 'shared', registry })
    mount(
      (f) => {
        f.onChange('email', (value) => {
          calls.push(value)
        })
      },
      { key: 'shared', registry }
    )

    driver.form.setValue('email', 'x')
    expect(calls).toEqual(['x'])

    // Unmount the listener (the last app pushed). The driver remains.
    apps.pop()?.unmount()

    driver.form.setValue('email', 'y')
    expect(calls).toEqual(['x'])
  })
})

describe('useForm({ onChange })', () => {
  it('registers a whole-form handler at construction', () => {
    const calls: { value: Form; ctx: OnChangeContext }[] = []
    const { form } = mount(() => {}, {
      onChange: (value, ctx) => {
        calls.push({ value: value as Form, ctx })
      },
    })

    form.setValue('email', 'x')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.ctx.path).toBe('')
    expect(calls[0]?.value.email).toBe('x')
  })

  it('accepts the { handler, onError } object form and routes throws', () => {
    const onError = vi.fn()
    const boom = new Error('boom')
    const { form } = mount(() => {}, {
      onChange: {
        handler: () => {
          throw boom
        },
        onError,
      },
    })

    expect(() => form.setValue('email', 'x')).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBe(boom)
  })

  it('exposes the form handle on ctx.form', () => {
    let ctxForm: unknown
    const { form } = mount(() => {}, {
      onChange: (_value, ctx) => {
        ctxForm = ctx.form
      },
    })

    form.setValue('email', 'x')
    expect(ctxForm).toBe(form)
  })
})

describe('setValue({ silent })', () => {
  it('a silent path write lands the value but does not fire onChange', () => {
    const calls: unknown[] = []
    const { form } = mount((f) => {
      f.onChange('email', (value) => {
        calls.push(value)
      })
    })

    expect(form.setValue('email', 'hydrated', { silent: true })).toBe(true)
    expect(form.values.email).toBe('hydrated')
    expect(calls).toHaveLength(0)

    // A subsequent ordinary write fires normally — the flag is per-call.
    form.setValue('email', 'typed')
    expect(calls).toEqual(['typed'])
  })

  it('a silent whole-form write lands but does not fire onChange', () => {
    const calls: unknown[] = []
    const { form } = mount((f) => {
      f.onChange((value) => {
        calls.push(value)
      })
    })

    form.setValue({ email: 'a', password: 'b', profile: { name: '', age: 0 } }, { silent: true })
    expect(form.values.email).toBe('a')
    expect(calls).toHaveLength(0)
  })

  it('a non-silent write is unaffected by the new options arg', () => {
    const calls: unknown[] = []
    const { form } = mount((f) => {
      f.onChange('email', (value) => {
        calls.push(value)
      })
    })

    form.setValue('email', 'x')
    expect(calls).toEqual(['x'])
  })
})
