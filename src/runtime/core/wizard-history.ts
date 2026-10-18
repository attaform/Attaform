/**
 * Browser-history primitive for `useWizard`. Encapsulates the only
 * DOM-touching surface in the wizard module so the composable can
 * stay framework-agnostic: no `useRoute()`, no dependency on vue-router,
 * no Nuxt coupling.
 *
 * A router owns the history entries it writes, and vue-router keeps its
 * own record on each one: where it sits, its scroll, the entries either
 * side, and its own address, which it writes back onto the entry when it
 * next navigates. An entry written behind its back loses that record, so
 * when the app has vue-router (Nuxt included) the handle writes through
 * the router's `history`, found by shape, and reads the address from it.
 * That records the entry the way the router's own writes do, without a
 * navigation: no guards, no middleware, no route change (#712). With no
 * router the handle writes `window.history` itself, keeping an entry's
 * state on a replace and starting a new entry with none.
 *
 * The handle exposes six operations:
 *   - `push(key)`: write `key` into `?<param>=<key>` via pushState so
 *     the step earns a real history entry and the browser Back /
 *     Forward buttons walk the flow. Deduped: a no-op when the URL is
 *     already on `key`. Preserves any other search params already on
 *     the URL.
 *   - `replace(key)`: write `key` via replaceState, canonicalizing the
 *     current entry in place without growing the stack. The wizard uses
 *     this when the target step is the URL's *effective* step (a bare
 *     `/wizard` resolves to the first step, so writing the first step is
 *     not a navigation), so Back never lands on a dead entry showing the
 *     same step, and the Forward stack survives a Back round-trip.
 *   - `read()`: read the current step key from the URL, or
 *     `undefined` if the param is absent.
 *   - `subscribe(cb)`: register a popstate listener whose callback
 *     receives the key parsed off the new URL (or `undefined`). A
 *     popstate that lands on another path is not delivered: it left the
 *     wizard's page, and the browser fires it before the router takes
 *     that page off screen (#712).
 *   - `claim()`: take the path on screen as the wizard's own. A write
 *     claims the path it lands on too.
 *   - `dispose()`: tear down. Idempotent.
 *
 * SSR safety: when `typeof window === 'undefined'`, the factory
 * returns a no-op handle, so a consumer never has to gate a call: the
 * primitive is the gate.
 */

/**
 * The parts of vue-router's `RouterHistory` the handle writes through.
 * `location` is the address relative to the router's base: in hash mode,
 * the part after the `#`.
 */
export type RouterHistoryLike = {
  readonly location: string
  push(to: string): void
  replace(to: string): void
}

/**
 * The history of the vue-router installed on an app, read off the app's
 * `$router` by shape, or `undefined` when there is none.
 */
export function findRouterHistory(globals: object): RouterHistoryLike | undefined {
  const router: unknown = Reflect.get(globals, '$router')
  if (typeof router !== 'object' || router === null || !('options' in router)) return undefined
  const { options } = router
  if (typeof options !== 'object' || options === null || !('history' in options)) return undefined
  const { history } = options
  return isRouterHistory(history) ? history : undefined
}

function isRouterHistory(value: unknown): value is RouterHistoryLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'location' in value &&
    typeof value.location === 'string' &&
    'push' in value &&
    typeof value.push === 'function' &&
    'replace' in value &&
    typeof value.replace === 'function'
  )
}

// A router's location is a path, so it is read against a placeholder
// origin: only its path, search and hash are used.
const ROUTER_ORIGIN = 'http://router.invalid'

export type WizardHistoryHandle = {
  push(key: string): void
  replace(key: string): void
  read(): string | undefined
  subscribe(callback: (key: string | undefined) => void): void
  claim(): void
  dispose(): void
}

/**
 * No-op handle. Returned by `createWizardHistory` on SSR (no
 * `window`) and assigned directly when the consumer passes
 * `history: false`. Every method is a safe call-site shim.
 */
export const NOOP_WIZARD_HISTORY: WizardHistoryHandle = {
  push() {},
  replace() {},
  read() {
    return undefined
  },
  subscribe() {},
  claim() {},
  dispose() {},
}

export function createWizardHistory(
  param: string,
  router: RouterHistoryLike | undefined
): WizardHistoryHandle {
  if (typeof window === 'undefined') return NOOP_WIZARD_HISTORY

  const subscribers: Array<(key: string | undefined) => void> = []
  let disposed = false

  function address(): URL {
    return router === undefined
      ? new URL(window.location.href)
      : new URL(router.location, ROUTER_ORIGIN)
  }

  function currentKey(): string | undefined {
    return address().searchParams.get(param) ?? undefined
  }

  let ownPath = address().pathname

  // The router's own popstate listener was added when the router was
  // created, before any wizard, so by now its `location` is the new one.
  function handlePopstate(): void {
    if (disposed || address().pathname !== ownPath) return
    const value = currentKey()
    for (const subscriber of subscribers) subscriber(value)
  }

  window.addEventListener('popstate', handlePopstate)

  // Some embedded contexts cannot accept a same-document URL rewrite,
  // most commonly an `about:srcdoc` iframe (a Vue REPL preview),
  // sandboxed iframes, and data: URLs. In those, the address written
  // resolves to a URL whose origin doesn't match the document's
  // (the document inherits the parent's origin, but the synthesized
  // URL keeps the scheme), and the History API throws `SecurityError`.
  // The user-visible step state still works, `current` and `goTo()`
  // driving the form through the in-memory wizard; they just do not
  // appear in the URL bar. Silently swallowing keeps the preview
  // working without coupling Attaform to embed-detection logic.
  function safeWrite(key: string, mode: 'push' | 'replace'): void {
    const url = address()
    url.searchParams.set(param, key)
    try {
      if (router !== undefined) router[mode](url.pathname + url.search + url.hash)
      // A router that finds an entry with no state of its own adopts it as
      // one it did not write, so a new entry starts with none.
      else if (mode === 'push') window.history.pushState(null, '', url.href)
      else window.history.replaceState(window.history.state, '', url.href)
      ownPath = url.pathname
    } catch {
      // SecurityError or similar: an origin mismatch, sandboxed history,
      // or a host that's locked down the History API. No remediation
      // possible here; the in-memory wizard state remains the source
      // of truth.
    }
  }

  return {
    push(key) {
      if (disposed) return
      // Dedup: skip when the URL is already on `key`. Pushing an
      // identical step would stack a duplicate entry, most visibly on
      // the popstate -> restore -> persist round-trip, where a Back that
      // lands on `?<param>=<key>` re-fires the persist watcher.
      if (currentKey() === key) return
      safeWrite(key, 'push')
    },
    replace(key) {
      if (disposed) return
      safeWrite(key, 'replace')
    },
    read() {
      return currentKey()
    },
    subscribe(callback) {
      if (disposed) return
      subscribers.push(callback)
    },
    claim() {
      ownPath = address().pathname
    },
    dispose() {
      if (disposed) return
      disposed = true
      subscribers.length = 0
      window.removeEventListener('popstate', handlePopstate)
    },
  }
}
