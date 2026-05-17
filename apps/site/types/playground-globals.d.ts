// Ambient declarations for the playground iframe's runtime globals.
//
// Demo SFCs under `apps/site/docs-demos/` and `apps/site/repl-demos/`
// run inside @vue/repl's preview iframe, where
// `DemoReplEditor.client.vue` injects a `window.toast` shim via
// `previewOptions.customCode.useCode`. The shim postMessages to the
// parent docs page, which routes the call to `vue-sonner`'s
// `<Toaster>` mounted in `<DemoRepl>`.
//
// Two declaration surfaces, kept in lock-step:
//
//   1. THIS FILE — read by vue-tsc on the build server. Picked up
//      automatically from `apps/site/types/` via Nuxt's tsconfig
//      include.
//   2. `apps/site/components/demo/DemoReplEditor.client.vue` —
//      defines `TOAST_AMBIENT_DTS` and injects it into Volar's
//      in-Monaco TS service via `store.addFile(new File(...))`. The
//      in-iframe type universe is separate from vue-tsc's, so the
//      same shape needs to be expressed in both places.
//
// Demos call `toast('…')` / `toast.success('…', { description: … })`
// without an import — same shape real Vue apps wire up via a toast
// plugin or composable. A demo can be lifted into real app code
// with `import { toast } from 'vue-sonner'` and every call site
// keeps working because our type matches vue-sonner's accepted
// surface for these variants.

export {}

declare global {
  /**
   * JSON-serialisable payload accepted by every toast call. Strings
   * render verbatim; objects and arrays auto-pretty-format as JSON,
   * so passing a form's `values` straight in shows the submitted
   * shape inline.
   *
   * Exotic types (Map, Set, Symbol, BigInt, Date instances) are
   * deliberately excluded: their `JSON.stringify` output is lossy or
   * empty and would surface as `{}` in the toast.
   */
  type ToastBody =
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly ToastBody[]
    | { readonly [key: string]: ToastBody }

  interface ToastOptions {
    /**
     * Secondary text below the title. Same JSON-formatting rules as
     * the message: strings render as-is, objects and arrays pretty-print.
     */
    description?: ToastBody
  }

  /**
   * Toast notification API. Call shape mirrors `vue-sonner`'s `toast`
   * one-to-one, so a demo built around it can be lifted into a real
   * Vue app by adding `import { toast } from 'vue-sonner'` with zero
   * call-site changes.
   */
  interface ToastApi {
    /**
     * Display a default toast (neutral styling). Use for status
     * updates that aren't success, error, info, or warning.
     *
     * @example
     *   toast('Saving draft…')
     */
    (message: ToastBody, options?: ToastOptions): void
    /**
     * Display a success toast (green accent). Use after a submit
     * resolves cleanly.
     *
     * @example
     *   toast.success('Subscribed!', { description: values })
     */
    success(message: ToastBody, options?: ToastOptions): void
    /**
     * Display an error toast (red accent). Use when a submit rejects
     * or the server returns an error payload.
     *
     * @example
     *   toast.error('Could not save, try again.')
     */
    error(message: ToastBody, options?: ToastOptions): void
    /**
     * Display an info toast (blue accent). Use for non-blocking
     * heads-up messages like schema hints or deprecation notes.
     *
     * @example
     *   toast.info('Heads up: the schema accepts both shapes.')
     */
    info(message: ToastBody, options?: ToastOptions): void
    /**
     * Display a warning toast (amber accent). Use for non-fatal but
     * attention-worthy states.
     *
     * @example
     *   toast.warning('Some fields were truncated to fit.')
     */
    warning(message: ToastBody, options?: ToastOptions): void
  }

  /**
   * Display a toast notification in the docs viewport.
   *
   * Playground-only convenience: `toast` is injected by the
   * `DemoReplEditor` component and routes through `postMessage` to
   * a `vue-sonner` `<Toaster>` mounted in the parent docs page.
   * Outside the playground iframe it does not exist.
   *
   * @example
   *   toast.success('Subscribed!', { description: values })
   *   toast.error('Submit blocked, check the errors above.')
   *   toast.info('Heads up: the schema accepts both shapes.')
   */
  const toast: ToastApi
}
