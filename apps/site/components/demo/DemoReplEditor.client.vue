<script setup lang="ts">
  import { File, Repl, useStore } from '@vue/repl'
  import MonacoEditor from '@vue/repl/monaco-editor'
  import '@vue/repl/style.css'
  import { toast } from 'vue-sonner'

  // The shipment demo lives in repl-demos/shipment-demo.vue so vue-tsc +
  // eslint review it as a real SFC. We import its source text via
  // Vite's `?raw` query and ship that string to @vue/repl. The same
  // source is both type-checked at build time AND served to users —
  // no extraction step, no drift.
  //
  // The shipment demo is also the *default* seed: the homepage REPL
  // and the freeform `/play/blank` playground render it untouched.
  // `/play/<slug>` pages override via the `initialSource` prop with
  // an `apps/site/docs-demos/<slug>.vue` source string, so the same
  // editor chrome reads from a different starting point per route.
  import shipmentDemoSource from '~/repl-demos/shipment-demo.vue?raw'

  const props = withDefaults(
    defineProps<{
      initialSource?: string
      // Multi-file seed: explicit `{ 'src/<path>.vue': '<source>' }` map.
      // Wins over `initialSource` when present. The entry point must
      // be at `src/App.vue` (matches @vue/repl's default mainFile).
      initialFiles?: Record<string, string>
    }>(),
    { initialSource: () => shipmentDemoSource }
  )

  // Sizing + lifecycle (SSR skeleton, deferred mount, route-leave
  // guard) live on the parent `<DemoRepl>` shell. This component is
  // pure editor: it expects to be mounted only when the host wrapper
  // is in the DOM and the page transition has settled, so the
  // Sandbox-iframe race documented at the top of `<DemoRepl>` can't
  // fire here.

  // Worker URL override — runs once at module load on the client.
  //
  // The Monaco preset bundles its workers and spawns them via
  // `new Worker(new URL("assets/<chunk>.js", import.meta.url), { type: 'module' })`.
  // In dev, Vite injects its `@vite/client` HMR bootstrap into those
  // worker files — and @vite/client's module-level WebSocket setup
  // fails to handshake from a worker context, killing every worker
  // at startup. The `bundle-repl-deps.mjs` script copies clean
  // copies of those worker chunks to `/lib/repl-workers/`, served
  // by Nitro as static files (no Vite injection).
  //
  // We can't replace `MonacoEnvironment.getWorker` directly: the
  // @vue/repl bundle's getWorker does a non-trivial init handshake
  // for the Vue worker (postMessage of resourceLinks, tsVersion,
  // etc.) that our override would have to reimplement against the
  // store. Instead, monkey-patch the `Worker` constructor itself —
  // intercept only the `assets/(editor|vue).worker-*.js` URLs and
  // rewrite them to the static copies, leaving every other Worker
  // construction alone. The init handshake then runs unchanged
  // because @vue/repl doesn't care which URL the worker came from.
  if (import.meta.client && !('__attaformReplWorkerPatched' in self)) {
    Object.defineProperty(self, '__attaformReplWorkerPatched', { value: true })
    const Original = self.Worker
    const REPL_WORKER_RE = /assets\/(editor|vue)\.worker-[^/]+\.js(?:[?#]|$)/
    self.Worker = new Proxy(Original, {
      construct(target, args: ConstructorParameters<typeof Worker>) {
        const [src, options] = args
        const href = src instanceof URL ? src.href : String(src)
        const match = REPL_WORKER_RE.exec(href)
        if (match) {
          const label = match[1]
          return new target(`/lib/repl-workers/${label}.worker.js`, options)
        }
        return new target(src, options)
      },
    })
  }

  // Monaco uses a `CancellationError` (name=Canceled, message=Canceled)
  // as a sentinel to abort pending Delayers when disposing model-bound
  // contributions like `WordHighlighter`. The error is functionally
  // harmless — it's the documented way Monaco signals "this delayed
  // job is no longer needed" — but Monaco doesn't always attach a
  // `.catch()` to the disposer's promise, so the rejection bubbles up
  // as an "Uncaught (in promise) Canceled: Canceled" line on every
  // file-create / file-switch / editor-unmount. Same monkey-patch
  // pattern as the Worker override above: install once per window,
  // guarded by a marker property so HMR remounts don't stack handlers.
  if (import.meta.client && !('__attaformReplCanceledFilter' in self)) {
    Object.defineProperty(self, '__attaformReplCanceledFilter', { value: true })
    window.addEventListener('unhandledrejection', (event) => {
      const reason: unknown = event.reason
      if (
        reason != null &&
        typeof reason === 'object' &&
        'name' in reason &&
        (reason as { name: unknown }).name === 'Canceled' &&
        'message' in reason &&
        (reason as { message: unknown }).message === 'Canceled'
      ) {
        // Swallow Monaco's cancellation sentinel; surface every other
        // unhandled rejection unchanged so real bugs still light up.
        event.preventDefault()
      }
    })
  }

  const importMap = {
    imports: {
      vue: '/lib/vue.esm-browser.prod.js',
      zod: '/lib/zod.js',
      attaform: '/lib/attaform.js',
      'attaform/zod': '/lib/attaform-zod.js',
    },
  }

  // @vue/repl auto-creates the Vue app and mounts it from `mainFile`. To
  // install our plugin we use previewOptions.customCode — `importCode`
  // appends to the iframe's import block, `useCode` runs after
  // `const app = createApp(AppComponent)` and before `app.mount('#app')`.
  // Without this the REPL boots a bare Vue app and `useForm()` throws
  // "Registry not found" because createAttaform()'s plugin never runs.
  //
  // The `useCode` body also installs a `window.toast` shim. Demos
  // call `toast('Subscribed!')` / `toast.success('Saved', {
  // description: values })` and the shim postMessages to the parent
  // docs page, where a `vue-sonner` `<Toaster>` (mounted in
  // `<DemoRepl>`) renders the toast in the docs viewport. Demos
  // don't import anything — `toast` is exposed as a playground
  // convenience global, matching the "framework helper" feel real
  // Vue apps wire up via plugins.
  //
  // The shim auto-JSON-stringifies non-string `message` and
  // `description` so demos can pass form `values` directly and see
  // the submitted payload formatted. Origin is locked to the parent
  // window's origin so a malicious in-iframe script can't post
  // forged toasts to any other window. Variants mirror vue-sonner's
  // API surface (default / success / error / info / warning) so the
  // helper name maps one-to-one to the parent-side call.
  // Every public surface is wrapped: the whole shim install (so a
  // broken environment can't crash the demo's app setup), `serialize`
  // (so adversarial `toString` can't propagate), and each `post(...)`
  // call (so a sandboxed-iframe postMessage rejection vanishes
  // silently). Toasts are visual feedback, not a critical path; the
  // contract is "best-effort display, never throw".
  const TOAST_SHIM_SOURCE = `
    try {
      const targetOrigin = ${JSON.stringify(window.location.origin)};
      const serialize = (v) => {
        if (typeof v === 'string') return v;
        if (v == null) return String(v);
        try {
          const json = JSON.stringify(v, null, 2);
          if (typeof json === 'string') return json;
          if (typeof v === 'function') return '[function]';
          if (typeof v === 'symbol') return v.toString();
          return String(v);
        } catch {
          try { return String(v); }
          catch { return '[unserializable]'; }
        }
      };
      const post = (variant) => (rawMessage, options) => {
        try {
          window.parent.postMessage({
            source: 'attaform-demo',
            kind: 'toast',
            variant,
            message: serialize(rawMessage),
            description: options && 'description' in options ? serialize(options.description) : undefined,
          }, targetOrigin);
        } catch {}
      };
      const t = post('default');
      t.success = post('success');
      t.error = post('error');
      t.info = post('info');
      t.warning = post('warning');
      window.toast = t;
    } catch {}
  `
  const previewOptions = {
    customCode: {
      importCode: `import { createAttaform } from 'attaform'`,
      useCode: `${TOAST_SHIM_SOURCE}\napp.use(createAttaform())`,
    },
  }

  // Receive the iframe's toast messages and route them to vue-sonner.
  // The Toaster lives in `app.vue` (app-wide), so the toasts float
  // over the docs viewport rather than getting clipped inside the
  // editor pane's `overflow: hidden`. The same Toaster handles
  // inline `<DocsDemo>` calls too (those go via `window.toast`
  // assigned in `plugins/toast.client.ts`); both routes end at the
  // same vue-sonner toast queue.
  //
  // Strict-origin check: only accept messages from the same origin as
  // the parent page. The @vue/repl preview iframe is srcdoc-based and
  // inherits this origin, so legitimate demo messages pass through.
  // Postmessage from any other origin (e.g., a malicious extension
  // injecting a sibling frame) is silently dropped.
  const TOAST_VARIANTS = ['default', 'success', 'error', 'info', 'warning'] as const
  type ToastVariant = (typeof TOAST_VARIANTS)[number]
  // The receiver is wrapped so a malformed message, a vue-sonner
  // failure, or any unexpected branch can't propagate out of the
  // postMessage handler and onto `window`'s error surface. Toasts
  // are visual feedback, not a critical path.
  function handleDemoMessage(event: MessageEvent) {
    try {
      if (event.origin !== window.location.origin) return
      const data = event.data as
        | {
            source?: string
            kind?: string
            variant?: string
            message?: string
            description?: string | undefined
          }
        | undefined
      if (!data || data.source !== 'attaform-demo' || data.kind !== 'toast') return
      const message = typeof data.message === 'string' ? data.message : ''
      const description = typeof data.description === 'string' ? data.description : undefined
      const variant: ToastVariant = TOAST_VARIANTS.includes(data.variant as ToastVariant)
        ? (data.variant as ToastVariant)
        : 'default'
      const options = description != null ? { description } : undefined
      if (variant === 'default') toast(message, options)
      else toast[variant](message, options)
    } catch (err) {
      try {
        console.warn('[toast] receiver suppressed:', err)
      } catch {
        // console.warn can throw in adversarial environments; swallow.
      }
    }
  }
  onMounted(() => {
    window.addEventListener('message', handleDemoMessage)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('message', handleDemoMessage)
  })

  // Route the three packages we self-host through their /lib/types/ URLs.
  // Volar (via @vue/repl's Monaco bundle) needs THREE callbacks wired up
  // on `resourceLinks` for self-hosted type bundles to work. Missing any
  // one of them silently falls back to unpkg, which doesn't have our
  // pre-release attaform — so symbols resolve to nothing.
  //
  //   - pkgFileTextUrl: returns the URL for a single file inside the
  //     package (`<pkg>/<path>`). The LSP fetches package.json, .d.ts
  //     entries, and stub runtime entries through this.
  //   - pkgDirUrl: returns the URL for a JSON directory listing of the
  //     package (the file is `meta.json`, format `{ files: [...] }`,
  //     mimicking unpkg's `?meta` endpoint). Volar's worker uses this
  //     for EVERY file-existence check via _stat — without it, the LSP
  //     can't confirm `attaform/zod.d.ts` exists and resolution fails.
  //   - pkgLatestVersionUrl: returns a URL whose JSON exposes a
  //     `version` field. Defaults to unpkg's "@latest/package.json".
  //     We point it at our package.json. Strictly speaking this gets
  //     skipped when `dependencyVersion` (below) pins the version, but
  //     leaving it in keeps the fallback path local-only.
  //
  // Anything outside our allowlist falls through to @vue/repl's default
  // unpkg resolver. That happens occasionally for transitive type-only
  // deps; we accept the CDN fetch there.
  //
  // Two non-obvious constraints, both imposed by @vue/repl shipping
  // these resolvers string-serialized to the type-checking worker:
  //
  //   1. Must be an arrow function (or function expression). The worker
  //      reconstructs via `Function('return ' + str)()` (vue.worker.js
  //      `createFunc`). Method-shorthand `name(...) { ... }` gives
  //      `return name(...) { ... }` — a syntax error.
  //   2. No closure over outer scope. The reconstructed function runs
  //      in the worker's global scope; module-scoped consts become
  //      ReferenceErrors. Inline the package allowlist in each body.
  //
  // useStore types `resourceLinks` as a Ref so consumers can swap the
  // resolver at runtime (e.g. on a "load my own types" toggle). We
  // never reassign it, but the type still demands a Ref wrapper.
  const resourceLinks = ref({
    pkgFileTextUrl: (pkgName: string, _pkgVersion: string | undefined, pkgPath: string) => {
      if (
        pkgName === 'attaform' ||
        pkgName === 'vue' ||
        pkgName === 'zod' ||
        pkgName === 'zod-v3'
      ) {
        return `/lib/types/${pkgName}/${pkgPath}`
      }
      return `https://cdn.jsdelivr.net/npm/${pkgName}/${pkgPath}`
    },
    pkgDirUrl: (pkgName: string, _pkgVersion: string | undefined, _pkgPath: string) => {
      if (
        pkgName === 'attaform' ||
        pkgName === 'vue' ||
        pkgName === 'zod' ||
        pkgName === 'zod-v3'
      ) {
        return `/lib/types/${pkgName}/meta.json`
      }
      return `https://unpkg.com/${pkgName}@${_pkgVersion || 'latest'}/${_pkgPath}/?meta`
    },
    pkgLatestVersionUrl: (pkgName: string) => {
      if (
        pkgName === 'attaform' ||
        pkgName === 'vue' ||
        pkgName === 'zod' ||
        pkgName === 'zod-v3'
      ) {
        return `/lib/types/${pkgName}/package.json`
      }
      return `https://unpkg.com/${pkgName}@latest/package.json`
    },
  })

  // Pin the versions Volar uses when constructing CDN-style URLs. Without
  // this, the worker treats every package as "latest" and round-trips
  // through pkgLatestVersionUrl (slow, and unpkg doesn't have our
  // pre-release attaform). The values flow into the worker's
  // `dependencies` map and short-circuit the latest-version lookup.
  //
  // Versions come from `runtimeConfig.public.replDependencyVersion`,
  // populated in nuxt.config.ts by reading attaform's, vue's, and
  // zod's actual package.json files. That way a `pnpm version` bump
  // updates everything in lockstep, including what `bundle-repl-deps.mjs`
  // writes into each virtual package.json — no hard-coded literal
  // here to forget about when the lib promotes from -rc.x to stable.
  const { replDependencyVersion } = useRuntimeConfig().public
  const dependencyVersion = ref(replDependencyVersion)

  // Monaco theme follows the site's color mode via the `<Repl>`
  // component's reactive `theme` prop ('light' | 'dark'). The
  // Monaco preset internally maps that to Shiki's bundled
  // `light-plus` / `dark-plus` and re-applies on change via
  // `editor.updateOptions`. Don't set `theme` in `monacoOptions`
  // here — it spreads AFTER the prop-derived default at construct
  // time and would never change again because the preset's watcher
  // only listens on the `<Repl>` prop.
  const colorMode = useColorMode()
  const replTheme = computed(() => (colorMode.value === 'dark' ? 'dark' : 'light'))
  const monacoOptions = {
    fontSize: 13,
    fontFamily:
      "'JetBrains Mono', ui-monospace, SFMono-Regular, 'Fira Code', Menlo, Consolas, monospace",
    fontLigatures: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'gutter' as const,
    smoothScrolling: true,
    // By default Monaco's scrollbar consumes every wheel event over its
    // viewport — even when the editor is pinned at its top or bottom
    // extreme. In a docs page that ends well below the REPL, that traps
    // the reader inside the editor pane; they have to move the cursor
    // off the editor before they can keep scrolling the page. Setting
    // `alwaysConsumeMouseWheel: false` lets Monaco swallow the wheel
    // only while it actually has content to scroll, then bubbles
    // subsequent events to the parent so the page keeps moving. The
    // preview pane doesn't have this problem because it's a plain iframe
    // / scroll container with native wheel behavior.
    scrollbar: { alwaysConsumeMouseWheel: false },
  }
  // `showErrorText: false` and `autoSaveText: false` opt out of the
  // "Show Error" / "Auto Save" toggle buttons @vue/repl floats in the
  // bottom-right of the editor pane (`.editor-floating` strip in
  // EditorContainer.vue). The toggles are gated on
  // `editorOptions.showErrorText !== false` / `autoSaveText !== false`,
  // so passing literal `false` short-circuits both renders. Auto-save
  // stays on by default for the underlying store, so the editor still
  // commits on each keystroke; we just don't surface the toggle.
  const editorOptions = {
    monacoOptions,
    showErrorText: false as const,
    autoSaveText: false as const,
  }

  const store = useStore({
    builtinImportMap: ref(importMap),
    resourceLinks,
    dependencyVersion,
  })

  // Seed a tsconfig alongside the demo source. @vue/repl ships its
  // own default tsconfig but doesn't include the unused-locals /
  // parameters checks, so a `const c = 1` in the playground only
  // surfaces a hover hint — no inline strikethrough or squiggle.
  // The fields below match @vue/repl's defaults; we add the two
  // unused-identifier flags on top so Volar's TS service surfaces
  // them as real diagnostics. `:show-tsconfig="false"` on the
  // <Repl> prop above keeps this file out of the tab strip — it's
  // configuration, not editable surface.
  //
  // `lib` is set explicitly because Volar's in-worker TS service
  // doesn't reliably auto-resolve the default lib for `target:
  // 'ESNext'`: `host.getDefaultLibFileName` returns a path, but
  // the worker's `sys.fileExists` is a browser stub and the lib
  // snapshots never populate. Without this, globals declared in
  // lib files (`JSON`, `Math`, `Date`, `Array`, …) resolve to
  // `any` with TS2304. Explicit `lib: ['ESNext', 'DOM']` causes
  // Volar to request the libs by name; the TS bundle's embedded
  // lib content then resolves cleanly.
  const replTsConfig = {
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      jsx: 'Preserve',
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      allowImportingTsExtensions: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      lib: ['ESNext', 'DOM'],
    },
    vueCompilerOptions: { target: 3.4 },
  }

  // Teach Volar (the Monaco-side TypeScript service) about the
  // `toast` global the playground iframe injects at runtime. Without
  // this, demos that call `toast(...)` get a red squiggle saying
  // "Cannot find name 'toast'" even though the call works.
  //
  // Volar's in-Monaco service has its own type universe — it fetches
  // package declarations through @vue/repl's `pkgFileTextUrl`
  // callback and only loads types for packages explicitly imported
  // in the demo. The host-side `apps/site/types/playground-globals
  // .d.ts` only covers vue-tsc on the build server; the in-iframe TS
  // service needs the declaration as a file in its own project.
  //
  // The declaration MUST go through the initial `setFiles` payload —
  // not a follow-up `addFile`. @vue/repl's `setFiles` is async
  // (`await compileFile` per file) and ends with `store.files = files`
  // — a wholesale replacement of the reactive map (see
  // `chunks/core-CFIh3kZc.js:20096-20108`). Any `addFile` interleaved
  // with a pending `setFiles` mutates the *previous* map and gets
  // discarded when setFiles' overwrite lands. Volar's worker reads
  // URIs via `Object.keys(store.files)` (`monaco-editor.js:149987`),
  // so a dropped file means a missing project member.
  //
  // The tab is then hidden post-resolution by flipping
  // `file.hidden = true` on the File instance setFiles created.
  // FileSelector's tab list is a reactive `computed` filtering on
  // `!file.hidden` (`vue-repl.js:755`), so the mutation re-evaluates
  // synchronously and the tab never paints. setFiles' final state
  // assignments (`store.files = files`, `setActive(...)`) and our
  // mutation all land before the next browser paint, so there's no
  // visible flash.
  //
  // Type shape: `ToastBody` is recursive-JSON-ish so demos can pass
  // their `values` payload directly without ceremony, but excludes
  // exotic types like Map / Set / Symbol that wouldn't JSON.stringify
  // meaningfully. The five variants mirror vue-sonner's surface
  // exactly so a demo can be lifted into a real Vue app with
  // `import { toast } from 'vue-sonner'` and every call site keeps
  // working.
  const TOAST_AMBIENT_DTS = `
/**
 * JSON-serialisable payload accepted by every toast call. Strings
 * render verbatim; objects and arrays auto-pretty-format as JSON,
 * so passing a form's \`values\` straight in shows the submitted
 * shape inline.
 *
 * The callable arm admits Attaform's \`ValuesSurface\` (the type of
 * \`form.values\`). \`form.values\` is a callable readonly proxy that
 * carries a \`toJSON()\` hook, so \`JSON.stringify\` walks straight
 * through to the underlying form data — no special casing on the
 * caller's side. Naked functions without \`toJSON\` render as
 * \`[function]\` rather than poisoning the output.
 */
type ToastBody =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ToastBody[]
  | { readonly [key: string]: ToastBody }
  | ((...args: never[]) => unknown)

interface ToastOptions {
  /**
   * Secondary text below the title. Same JSON-formatting rules as
   * the message: strings render as-is, objects and arrays pretty-print.
   */
  description?: ToastBody
}

/**
 * Toast notification API. Call shape mirrors \`vue-sonner\`'s \`toast\`
 * one-to-one, so a demo built around it can be lifted into a real Vue
 * app by adding \`import { toast } from 'vue-sonner'\` with zero
 * call-site changes.
 */
interface ToastApi {
  /**
   * Display a default toast (neutral styling). Use for status updates
   * that aren't success, error, info, or warning.
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
 * Playground-only convenience: \`toast\` is injected by the
 * \`DemoReplEditor\` component and routes through \`postMessage\` to
 * a \`vue-sonner\` \`<Toaster>\` mounted in the parent docs page.
 * Outside the playground iframe it does not exist.
 *
 * @example
 *   toast.success('Subscribed!', { description: values })
 *   toast.error('Submit blocked, check the errors above.')
 *   toast.info('Heads up: the schema accepts both shapes.')
 */
declare const toast: ToastApi
`
  // In-place diff of `store.files` against an incoming seed map. Used
  // by the dev-only HMR re-seed below; not called on first mount (the
  // initial seed still goes through @vue/repl's `setFiles` so mainFile,
  // built-in import map, and initial compile errors all land normally).
  //
  // Modified files mutate `.code` on the existing File instance so
  // Monaco's bound model keeps its view state (cursor, scroll, undo
  // history) and Volar reuses its per-file LSP cache. Added files are
  // assigned directly to `store.files[name]` to bypass `addFile`'s
  // `setActive` side-effect (we never want HMR to steal the active
  // tab). Removed files skip the built-in `deleteFile` so neither the
  // native `confirm()` nor our custom delete-dialog fires.
  //
  // The active tab survives unless the new seed removed it; in that
  // case we re-point at mainFile BEFORE the delete so the compile
  // dispatcher never sees `activeFile.value === undefined`.
  function reseedFiles(
    store: ReturnType<typeof useStore>,
    newFiles: Record<string, string>,
    protectedFilenames: ReadonlySet<string>
  ): void {
    const prevActiveFilename = store.activeFile.filename
    const currentFilenames = Object.keys(store.files)

    for (const [name, code] of Object.entries(newFiles)) {
      if (protectedFilenames.has(name)) continue
      const existing = store.files[name]
      if (existing === undefined) {
        store.files[name] = new File(name, code)
      } else if (existing.code !== code) {
        existing.code = code
      }
    }

    const activeWillBeRemoved =
      !protectedFilenames.has(prevActiveFilename) && newFiles[prevActiveFilename] === undefined
    if (activeWillBeRemoved) {
      store.setActive(store.mainFile)
    }

    for (const name of currentFilenames) {
      if (protectedFilenames.has(name)) continue
      if (newFiles[name] === undefined) {
        delete store.files[name]
      }
    }
  }

  // Seed the store. `initialFiles` (a multi-file map) wins over
  // `initialSource` (the single-file shorthand). Both routes always
  // augment with `src/playground-globals.d.ts` (the toast ambient
  // declaration, hidden from the tab strip) and `tsconfig.json`
  // (compiler options for Volar). The entry stays `src/App.vue` in
  // both shapes, matching @vue/repl's default mainFile.
  const seedFiles: Record<string, string> = {
    ...(props.initialFiles ?? { 'src/App.vue': props.initialSource }),
    'src/playground-globals.d.ts': TOAST_AMBIENT_DTS,
    'tsconfig.json': JSON.stringify(replTsConfig, null, 2),
  }
  // Flips true once the initial async setFiles has landed. Guards the
  // dev-only re-seed below from racing the bootstrap (the comment near
  // TOAST_AMBIENT_DTS above documents how interleaved mutations get
  // discarded by an in-flight setFiles overwrite).
  const initialSeedReady = ref(false)
  void store.setFiles(seedFiles, 'src/App.vue').then(() => {
    const dts = store.files['src/playground-globals.d.ts']
    if (dts) dts.hidden = true
    initialSeedReady.value = true
  })

  // Dev-only HMR-driven re-seed.
  //
  // `setFiles` replaces `store.files` wholesale, which is what we want
  // on first mount but destroys Monaco's model identity on every
  // subsequent call (cursor, scroll, undo history, view state all
  // reset; Volar's per-file LSP cache invalidates). Vite HMR propagates
  // edits to `apps/site/docs-demos/<slug>.vue` all the way down to the
  // `initialFiles` prop here, so we re-bind by diffing instead:
  // mutating `.code` on existing File instances, adding / removing only
  // what changed. Monaco binds its model to the File instance, so the
  // mutation path keeps the editing context intact.
  //
  // Gated on `import.meta.dev` because the same reactivity would let a
  // future runtime prop change (e.g. a route-param-driven slug) wipe a
  // reader's in-REPL edits. Production behaviour stays seed-once.
  if (import.meta.dev) {
    const PROTECTED_FILENAMES: ReadonlySet<string> = new Set([
      'src/playground-globals.d.ts',
      'tsconfig.json',
      'import-map.json',
    ])
    watch(
      () => {
        if (props.initialFiles !== undefined) return props.initialFiles
        if (props.initialSource !== undefined) return { 'src/App.vue': props.initialSource }
        return undefined
      },
      (next) => {
        if (!initialSeedReady.value || next === undefined) return
        reseedFiles(store, next, PROTECTED_FILENAMES)
      },
      { deep: true }
    )
  }

  // Replace @vue/repl's native `confirm(...)` prompt on file deletion
  // with a styled modal. The store's `deleteFile` (defined in
  // @vue/repl's core at `chunks/core-CFIh3kZc.js:20016`) fires
  // `confirm("Are you sure you want to delete <name>?")` and returns
  // early on cancel; this browser-native dialog looks foreign next to
  // the docs surface and clips behind the editor floats on Safari.
  //
  // Strategy: monkey-patch `store.deleteFile` to queue the filename
  // for our modal instead of calling the native confirm path. When
  // the user confirms via our buttons, we temporarily stub
  // `window.confirm` to return `true` and call the ORIGINAL
  // deleteFile — that keeps @vue/repl's actual deletion logic
  // (`if (activeFilename === filename) activeFilename = mainFile;
  // delete files[filename]`) as the single source of truth. If
  // @vue/repl's deleteFile body grows extra cleanup steps in a
  // future version, we pick them up automatically.
  //
  // The original confirm is a synchronous call at the very top of
  // deleteFile, so the stub is in scope for exactly one confirm
  // invocation. Restored in a `finally` block so a throw inside
  // deleteFile can't leak the stub past one delete.
  const pendingDelete = ref<string | null>(null)
  // Whether the user has opted out of the confirmation prompt by
  // checking "Don't ask again" on a previous deletion. Persisted in
  // sessionStorage rather than localStorage on purpose: the
  // playground itself is ephemeral (files live in @vue/repl's
  // in-memory store; close the tab and they're gone), so the opt-out
  // preference shouldn't outlive the data it gates. Closing the tab
  // resets to "always ask" — the natural opt-back-in path. Matches
  // the checkbox label ("for the rest of this session") literally.
  const SKIP_CONFIRM_KEY = 'attaform-playground-skip-delete-confirm'
  function hasSkipConsent(): boolean {
    try {
      return window.sessionStorage.getItem(SKIP_CONFIRM_KEY) === '1'
    } catch {
      // Private-mode Safari throws on sessionStorage access. If we
      // can't read the preference, default to asking — the safer
      // direction.
      return false
    }
  }
  function recordSkipConsent() {
    try {
      window.sessionStorage.setItem(SKIP_CONFIRM_KEY, '1')
    } catch {
      // Same caveat as hasSkipConsent — silent on private-mode
      // storage failures rather than crashing the delete flow.
    }
  }
  // Bound to the in-dialog checkbox. Reset on every dialog open so
  // an old session's checked state can't carry over and surprise the
  // user (the persisted preference lives in localStorage, not here).
  const skipConfirm = ref(false)

  // Refs for the dialog's three focusable elements, populated via the
  // `:ref="bind..."` callback bindings on each element in the
  // template. Callback refs fire reliably on every mount — including
  // re-mounts through Teleport, where `useTemplateRef` + Transition
  // hooks lose the timing race on second-and-subsequent opens
  // (the @after-enter event silently doesn't fire when Vue reuses
  // the teleported node, and `nextTick` runs before the node is in
  // the DOM tree). The callback approach moves the auto-focus into
  // the Cancel button's own mount cycle, so the focus call lands at
  // the exact moment the element becomes focusable — no polling,
  // no race.
  const checkboxRef = shallowRef<HTMLInputElement | null>(null)
  const cancelButtonRef = shallowRef<HTMLButtonElement | null>(null)
  const deleteButtonRef = shallowRef<HTMLButtonElement | null>(null)
  function bindCheckbox(el: Element | ComponentPublicInstance | null) {
    checkboxRef.value = (el as HTMLInputElement | null) ?? null
  }
  function bindCancelButton(el: Element | ComponentPublicInstance | null) {
    const btn = (el as HTMLButtonElement | null) ?? null
    cancelButtonRef.value = btn
    // Auto-focus on mount when the dialog is open. The rAF defers the
    // focus call past the Transition's first paint frame; browsers
    // occasionally drop focus calls that race the initial layout
    // flush on a freshly-mounted, opacity-0 element. The
    // `focusVisible: true` option forces the `:focus-visible` state
    // on browsers that support it (Chrome 124+, Firefox 134+, Safari
    // 17.4+) so the keyboard-style outline ring renders even though
    // the focus is programmatic.
    if (btn && pendingDelete.value !== null) {
      requestAnimationFrame(() => {
        if (pendingDelete.value !== null) {
          ;(btn.focus as (options?: { focusVisible?: boolean }) => void)({
            focusVisible: true,
          })
        }
      })
    }
  }
  function bindDeleteButton(el: Element | ComponentPublicInstance | null) {
    deleteButtonRef.value = (el as HTMLButtonElement | null) ?? null
  }
  // The element that held focus before the dialog opened. We restore
  // it on close so keyboard users return to their previous editing
  // position rather than getting dumped at the top of the document.
  let previousActiveElement: Element | null = null
  // Body-level scroll lock state. While the dialog is open the
  // surrounding page should feel inert — the user is being asked to
  // decide about a specific file and any scroll happening behind the
  // backdrop just adds visual noise. We save and restore `body.style
  // .overflow` rather than always assuming the default so existing
  // page-wide overrides (e.g. a future "open menu" handler) don't
  // get clobbered.
  let previousBodyOverflow: string | null = null

  const originalDeleteFile = store.deleteFile.bind(store)
  // Helper: bypass @vue/repl's native confirm path and run the
  // original deleteFile by stubbing `window.confirm` for the single
  // synchronous call. Shared between the dialog confirm path and the
  // "skip dialog entirely" fast path so both routes through the same
  // single source of deletion logic.
  function performDelete(filename: string) {
    const realConfirm = window.confirm
    window.confirm = () => true
    try {
      originalDeleteFile(filename)
    } finally {
      window.confirm = realConfirm
    }
  }
  store.deleteFile = (filename: string) => {
    // If the user has already opted out of confirmations in this
    // session (or a prior one), skip the dialog and delete
    // immediately. The localStorage read is sync and fast.
    if (hasSkipConsent()) {
      performDelete(filename)
      return
    }
    pendingDelete.value = filename
  }
  function confirmPendingDelete() {
    const filename = pendingDelete.value
    if (filename == null) return
    if (skipConfirm.value) recordSkipConsent()
    pendingDelete.value = null
    performDelete(filename)
  }
  function cancelPendingDelete() {
    // Cancel does NOT persist the checkbox state — opting out of
    // confirmation should require the user to actually go through
    // with a deletion, not just back out while having ticked the box.
    pendingDelete.value = null
  }
  // Esc closes as cancel. Tab / Shift+Tab AND ArrowLeft / ArrowRight
  // cycle between the three focusable elements (Checkbox, Cancel,
  // Delete) so focus can't leave the dialog. Attach + detach the
  // listener as the dialog opens / closes rather than mounting a
  // persistent one — the editor itself uses Tab for indentation and
  // we don't want to interfere with that the rest of the time.
  watch(pendingDelete, (current, previous) => {
    if (current && !previous) {
      previousActiveElement = document.activeElement
      skipConfirm.value = false
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', handleDialogKeydown)
      // Initial focus lands inside `bindCancelButton` above — the
      // `:ref` callback fires on every mount of the Cancel button,
      // so the focus call rides the element's own lifecycle instead
      // of guessing at Teleport/Transition timing from out here.
    } else if (!current && previous) {
      window.removeEventListener('keydown', handleDialogKeydown)
      if (previousBodyOverflow !== null) {
        document.body.style.overflow = previousBodyOverflow
        previousBodyOverflow = null
      }
      if (
        previousActiveElement instanceof HTMLElement &&
        document.contains(previousActiveElement)
      ) {
        previousActiveElement.focus()
      }
      previousActiveElement = null
    }
  })
  function handleDialogKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      cancelPendingDelete()
      return
    }
    // Tab and ArrowLeft/Right both navigate the focus trap. Tab
    // matches the standard form-traversal expectation; the arrows
    // match the platform-dialog convention where users sweep across
    // adjacent buttons without leaving the home row. ArrowLeft mirrors
    // Shift+Tab; ArrowRight mirrors Tab.
    let delta: -1 | 0 | 1 = 0
    if (e.key === 'Tab') {
      delta = e.shiftKey ? -1 : 1
    } else if (e.key === 'ArrowRight') {
      delta = 1
    } else if (e.key === 'ArrowLeft') {
      delta = -1
    }
    if (delta === 0) return
    // Three-element focus trap in visual order:
    // Checkbox → Cancel → Delete → (wrap) Checkbox.
    // Cancel is the initial-focus target (safe default), so a fresh
    // Tab/ArrowRight from there moves to Delete; Shift+Tab/ArrowLeft
    // moves to Checkbox.
    const order = [checkboxRef.value, cancelButtonRef.value, deleteButtonRef.value].filter(
      (el): el is HTMLInputElement | HTMLButtonElement => el != null
    )
    if (order.length === 0) return
    const focused = document.activeElement
    const currentIdx = order.findIndex((el) => el === focused)
    // If focus is outside the dialog entirely (e.g. user clicked the
    // backdrop and activeElement fell to <body>), route back to
    // Cancel as the safe re-entry point.
    if (currentIdx === -1) {
      e.preventDefault()
      cancelButtonRef.value?.focus()
      return
    }
    const nextIdx = (currentIdx + delta + order.length) % order.length
    e.preventDefault()
    order[nextIdx]?.focus()
  }
