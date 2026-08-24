import { describe, expect, it } from 'vitest'
import { measureEager } from '../../scripts/check-eager-size.mjs'

/*
 * Standing guard on the production elimination of dev-only code.
 *
 * Since size-teardown P1a the package build pre-strips `__DEV__` at the
 * source level (build.config.ts devFlagStripPlugin), and measureEager
 * applies the identical strip, so these assertions run against exactly
 * what the shipped prod flavor delivers. The original F-cases stay:
 *
 *   F1 — rewriting the dev flag to a shape the strip cannot rewrite.
 *   Asserted via a dev-only warning string: present in a dev build,
 *   absent in a prod build.
 *
 *   F2 — dropping `__DEV__` from the devtools install gate. The devtools
 *   integration is dev-only; in prod its dynamic import must be
 *   eliminated so the chunk is never fetched. Asserted via the
 *   reachable-input set: loaded in dev, orphaned in prod.
 *
 *   F3 — a top-level function whose only caller sits in a dead branch.
 *   The define-fold approach left these behind (esbuild marks references
 *   before it folds a define); the source-level strip makes the dead
 *   branch visible at parse time, so they drop. The key-collision
 *   diagnostics module is the canary.
 *
 * The S-cases are the structural gates that make partial-DCE regressions
 * visible (the pre-P1a CI asserted a single foldable string and was blind
 * to a ~2.5 kB gz leak):
 *
 *   S1 — no minified dead-branch husks (`if(!1)`, dead `!1&&` chains) in
 *   the prod eager output.
 *
 *   S2 — the dev-stack-trace module (statically imported by five
 *   composables for warn call-site capture) leaves the prod eager set.
 *
 *   S3 — every `[attaform]` string on the prod eager path matches an
 *   explicit allowlist of intentional production messages.
 */

const PROD = { 'process.env.NODE_ENV': '"production"' }
const DEV = { 'process.env.NODE_ENV': '"development"' }

const DEVTOOLS_MODULE = 'src/runtime/core/devtools.ts'
// Emitted only inside an `if (__DEV__ && …)` branch in core/plugin.ts.
const DEV_ONLY_WARNING = 'createAttaform() install was called twice'
// Dev-only shared-key collision diagnostics, dynamic-imported behind an
// `if (__DEV__)` gate in use-abstract-form.ts.
const DEV_WARN_MODULE = 'src/runtime/core/dev-key-collision-warnings.ts'
const DEV_STACK_TRACE_MODULE = 'src/runtime/core/dev-stack-trace.ts'

/**
 * The intentional production `[attaform]` messages on the minimal-useForm
 * (zod-v4) eager path. Since P1b, every prose diagnostic ships as an AF##
 * code with its attaform.dev/e URL — the `'[attaform] AF'` prefix covers
 * all of them — plus the short no-uncaught-exceptions "callback threw"
 * breadcrumbs and the transform gate-rejection message. Everything else
 * is dev-flavor-only. Additions here are reviewed, never incidental.
 *
 * Prefix-matched against the minified eager output (non-ASCII characters
 * appear as \uXXXX escapes there, so prefixes stop before any).
 */
const PROD_PROSE_ALLOWLIST = [
  '[attaform] AF',
  '[attaform] onFormChange threw:',
  '[attaform] onSubmitSuccess threw:',
  '[attaform] cleanup threw:',
  '[attaform] onReset threw:',
  '[attaform] transform result for path ',
]

describe('production dead-code elimination', () => {
  it('F1: strips dev-only branches from a production build', async () => {
    const [prod, dev] = await Promise.all([measureEager(PROD), measureEager(DEV)])
    expect(dev.eagerText).toContain(DEV_ONLY_WARNING)
    expect(prod.eagerText).not.toContain(DEV_ONLY_WARNING)
  })

  it('F2: never loads the devtools chunk in a production build', async () => {
    const [prod, dev] = await Promise.all([measureEager(PROD), measureEager(DEV)])
    expect(dev.reachableInputs).toContain(DEVTOOLS_MODULE)
    expect(prod.reachableInputs).not.toContain(DEVTOOLS_MODULE)
  })

  it('F3: never loads the key-collision warn module in a production build', async () => {
    const [prod, dev] = await Promise.all([measureEager(PROD), measureEager(DEV)])
    expect(dev.reachableInputs).toContain(DEV_WARN_MODULE)
    expect(prod.reachableInputs).not.toContain(DEV_WARN_MODULE)
  })

  it('S1: prod eager output carries no dead-branch husks', async () => {
    const { eagerText } = await measureEager(PROD)
    expect(eagerText).not.toMatch(/if\(!1\)/)
    // A dead `!1&&expr` chain, excluding real comparisons against the
    // literal (`===!1`, `!==!1`, `==!1`, `!=!1` all end in `=` before it).
    expect(eagerText).not.toMatch(/(?<!=)!1&&/)
  })

  it('S2: the dev-stack-trace module leaves the prod eager set', async () => {
    const [prod, dev] = await Promise.all([measureEager(PROD), measureEager(DEV)])
    expect(dev.eagerInputs).toContain(DEV_STACK_TRACE_MODULE)
    expect(prod.eagerInputs).not.toContain(DEV_STACK_TRACE_MODULE)
  })

  it('S3: prod eager [attaform] prose stays within the allowlist', async () => {
    const { eagerText } = await measureEager(PROD)
    const found = [...new Set(eagerText.match(/\[attaform\][^"'`]*/g) ?? [])]
    const offenders = found.filter(
      (s) => !PROD_PROSE_ALLOWLIST.some((prefix) => s.startsWith(prefix))
    )
    expect(offenders).toEqual([])
  })

  it('S4: un-welded modules stay off the minimal eager path (P2 directive, P3 history, P4 field-meta walk)', async () => {
    // The largest size levers: createAttaform / lazy install weld
    // no directive, so a form that never renders v-register never ships
    // it. Delivery is the compile-time rewrite (Vite/Nuxt) or
    // installVRegister; dom-binding rides the same lazy graph via the
    // ensureDomBinding injection. History rides the consumer's own
    // `historyPlugin()` import from `attaform/history` (P3), so a form
    // that never opts in never ships the undo/redo runtime. The
    // field-meta path walk rides the registration surface (`withMeta` /
    // `fieldMeta.add`, P4), so a form that never registers metadata
    // resolves labels through the `.describe()` / humanize fallbacks
    // without shipping the walk. Any of these reappearing in the
    // minimal scenario's eager inputs is a regression of the whole
    // un-weld, whatever the byte ratchet happens to say that day.
    const UNWELDED_MODULES = [
      'src/runtime/core/directive.ts',
      'src/runtime/core/directive-aria.ts',
      'src/runtime/core/directive-file.ts',
      'src/runtime/core/directive-lifecycle.ts',
      'src/runtime/core/directive-listeners.ts',
      'src/runtime/core/directive-value-sync.ts',
      'src/runtime/core/register-protocol.ts',
      'src/runtime/core/assigner-pipeline.ts',
      'src/runtime/core/vue-shared-shim.ts',
      'src/runtime/core/dom-binding.ts',
      'src/runtime/core/interactive-tags.ts',
      'src/runtime/core/history.ts',
      'src/runtime/core/walk-field-meta.ts',
    ]
    const { eagerInputs } = await measureEager(PROD)
    const welded = UNWELDED_MODULES.filter((m) => eagerInputs.includes(m))
    expect(welded).toEqual([])
  })
})
