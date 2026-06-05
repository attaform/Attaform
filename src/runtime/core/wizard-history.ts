/**
 * Browser-history primitive for `useWizard`. Encapsulates the only
 * DOM-touching surface in the wizard module so the composable can
 * stay framework-agnostic — no `useRoute()`, no vue-router, no Nuxt
 * coupling.
 *
 * The handle exposes five operations:
 *   - `push(key)` — write `key` into `?<param>=<key>` via pushState so
 *     the step earns a real history entry and the browser Back /
 *     Forward buttons walk the flow. Deduped: a no-op when the URL is
 *     already on `key`. Preserves any other search params already on
 *     the URL.
 *   - `replace(key)` — write `key` via replaceState, canonicalizing the
 *     current entry in place without growing the stack. The wizard uses
 *     this when the target step is the URL's *effective* step (a bare
 *     `/wizard` resolves to the first step, so writing the first step is
 *     not a navigation), so Back never lands on a dead entry showing the
 *     same step, and the Forward stack survives a Back round-trip.
 *   - `read()` — read the current step key from the URL, or
 *     `undefined` if the param is absent.
 *   - `subscribe(cb)` — register a popstate listener; the callback
 *     receives the key parsed off the new URL (or `undefined`).
 *   - `dispose()` — tear down. Idempotent.
 *
 * SSR safety: when `typeof window === 'undefined'`, the factory
 * returns a no-op handle. Consumers don't have to gate calls — the
 * primitive is the gate.
 */

export type WizardHistoryHandle = {
  push(key: string): void
  replace(key: string): void
  read(): string | undefined
  subscribe(callback: (key: string | undefined) => void): void
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
  dispose() {},
}

export function createWizardHistory(param: string): WizardHistoryHandle {
  if (typeof window === 'undefined') return NOOP_WIZARD_HISTORY

  const subscribers: Array<(key: string | undefined) => void> = []
  let disposed = false

  function currentKey(): string | undefined {
    return new URL(window.location.href).searchParams.get(param) ?? undefined
  }

  function buildUrl(key: string): string {
    const url = new URL(window.location.href)
    url.searchParams.set(param, key)
    return url.toString()
  }

  function handlePopstate(): void {
    if (disposed) return
    const value = currentKey()
    for (const subscriber of subscribers) subscriber(value)
  }

  window.addEventListener('popstate', handlePopstate)

  // Some embedded contexts can't accept a same-document URL rewrite —
  // most commonly `about:srcdoc` iframes (e.g. Vue REPL previews),
  // sandboxed iframes, and data: URLs. In those, `buildUrl(key)`
  // resolves to a URL whose origin doesn't match the document's
  // (the document inherits the parent's origin, but the synthesized
  // URL keeps the scheme), and the History API throws `SecurityError`.
  // The user-visible step state still works — `current` / `goTo()`
  // drive the form via the in-memory wizard — they just won't appear in
  // the URL bar. Silently swallowing keeps the preview functional
  // without coupling the library to embed-detection logic.
  function safeWrite(key: string, mode: 'push' | 'replace'): void {
    try {
      if (mode === 'push') window.history.pushState({}, '', buildUrl(key))
      else window.history.replaceState({}, '', buildUrl(key))
    } catch {
      // SecurityError or similar — origin mismatch, sandboxed history,
      // or a host that's locked down the History API. No remediation
      // possible here; the in-memory wizard state remains the source
      // of truth.
    }
  }

  return {
    push(key) {
      if (disposed) return
      // Dedup: skip when the URL is already on `key`. Pushing an
      // identical step would stack a duplicate entry — most visibly on
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
    dispose() {
      if (disposed) return
      disposed = true
      subscribers.length = 0
      window.removeEventListener('popstate', handlePopstate)
    },
  }
}
