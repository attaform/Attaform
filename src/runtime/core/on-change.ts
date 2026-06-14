import { isRef, toValue } from 'vue'
import { __DEV__ } from './dev'
import type { Patch } from './diff-apply'
import {
  canonicalizePath,
  isPathPrefix,
  ROOT_PATH,
  ROOT_PATH_KEY,
  segmentsToDotted,
  type Path,
  type PathKey,
} from './paths'
import type {
  OnChangeContext,
  OnChangeErrorContext,
  OnChangeErrorHandler,
  OnChangeHandler,
  OnChangeOptions,
  OnChangeSource,
  WriteMeta,
} from '../types/types-api'

/**
 * `form.onChange` — a side-channel for reacting to partial form value
 * changes (autosave a subform or a field, mirror one field into another,
 * fire analytics). The store owns this registry and drives it from a single
 * seam: `commitWritePatches` calls `dispatch(patches, meta)` after the value
 * has landed, where the per-leaf patches and the write's `meta` are in hand.
 *
 * The contract that keeps it cheap and predictable:
 *
 * - **Cost scales with handlers declared, never with form size.** The
 *   callsite skips `dispatch` entirely when `active` is `false`; a dispatch
 *   walks the (sparse) handler set and prefix-tests each resolved source
 *   path against the (small) patch list — no per-field index to maintain.
 * - **Dedup is free.** `commitWritePatches` only emits a patch when a value
 *   actually changed (the store's identity short-circuit), so a matching
 *   patch exists iff there was a real change.
 * - **Fires on edits, not rebaselines.** `meta.hydration` (persistence
 *   restore) and `meta.silent` (reset's tag and the consumer `{ silent }`
 *   opt-out) suppress dispatch.
 * - **A handler never throws into the write.** Every handler invocation,
 *   source resolution, and `onError` call is wrapped; a throw routes to
 *   `onError` or is swallowed (logged in dev), never rethrown into the
 *   keystroke that triggered it.
 * - **Latest-write-wins per `(handler, source path)`.** A newer fire aborts
 *   the prior run's `signal` and supersedes it; a superseded async run's
 *   rejection is dropped rather than surfaced.
 */
export type OnChangeRegistry = {
  /** `true` when at least one handler is registered — the callsite fast-path gate. */
  readonly active: boolean
  /**
   * Register a handler. `source === undefined` is the whole form (root).
   * `getForm` lazily resolves the public form handle for `ctx.form` (it does
   * not exist yet when the store wires this). Returns an idempotent `stop()`.
   * A no-op on SSR — there is no write loop to react to on the server.
   */
  register(
    source: OnChangeSource | undefined,
    handler: OnChangeHandler,
    options: OnChangeOptions | undefined,
    getForm: () => unknown
  ): () => void
  /** Fire matching handlers for a committed write. Called from `commitWritePatches`. */
  dispatch(patches: readonly Patch[], meta?: WriteMeta): void
  /** Drop every handler and abort in-flight runs. Called from the store's `dispose`. */
  dispose(): void
}

export type OnChangeRegistryDeps = {
  /** Read the current value at a path — the store's `getValueAtPath`. */
  readonly getValueAtPath: (path: Path) => unknown
  /** Server flag — registration is a no-op when `true`. */
  readonly ssr: boolean
}

/** A resolved source path: segments for matching / reads, key for dedup, dotted for ctx. */
type ResolvedPath = { readonly segments: Path; readonly key: PathKey; readonly dotted: string }

type RegisteredHandler = {
  readonly handler: OnChangeHandler
  readonly onError: OnChangeErrorHandler | undefined
  readonly getForm: () => unknown
  /** Resolve the current source path list (deduped) — static once, getter/ref per call. */
  readonly resolve: () => readonly ResolvedPath[]
  /** Last-known value per source-path key, for `ctx.previous`. */
  readonly previous: Map<PathKey, unknown>
  /** In-flight run per source-path key: a supersession token + its abort controller. */
  readonly runs: Map<PathKey, { token: number; controller: AbortController }>
  /** Monotonic run counter for this handler. */
  seq: number
}

const NOOP_STOP = (): void => {}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** A write that rebaselines or echoes rather than reflecting a user edit. */
function isSuppressed(meta: WriteMeta | undefined): boolean {
  return meta?.hydration === true || meta?.silent === true
}

/** Canonicalize a string / string[] source into a deduped resolved-path list. */
function canonicalizeSourceList(raw: string | readonly string[]): readonly ResolvedPath[] {
  const list = typeof raw === 'string' ? [raw] : raw
  const out: ResolvedPath[] = []
  const seen = new Set<PathKey>()
  for (const entry of list) {
    const { segments, key } = canonicalizePath(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ segments, key, dotted: segmentsToDotted(segments) })
  }
  return out
}

/** Build the per-handler source resolver: a fixed list for static sources, a live read for getter / ref. */
function makeResolver(source: OnChangeSource | undefined): () => readonly ResolvedPath[] {
  // Root: the whole form. One source path — the empty path — which
  // prefix-matches every write. `''` is its dotted form.
  if (source === undefined) {
    const root: readonly ResolvedPath[] = [{ segments: ROOT_PATH, key: ROOT_PATH_KEY, dotted: '' }]
    return () => root
  }
  // Static string / string[]: canonicalize once at registration.
  if (typeof source !== 'function' && !isRef(source)) {
    const fixed = canonicalizeSourceList(source)
    return () => fixed
  }
  // Getter / ref / computed: re-resolve on each dispatch. `toValue` reads a
  // ref's `.value` or calls a getter; the result is canonicalized fresh.
  return () => canonicalizeSourceList(toValue(source))
}

