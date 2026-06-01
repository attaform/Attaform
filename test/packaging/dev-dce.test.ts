import { describe, expect, it } from 'vitest'
import { measureEager } from '../../scripts/check-eager-size.mjs'

/*
 * Standing guard on the production dead-code elimination of dev-only code.
 *
 * core/dev.ts shapes `__DEV__` so a consumer's production define folds it
 * to the literal `false`, which lets bundlers drop every `if (__DEV__)`
 * block. Two regressions this catches:
 *
 *   F1 — rewriting the dev flag to a leading `&&` guard. esbuild will not
 *   inline a const whose initializer is a short-circuit expression, so the
 *   dev branches would survive into prod. Asserted via a dev-only warning
 *   string: present in a dev build, absent in a prod build.
 *
 *   F2 — dropping `__DEV__` from the devtools install gate. The devtools
 *   integration is dev-only; in prod its dynamic import must be DCE'd so
 *   the chunk is never fetched. Asserted via the reachable-input set: the
 *   devtools module is loaded in dev and orphaned (unreachable) in prod.
 *
 *   F3 — moving a dev-only warning back inline as a top-level function
 *   called only from an `if (__DEV__)` block. esbuild removes the inline
 *   dead branch but keeps a function it is the sole (dead) caller of:
 *   tree-shaking runs before the define-fold, so the function survives. The
 *   shared-key collision diagnostics dodge that by living in their own
 *   module loaded via dynamic import, so prod orphans the chunk. Asserted
 *   via the reachable-input set: loaded in dev, unreachable in prod.
 *
 * Uses the same esbuild measurement as scripts/check-eager-size.mjs, so it
 * adds no new dependency.
 */

const PROD = { 'process.env.NODE_ENV': '"production"' }
const DEV = { 'process.env.NODE_ENV': '"development"' }

const DEVTOOLS_MODULE = 'src/runtime/core/devtools.ts'
// Emitted only inside an `if (__DEV__ && …)` branch in core/plugin.ts.
const DEV_ONLY_WARNING = 'createAttaform() install was called twice'
// Dev-only shared-key collision diagnostics, dynamic-imported behind an
// `if (__DEV__)` gate in use-abstract-form.ts.
const DEV_WARN_MODULE = 'src/runtime/core/dev-key-collision-warnings.ts'

describe('production dead-code elimination', () => {
  it('F1: folds out dev-only branches in a production build', async () => {
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
})
