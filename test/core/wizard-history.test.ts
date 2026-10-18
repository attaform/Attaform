// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWizardHistory,
  findRouterHistory,
  type RouterHistoryLike,
} from '../../src/runtime/core/wizard-history'

/**
 * `createWizardHistory(param, router)` encapsulates `window.history` for the
 * wizard. The primitive is the only DOM-touching module in the wizard
 * surface: it abstracts pushState / popstate behind a small handle,
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

describe('createWizardHistory: primitive', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  afterEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('push(key) calls pushState (not replaceState) and writes `?step=<key>`', () => {
    const handle = createWizardHistory('step', undefined)
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
    const handle = createWizardHistory('step', undefined)
    const pushSpy = vi.spyOn(window.history, 'pushState')
    handle.push('review') // already on `review`, dedup must skip the push
    expect(pushSpy).not.toHaveBeenCalled()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('review')
    // A genuinely different key still pushes.
    handle.push('reference')
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(new URL(window.location.href).searchParams.get('step')).toBe('reference')
    pushSpy.mockRestore()
    handle.dispose()
  })

  it('replace(key) calls replaceState (not pushState): canonicalize in place', () => {
    const handle = createWizardHistory('step', undefined)
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
    const handle = createWizardHistory('step', undefined)
    expect(handle.read()).toBeUndefined()
    handle.push('reference')
    expect(handle.read()).toBe('reference')
    handle.dispose()
  })

  it('subscribe(cb) fires the callback on popstate with the new key', async () => {
    const handle = createWizardHistory('step', undefined)
    const seen: Array<string | undefined> = []
    handle.subscribe((key) => seen.push(key))
    // Two real pushState writes so `history.back()` has somewhere to go,
    // then drive a real browser Back, popstate behaviour is
    // browser-driven and exercised through genuine navigation entries.
    window.history.pushState({}, '', `${ORIGINAL_URL}?step=a`)
    window.history.pushState({}, '', `${ORIGINAL_URL}?step=b`)
    window.history.back()
    // jsdom dispatches popstate asynchronously with no completion signal;
    // poll for the arrival instead of guessing a wall-clock delay (a fixed
    // 20ms sleep flaked under the coverage-instrumented run).
    await vi.waitFor(() => expect(seen[seen.length - 1]).toBe('a'))
    handle.dispose()
  })

  it('dispose() removes the popstate listener (idempotent)', async () => {
    const handle = createWizardHistory('step', undefined)
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

  it('does not deliver a popstate that lands on another path (#712)', () => {
    const handle = createWizardHistory('step', undefined)
    const seen: Array<string | undefined> = []
    handle.subscribe((key) => seen.push(key))
    window.history.replaceState(null, '', 'http://localhost:3000/other?step=b')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(seen).toEqual([])
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=a`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(seen).toEqual(['a'])
    handle.dispose()
  })

  it('claim() and a write each take the path on screen as its own (#712)', () => {
    const handle = createWizardHistory('step', undefined)
    const seen: Array<string | undefined> = []
    handle.subscribe((key) => seen.push(key))
    window.history.replaceState(null, '', 'http://localhost:3000/elsewhere')
    handle.claim()
    window.history.replaceState(null, '', 'http://localhost:3000/elsewhere?step=a')
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.history.replaceState(null, '', 'http://localhost:3000/moved')
    handle.push('b')
    window.history.replaceState(null, '', 'http://localhost:3000/moved?step=c')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(seen).toEqual(['a', 'c'])
    handle.dispose()
  })

  it('preserves existing search params when writing the step param', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?ref=email&utm=launch`)
    const handle = createWizardHistory('step', undefined)
    handle.push('cargo')
    const url = new URL(window.location.href)
    expect(url.searchParams.get('step')).toBe('cargo')
    expect(url.searchParams.get('ref')).toBe('email')
    expect(url.searchParams.get('utm')).toBe('launch')
    handle.dispose()
  })
})

/** A stand-in for vue-router's `RouterHistory`: its location moves with each write. */
function fakeRouterHistory(start: string): {
  history: RouterHistoryLike
  writes: Array<[string, string]>
} {
  const writes: Array<[string, string]> = []
  let location = start
  const history: RouterHistoryLike = {
    get location() {
      return location
    },
    push(to) {
      writes.push(['push', to])
      location = to
    },
    replace(to) {
      writes.push(['replace', to])
      location = to
    },
  }
  return { history, writes }
}

describe('createWizardHistory: the entry state a router keeps (#712)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('with no router, a replace keeps the entry state and a push starts with none', () => {
    window.history.replaceState({ position: 4, kept: true }, '', ORIGINAL_URL)
    const handle = createWizardHistory('step', undefined)
    handle.replace('a')
    expect(window.history.state).toEqual({ position: 4, kept: true })
    handle.push('b')
    expect(window.history.state).toBeNull()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('b')
    handle.dispose()
  })

  it('with a router, writes go through its history, relative to its base', () => {
    const { history, writes } = fakeRouterHistory('/wizard?ref=email#top')
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    const handle = createWizardHistory('step', history)
    expect(handle.read()).toBeUndefined()
    handle.replace('a')
    handle.push('b')
    handle.push('b')
    expect(writes).toEqual([
      ['replace', '/wizard?ref=email&step=a#top'],
      ['push', '/wizard?ref=email&step=b#top'],
    ])
    expect(handle.read()).toBe('b')
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    handle.dispose()
  })

  it("with a router, a popstate is read off the router's location and its path", () => {
    const { history } = fakeRouterHistory('/wizard')
    const handle = createWizardHistory('step', history)
    const seen: Array<string | undefined> = []
    handle.subscribe((key) => seen.push(key))
    history.push('/other?step=b')
    window.dispatchEvent(new PopStateEvent('popstate'))
    history.push('/wizard?step=a')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(seen).toEqual(['a'])
    handle.dispose()
  })

  it("findRouterHistory reads the history off the app's $router, and nothing else", () => {
    const { history } = fakeRouterHistory('/')
    expect(findRouterHistory({ $router: { options: { history } } })).toBe(history)
    expect(findRouterHistory({})).toBeUndefined()
    expect(findRouterHistory({ $router: null })).toBeUndefined()
    expect(findRouterHistory({ $router: { options: {} } })).toBeUndefined()
    expect(
      findRouterHistory({ $router: { options: { history: { location: '/' } } } })
    ).toBeUndefined()
  })
})
