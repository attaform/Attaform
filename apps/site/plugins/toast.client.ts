import { toast as vueSonnerToast } from 'vue-sonner'

// Expose `toast` as a window-level global on the docs surface so demo
// SFCs rendered inline via `<DocsDemo>` find it the same way they find
// it inside the playground iframe. The matching `<Toaster>` mounts in
// `app.vue` (one per app, catches every call vue-sonner's module
// singleton receives).
//
// Inside the @vue/repl preview iframe, `DemoReplEditor.client.vue`'s
// `previewOptions.customCode.useCode` writes its own `window.toast`
// that postMessages to this parent page. The iframe has its own
// `window` and its own Vue context, so the two assignments don't
// collide. Inline demos use this assignment; iframe demos use the
// shim assignment; both paths end at the same vue-sonner toast queue.
//
// Every variant is wrapped so a failure inside vue-sonner (a missing
// Toaster, a hydration race, an internal bug) can never take down the
// caller's submit handler. Toasts are visual feedback, not a critical
// path; the contract here is "best-effort display, never throw".

function attempt(action: () => void): void {
  try {
    action()
  } catch (err) {
    try {
      console.warn('[toast] suppressed:', err)
    } catch {
      // Even console.warn can throw in adversarial environments
      // (sealed console, broken inspector); fail silent.
    }
  }
}

// Normalise anything the demo passes into a plain string before it
// reaches vue-sonner. vue-sonner's `message` and `description` slots
// accept `string | VNode | Component`, so an object literal (like
// `values` from a submit handler) gets routed into the
// component-rendering pipeline and triggers two warnings:
// "received a Component that was made a reactive object" and
// "Component is missing template or render function". Stringifying
// up front sidesteps both — toasts always render as text, with
// objects shown as pretty-printed JSON.
//
// JSON.stringify automatically invokes `toJSON` when present, so
// Attaform's callable `ValuesSurface` (which carries a `toJSON`
// hook at `values-proxy.ts:106`) walks straight through to the
// underlying form data without special casing here.
//
// Nested fallbacks mirror the iframe shim's `serialize` (see
// `DemoReplEditor.client.vue`): JSON.stringify can throw on circular
// refs and BigInt; `String(v)` can throw on adversarial `toString`;
// a top-level naked callable (`typeof v === 'function'` without a
// `toJSON`) makes JSON.stringify return `undefined`-the-value, so
// we render it as `[function]` to keep the contract that serialize
// always yields a string.
function serialize(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return String(v)
  try {
    const json = JSON.stringify(v, null, 2)
    if (typeof json === 'string') return json
    if (typeof v === 'function') return '[function]'
    if (typeof v === 'symbol') return v.toString()
    return String(v)
  } catch {
    try {
      return String(v)
    } catch {
      return '[unserializable]'
    }
  }
}

function normalizeOptions(options: ToastOptions | undefined): { description?: string } | undefined {
  if (options == null) return undefined
  if (!('description' in options) || options.description === undefined) return undefined
  return { description: serialize(options.description) }
}

const safeToast: Window['toast'] = ((message, options) => {
  attempt(() =>
    (vueSonnerToast as unknown as (m: string, o?: unknown) => unknown)(
      serialize(message),
      normalizeOptions(options)
    )
  )
}) as Window['toast']

safeToast.success = (message, options) =>
  attempt(() => vueSonnerToast.success(serialize(message), normalizeOptions(options) as never))
safeToast.error = (message, options) =>
  attempt(() => vueSonnerToast.error(serialize(message), normalizeOptions(options) as never))
safeToast.info = (message, options) =>
  attempt(() => vueSonnerToast.info(serialize(message), normalizeOptions(options) as never))
safeToast.warning = (message, options) =>
  attempt(() => vueSonnerToast.warning(serialize(message), normalizeOptions(options) as never))

export default defineNuxtPlugin(() => {
  attempt(() => {
    window.toast = safeToast
  })
})
