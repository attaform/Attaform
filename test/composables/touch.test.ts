// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * `form.touch(path?)`, programmatic mark-as-interacted.
 *
 * The maintainer's gap: when a field is populated programmatically
 * (file import, paste, autofill), there's no ergonomic way to mark
 * it touched. The DOM workaround `el.focus(); el.blur()` reaches
 * around the abstraction; `form.touch(path)` closes the gap.
 *
 * Contract:
 *   - leaf path: marks that one field touched
 *   - container path: walks the subtree, marks each leaf touched
 *   - no arg: walks the whole form, marks every leaf touched
 *   - touched is sticky-true; the call is idempotent
 *   - does NOT clobber focused/blurred (DOM-owned), value, or
 *     trigger validation
 *
 * Mirrored across both adapters (v3 + v4) so the surface is
 * adapter-agnostic.
 */

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountWithApp<T>(setup: () => T): T {
  const handle: { captured?: T } = {}
  const App = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

async function flushValidations(form: { meta: { validating: boolean } }): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await nextTick()
    if (!form.meta.validating) break
  }
  await nextTick()
  await nextTick()
}

type FormWithTouch = {
  touch: (path?: string | readonly (string | number)[]) => void
  fields: (path?: string | readonly (string | number)[]) => { touched: boolean }
  meta: { validating: boolean }
  setValue: (path: string, value: unknown) => boolean
  values: (path?: string | readonly (string | number)[]) => unknown
}

function asTouchable<F>(form: F): F & FormWithTouch {
  return form as unknown as F & FormWithTouch
}

// v3 adapter

describe('form.touch: zod-v3 adapter', () => {
  const schema = zV3.object({
    email: zV3.string().min(1),
    profile: zV3.object({
      name: zV3.string().min(1),
      age: zV3.number().int().min(0),
    }),
  })

  function makeForm() {
    return mountWithApp(() =>
      useFormV3({
        schema,
        key: `touch-v3-${Math.random()}`,
        defaultValues: { email: '', profile: { name: '', age: 0 } },
      })
    )
  }

  it('marks a leaf path touched', async () => {
    const form = asTouchable(makeForm())
    expect(form.fields('email').touched).toBe(false)
    form.touch('email')
    await nextTick()
    expect(form.fields('email').touched).toBe(true)
  })

  it('idempotent: touching twice keeps touched=true', async () => {
    const form = asTouchable(makeForm())
    form.touch('email')
    await nextTick()
    form.touch('email')
    await nextTick()
    expect(form.fields('email').touched).toBe(true)
  })

  it('container path marks every leaf under it', async () => {
    const form = asTouchable(makeForm())
    form.touch('profile')
    await nextTick()
    expect(form.fields('profile.name').touched).toBe(true)
    expect(form.fields('profile.age').touched).toBe(true)
    // Sibling leaf untouched
    expect(form.fields('email').touched).toBe(false)
  })

  it('no-arg form marks every leaf in the form', async () => {
    const form = asTouchable(makeForm())
    form.touch()
    await nextTick()
    expect(form.fields('email').touched).toBe(true)
    expect(form.fields('profile.name').touched).toBe(true)
    expect(form.fields('profile.age').touched).toBe(true)
  })

  it('segment-array form is equivalent to dotted-string', async () => {
    const form = asTouchable(makeForm())
    form.touch(['profile', 'name'])
    await nextTick()
    expect(form.fields('profile.name').touched).toBe(true)
    expect(form.fields('profile.age').touched).toBe(false)
  })

  it('does not modify value', async () => {
    const form = asTouchable(makeForm())
    const before = JSON.stringify(form.values())
    form.touch()
    await nextTick()
    const after = JSON.stringify(form.values())
    expect(after).toBe(before)
  })

  it('does not trigger validation', async () => {
    const form = asTouchable(makeForm())
    form.touch()
    await flushValidations(form)
    expect(form.meta.validating).toBe(false)
  })

  it('aggregate parent watcher fires once per touch call, not N times', async () => {
    const form = asTouchable(makeForm())
    let runs = 0
    const watcher = computed(() => {
      runs += 1
      return form.fields('profile').touched
    })
    // Prime: read once to register the dep.
    expect(watcher.value).toBe(false)
    const baseline = runs
    form.touch('profile')
    await nextTick()
    // Vue may run the computed once (re-evaluation), anything more
    // means we're firing per-leaf instead of batching.
    expect(watcher.value).toBe(true)
    expect(runs - baseline).toBeLessThanOrEqual(2)
  })
})

// v4 adapter