export function createOnChangeRegistry(deps: OnChangeRegistryDeps): OnChangeRegistry {
  const handlers = new Set<RegisteredHandler>()

  function isCurrent(reg: RegisteredHandler, key: PathKey, token: number): boolean {
    return reg.runs.get(key)?.token === token
  }

  function routeError(
    reg: RegisteredHandler,
    error: unknown,
    source: ResolvedPath,
    changed: readonly string[],
    value: unknown,
    previous: unknown,
    attempt: number,
    token: number
  ): void {
    if (reg.onError === undefined) {
      if (__DEV__) {
        console.error(
          `[attaform] onChange handler threw for path '${source.dotted}' — error swallowed. ` +
            `Pass { onError } to handle it. Original error:`,
          error
        )
      }
      return
    }
    const retry = (): void => {
      // A newer edit superseded this run — don't resurrect stale work.
      if (!isCurrent(reg, source.key, token)) return
      runHandler(reg, source, changed, value, previous, attempt + 1)
    }
    const errCtx: OnChangeErrorContext = {
      path: source.dotted,
      value,
      attempt,
      retry,
      form: reg.getForm(),
    }
    try {
      reg.onError(error, errCtx)
    } catch (err) {
      if (__DEV__) console.error('[attaform] onChange onError threw:', err)
    }
  }

  function runHandler(
    reg: RegisteredHandler,
    source: ResolvedPath,
    changed: readonly string[],
    value: unknown,
    previous: unknown,
    attempt: number
  ): void {
    // Supersede any in-flight run for this (handler, source path): abort its
    // signal so a debounced / awaiting handler can bail, then claim a fresh
    // token. We do not cancel committed work — only abort the signal.
    const prior = reg.runs.get(source.key)
    if (prior) prior.controller.abort()
    const controller = new AbortController()
    const token = ++reg.seq
    reg.runs.set(source.key, { token, controller })

    const ctx: OnChangeContext = {
      path: source.dotted,
      previous,
      signal: controller.signal,
      attempt,
      form: reg.getForm(),
      changed,
    }

    let result: void | Promise<void>
    try {
      result = reg.handler(value, ctx)
    } catch (error) {
      routeError(reg, error, source, changed, value, previous, attempt, token)
      return
    }
    if (isThenable(result)) {
      result.then(undefined, (error: unknown) => {
        // Only the live run's rejection reaches onError — a superseded run
        // (a newer edit landed and aborted this signal) is dropped, matching
        // the transform pipeline's latest-write-wins discard.
        if (isCurrent(reg, source.key, token)) {
          routeError(reg, error, source, changed, value, previous, attempt, token)
        }
      })
    }
  }

  function dispatch(patches: readonly Patch[], meta?: WriteMeta): void {
    if (handlers.size === 0 || isSuppressed(meta)) return
    for (const reg of handlers) {
      let sources: readonly ResolvedPath[]
      try {
        sources = reg.resolve()
      } catch (error) {
        // A consumer source getter threw — isolate it so the write pipeline
        // and sibling handlers are unaffected.
        if (__DEV__) console.error('[attaform] onChange source getter threw:', error)
        continue
      }
      for (const source of sources) {
        // Fire once for this source path if ANY patch is an ancestor or a
        // descendant of it: a `user.email` write hits both a `user` source
        // and a `user.email` source; a whole-`user` replacement hits a
        // `user.email` source. Collect the matching changed leaves for ctx.
        let changed: string[] | undefined
        for (const patch of patches) {
          if (
            isPathPrefix(source.segments, patch.path) ||
            isPathPrefix(patch.path, source.segments)
          ) {
            ;(changed ??= []).push(segmentsToDotted(patch.path))
          }
        }
        if (changed === undefined) continue
        const value = deps.getValueAtPath(source.segments)
        const previous = reg.previous.has(source.key) ? reg.previous.get(source.key) : value
        reg.previous.set(source.key, value)
        runHandler(reg, source, changed, value, previous, 0)
      }
    }
  }

  function register(
    source: OnChangeSource | undefined,
    handler: OnChangeHandler,
    options: OnChangeOptions | undefined,
    getForm: () => unknown
  ): () => void {
    // SSR: no autosave / side effects on the server, and no write loop to
    // react to. Return a no-op stop so consumer cleanup stays uniform.
    if (deps.ssr) return NOOP_STOP

    const reg: RegisteredHandler = {
      handler,
      onError: options?.onError,
      getForm,
      resolve: makeResolver(source),
      previous: new Map(),
      runs: new Map(),
      seq: 0,
    }
    // Seed `previous` from the current state so the first fire reports an
    // accurate "before" value for static leaf sources.
    try {
      for (const { key, segments } of reg.resolve()) {
        reg.previous.set(key, deps.getValueAtPath(segments))
      }
    } catch (error) {
      if (__DEV__) console.error('[attaform] onChange source getter threw at registration:', error)
    }
    handlers.add(reg)

    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      handlers.delete(reg)
      for (const run of reg.runs.values()) run.controller.abort()
      reg.runs.clear()
      reg.previous.clear()
    }
  }

  function dispose(): void {
    for (const reg of handlers) {
      for (const run of reg.runs.values()) run.controller.abort()
      reg.runs.clear()
      reg.previous.clear()
    }
    handlers.clear()
  }

  return {
    get active() {
      return handlers.size > 0
    },
    register,
    dispatch,
    dispose,
  }
}