</script>

<template>
  <Repl
    :store="store"
    :editor="MonacoEditor"
    :theme="replTheme"
    :preview-options="previewOptions"
    :editor-options="editorOptions"
    :show-compile-output="false"
    :show-import-map="false"
    :show-tsconfig="false"
  />

  <!-- Custom file-deletion confirmation. Replaces @vue/repl's native
       `window.confirm(...)` call (see `store.deleteFile` override in
       the script above). Rendered as a Teleport to <body> so the
       backdrop covers the entire viewport rather than just the
       editor's stacking context; `fixed inset-0` would otherwise be
       clipped by the editor pane's `overflow: hidden`. -->
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-(--duration-fast)"
      leave-active-class="transition-opacity duration-(--duration-fast)"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="pendingDelete !== null"
        class="fixed inset-0 z-50 grid place-items-center bg-fg/15"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repl-delete-title"
        @click.self="cancelPendingDelete"
      >
        <div class="m-4 w-full max-w-sm rounded-lg border border-border bg-bg p-6 shadow-lg">
          <h2 id="repl-delete-title" class="text-lg font-semibold text-fg"> Delete file? </h2>
          <p class="mt-3 text-sm text-fg-muted">
            <UiInlineCode>{{ pendingDelete }}</UiInlineCode> will be removed from this playground
            session. The deletion is local to your tab and won't affect anything else.
          </p>
          <label
            class="mt-5 flex cursor-pointer items-center gap-2 text-sm text-fg-muted select-none"
          >
            <input
              :ref="bindCheckbox"
              v-model="skipConfirm"
              type="checkbox"
              class="size-4 cursor-pointer rounded border-border-strong text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg-subtle"
            />
            Don't ask again for the rest of this session
          </label>
          <div class="mt-6 flex justify-end gap-2">
            <button
              :ref="bindCancelButton"
              type="button"
              class="rounded-md border border-border-strong bg-bg px-3 py-1.5 text-sm font-medium text-fg shadow-xs transition-[background-color] hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg-subtle"
              @click="cancelPendingDelete"
            >
              Cancel
            </button>
            <button
              :ref="bindDeleteButton"
              type="button"
              class="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white shadow-xs transition-[background-color] hover:bg-error-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg-subtle"
              @click="confirmPendingDelete"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<!-- Visual overrides for the rendered Repl (error overlay tone, hidden
     "+" file-add button, "preview" → "Preview" tab label) live on the
     SSR-rendered parent `<DemoRepl>` so they're in the page stylesheet
     before this client-only component hydrates and renders. -->
