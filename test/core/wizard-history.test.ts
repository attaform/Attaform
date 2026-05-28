// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWizardHistory } from '../../src/runtime/core/wizard-history'

/**
 * `createWizardHistory(param)` encapsulates `window.history` for the
 * wizard. The primitive is the only DOM-touching module in the
 * wizard surface — it abstracts replaceState / popstate behind a
 * small handle, lets the wizard composable stay focused on
 * navigation semantics, and stays SSR-safe by returning a no-op
 * handle when `window` is undefined.
 */

const ORIGINAL_URL = 'http://localhost:3000/wizard'

describe('createWizardHistory — primitive', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  afterEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('replace(key) calls replaceState and writes `?step=<key>`', () => {
    const handle = createWizardHistory('step')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    handle.replace('review')
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy).not.toHaveBeenCalled()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('review')
    pushSpy.mockRestore()
    replaceSpy.mockRestore()
    handle.dispose()
  })

  it('read() returns the current step param value (or undefined)', () => {
    const handle = createWizardHistory('step')
    expect(handle.read()).toBeUndefined()
    handle.replace('reference')
    expect(handle.read()).toBe('reference')
    handle.dispose()
  })

  it('subscribe(cb) fires the callback on popstate with the new key', async () => {
    const handle = createWizardHistory('step')
    const seen: Array<string | undefined> = []
    handle.subscribe((key) => seen.push(key))
    // Two real pushState writes so `history.back()` has somewhere to go;
    // the handle itself only ever replaces, but popstate behaviour is
    // browser-driven and exercised through real navigation entries.
    window.history.pushState({}, '', `${ORIGINAL_URL}?step=a`)
    window.history.pushState({}, '', `${ORIGINAL_URL}?step=b`)
    window.history.back()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen[seen.length - 1]).toBe('a')
    handle.dispose()
  })

  it('dispose() removes the popstate listener (idempotent)', async () => {
    const handle = createWizardHistory('step')
    const cb = vi.fn()
    handle.subscribe(cb)
    handle.replace('a')
    handle.dispose()
    handle.dispose() // idempotent
    window.history.replaceState(null, '', ORIGINAL_URL + '?step=zzz')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(cb).not.toHaveBeenCalled()
  })

  it('preserves existing search params when writing the step param', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?ref=email&utm=launch`)
    const handle = createWizardHistory('step')
    handle.replace('cargo')
    const url = new URL(window.location.href)
    expect(url.searchParams.get('step')).toBe('cargo')
    expect(url.searchParams.get('ref')).toBe('email')
    expect(url.searchParams.get('utm')).toBe('launch')
    handle.dispose()
  })
})