describe('form.touch: zod-v4 adapter', () => {
  const schema = zV4.object({
    email: zV4.string().min(1),
    profile: zV4.object({
      name: zV4.string().min(1),
      age: zV4.number().int().min(0),
    }),
  })

  function makeForm() {
    return mountWithApp(() =>
      useFormV4({
        schema,
        key: `touch-v4-${Math.random()}`,
        defaultValues: { email: '', profile: { name: '', age: 0 } },
      })
    )
  }

  it('marks a leaf path touched', async () => {
    const form = asTouchable(makeForm())
    expect(form.fields('email').touched).toBe(false)
    form.touch('email')
    await nextTick()
    expect(form.fields('email').touched).toBe(true)
  })

  it('container path marks every leaf under it', async () => {
    const form = asTouchable(makeForm())
    form.touch('profile')
    await nextTick()
    expect(form.fields('profile.name').touched).toBe(true)
    expect(form.fields('profile.age').touched).toBe(true)
    expect(form.fields('email').touched).toBe(false)
  })

  it('no-arg form marks every leaf in the form', async () => {
    const form = asTouchable(makeForm())
    form.touch()
    await nextTick()
    expect(form.fields('email').touched).toBe(true)
    expect(form.fields('profile.name').touched).toBe(true)
    expect(form.fields('profile.age').touched).toBe(true)
  })

  it('does not trigger validation', async () => {
    const form = asTouchable(makeForm())
    form.touch()
    await flushValidations(form)
    expect(form.meta.validating).toBe(false)
  })
})

// A container holding no field: an empty list

describe('form.touch: an empty list, zod-V3 adapter', () => {
  const schema = zV3.object({
    team: zV3.object({
      name: zV3.string(),
      rows: zV3.array(zV3.object({ n: zV3.string() })).min(1),
    }),
    tags: zV3.array(zV3.string()),
  })

  function makeForm() {
    return mountWithApp(() =>
      useFormV3({
        schema,
        key: `touch-list-v3-${Math.random()}`,
        defaultValues: { team: { name: '', rows: [] }, tags: [] },
      })
    )
  }

  it('marks the list touched, and its parent reads it', async () => {
    const form = makeForm()
    form.touch('team.rows')
    await nextTick()
    expect(form.fields('team.rows').touched).toBe(true)
    expect(form.fields('team').touched).toBe(true)
    // `touch` writes `touched` alone, so the list's error stays shut.
    expect(form.fields('team.rows').interacted).toBe(false)
    expect(form.fields('team.rows').showErrors).toBe(false)
    expect(form.fields.team.name.touched).toBe(false)
    expect(form.fields('tags').touched).toBe(false)
  })

  it('a container path reaches the empty list under it', async () => {
    const form = makeForm()
    form.touch('team')
    await nextTick()
    expect(form.fields.team.name.touched).toBe(true)
    expect(form.fields('team.rows').touched).toBe(true)
    expect(form.fields('tags').touched).toBe(false)
  })

  it('does not dev-warn for an empty list, and still warns for a typo', () => {
    const form = makeForm()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    form.touch('tags')
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('form.touch()'))
    form.touch(['team', 'nope'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('form.touch()'))
    warn.mockRestore()
  })
})

describe('form.touch: an empty list, zod-V4 adapter', () => {
  const schema = zV4.object({
    team: zV4.object({
      name: zV4.string(),
      rows: zV4.array(zV4.object({ n: zV4.string() })).min(1),
    }),
    tags: zV4.array(zV4.string()),
  })

  function makeForm() {
    return mountWithApp(() =>
      useFormV4({
        schema,
        key: `touch-list-v4-${Math.random()}`,
        defaultValues: { team: { name: '', rows: [] }, tags: [] },
      })
    )
  }

  it('marks the list touched, and its parent reads it', async () => {
    const form = makeForm()
    form.touch('team.rows')
    await nextTick()
    expect(form.fields('team.rows').touched).toBe(true)
    expect(form.fields('team').touched).toBe(true)
    // `touch` writes `touched` alone, so the list's error stays shut.
    expect(form.fields('team.rows').interacted).toBe(false)
    expect(form.fields('team.rows').showErrors).toBe(false)
    expect(form.fields.team.name.touched).toBe(false)
    expect(form.fields('tags').touched).toBe(false)
  })

  it('a container path reaches the empty list under it', async () => {
    const form = makeForm()
    form.touch('team')
    await nextTick()
    expect(form.fields.team.name.touched).toBe(true)
    expect(form.fields('team.rows').touched).toBe(true)
    expect(form.fields('tags').touched).toBe(false)
  })

  it('does not dev-warn for an empty list, and still warns for a typo', () => {
    const form = makeForm()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    form.touch('tags')
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('form.touch()'))
    form.touch(['team', 'nope'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('form.touch()'))
    warn.mockRestore()
  })
})
