// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWizardHistory } from '../../src/runtime/core/wizard-history'

/**
 * `createWizardHistory(param)` encapsulates `window.history` for the
 * wizard. The primitive is the only DOM-touching module in the wizard
 * surface — it abstracts pushState / popstate behind a small handle,
 * lets the wizard composable stay focused on navigation semantics, and
 * stays SSR-safe by returning a no-op handle when `window` is undefined.
 *
 * Authored contract (deliberate): `push(key)` writes the step via
 * `history.pushState`, NOT `replaceState`, so each step earns a real
 * history entry and the browser Back / Forward buttons walk the flow. A
 * multi-step form is filled slowly (minutes per step), so Back behaving
 * like genuine navigation is the natural expectation. The one carve-out
 * is dedup: `push(key)` is a no-op when the URL is already on `key`, so
 * the popstate -> restore -> persist round-trip can't stack a duplicate
 * entry (and a re-persist of the current step never grows the stack).
 */

const ORIGINAL_URL = 'http://localhost:3000/wizard'

describe('createWizardHistory — primitive', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  afterEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('push(key) calls pushState (not replaceState) and writes `?step=<key>`', () => {
    const handle = createWizardHistory('step')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    const replaceSpy = vi.spyOn(window.history, 'replaceState')
    handle.push('review')
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('review')
    pushSpy.mockRestore()
    replaceSpy.mockRestore()
    handle.dispose()
  })

  it('push(key) is a no-op when the URL is already on `<key>` (no duplicate entry)', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=review`)
    const handle = createWizardHistory('step')
    const pushSpy = vi.spyOn(window.history, 'pushState')
    handle.push('review') // already on `review` — dedup must skip the push
    expect(pushSpy).not.toHaveBeenCalled()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('review')
    // A genuinely different key still pushes.
    handle.push('reference')
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(new URL(window.location.href).searchParams.get('step')).toBe('reference')
    pushSpy.mockRestore()
    handle.dispose()
  })

  it('replace(key) calls replaceState (not pushState) — canonicalize in place', () => {
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
    handle.push('reference')
    expect(handle.read()).toBe('reference')
    handle.dispose()
  })

  it('subscribe(cb) fires the callback on popstate with the new key', async () => {
    const handle = createWizardHistory('step')
    const seen: Array<string | undefined> = []
    handle.subscribe((key) => seen.push(key))
    // Two real pushState writes so `history.back()` has somewhere to go,
    // then drive a real browser Back — popstate behaviour is
    // browser-driven and exercised through genuine navigation entries.
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
    handle.push('a')
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
    handle.push('cargo')
    const url = new URL(window.location.href)
    expect(url.searchParams.get('step')).toBe('cargo')
    expect(url.searchParams.get('ref')).toBe('email')
    expect(url.searchParams.get('utm')).toBe('launch')
    handle.dispose()
  })
})
