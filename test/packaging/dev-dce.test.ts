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
 * Uses the same esbuild measurement as scripts/check-eager-size.mjs, so it
 * adds no new dependency.
 */

const PROD = { 'process.env.NODE_ENV': '"production"' }
const DEV = { 'process.env.NODE_ENV': '"development"' }

const DEVTOOLS_MODULE = 'src/runtime/core/devtools.ts'
// Emitted only inside an `if (__DEV__ && …)` branch in core/plugin.ts.
const DEV_ONLY_WARNING = 'createAttaform() install was called twice'

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
})
