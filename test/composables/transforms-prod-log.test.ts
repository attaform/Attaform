// @vitest-environment jsdom
//
// Test #8 from the transforms plan: prod log shape (information-leak guard).
//
// Lives in a SEPARATE file because `__DEV__` (in src/runtime/core/dev.ts) is
// computed at module-load time from `process.env.NODE_ENV`. To exercise the
// prod branch of the directive's transform error logging we need to mock the
// dev module before the directive is imported — vi.mock is hoisted by vitest
// to the top of the file, so the import order works out only if the mock and
// the imports live in a fresh test file. In the main test file `__DEV__` is
// already cached at `true`, so swapping it locally is a no-op.
//
// Critical regression guard: a future contributor accidentally widening the
// prod-branch payload (path, transform name, error message, stack) is an
// information-leak surface. The transform body is consumer code we don't
// control; error messages may construct strings from user-typed values.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/runtime/core/dev', () => ({ __DEV__: false }))

import { createApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z } from 'zod'
import { useForm, type UseFormReturn } from '../../src/zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

describe('register({ transforms }) — prod log shape (information-leak guard)', () => {
  let app: App | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('throws use the fixed prod string with no path / index / message / stack', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sensitiveError = new Error('SECRET_VALUE_email_was_xyz@private.com')
    sensitiveError.stack =
      'Error: SECRET_VALUE_email_was_xyz@private.com\n    at /home/me/secret/path/file.ts:42'

    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema: z.object({ email: z.string() }),
          key: `prod-${Math.random().toString(36).slice(2)}`,
        })
        const rv = api.register('email', {
          transforms: [
            (_: unknown) => {
              throw sensitiveError
            },
          ],
        })
        return () => withDirectives(h('input', { type: 'text' }), [[vRegister, rv]])
      },
    })

    app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => root.firstElementChild)

    const input = root.firstElementChild as HTMLInputElement
    input.value = 'abc'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await waitUntil(() => (errSpy.mock.calls.length > 0 ? true : null))

    expect(errSpy).toHaveBeenCalled()
    // The prod log is a single argument (no second-positional error object).
    const calls = errSpy.mock.calls
    expect(calls.length).toBe(1)
    const call = calls[0]
    if (call === undefined) throw new Error('no call')

    // Single arg, fixed string.
    expect(call.length).toBe(1)
    const msg = String(call[0])
    // The whole prod payload is the fixed AF14 code + reference URL;
    // the /e/AF14 page carries the "set NODE_ENV=development" guidance.
    expect(msg).toBe('[attaform] AF14 attaform.dev/e/AF14')

    // The leak surface — every one of these MUST be absent.
    expect(msg).not.toContain('email') // path
    expect(msg).not.toContain('index 0') // transform index
    expect(msg).not.toContain('SECRET_VALUE') // error message
    expect(msg).not.toContain('xyz@private.com') // user-typed-derived content
    expect(msg).not.toContain('/home/me') // stack-frame file path
    expect(msg).not.toContain(':42') // line number from stack

    errSpy.mockRestore()
  })

  it('async transforms defer and commit in prod with no console output', async () => {
    // The inverse of the old "Promise returns abort + log" contract: a
    // thenable now defers and commits the resolved value. In prod that
    // path stays silent — a resolving transform is the happy path, and a
    // rejecting one surfaces on `field.transformError`, never the console
    // (the information-leak guard this file exists to hold).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const schema = z.object({ email: z.string() })
    const handle: { api?: UseFormReturn<typeof schema> } = {}
    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema,
          key: `prod-async-${Math.random().toString(36).slice(2)}`,
        })
        handle.api = api
        const rv = api.register('email', {
          transforms: [(v: unknown) => Promise.resolve(String(v).toUpperCase())],
        })
        return () => withDirectives(h('input', { type: 'text' }), [[vRegister, rv]])
      },
    })

    app = createApp(Parent).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => root.firstElementChild)

    const input = root.firstElementChild as HTMLInputElement
    input.value = 'abc'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const api = handle.api
    if (api === undefined) throw new Error('no api')
    await api.settleTransforms()

    expect(api.values.email).toBe('ABC')
    expect(errSpy).not.toHaveBeenCalled()

    errSpy.mockRestore()
  })
})
