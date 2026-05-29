// @vitest-environment jsdom
/**
 * Prototype-pollution gate for the persistence layer's `mergeDeep`
 * (persistence/index.ts).
 *
 * The persistence hydration path reads a JSON blob out of localStorage,
 * `JSON.parse`s it, and merges it into the form's default values via
 * `mergeSparseHydration` → `mergeDeep`. JSON.parse promotes a literal
 * `__proto__` token to an OWN data property on the parsed object (the
 * `[[DefineOwnProperty]]` step in the spec, bypassing the prototype
 * setter that an `{ __proto__: ... }` literal would trip). Without
 * protection, `out['__proto__'] = ...` on a plain-`{}` merge target
 * then reaches `Object.prototype` and pollutes every object in the
 * process — a real attack surface for any consumer whose localStorage
 * is reachable from untrusted JS (XSS, a third-party tag, a
 * compromised dependency).
 *
 * The fix matches the errors-proxy treatment: allocate the merge
 * target via `Object.create(null)` so `out['__proto__'] = …` is a
 * plain own-property write with no path to `Object.prototype`. The
 * SEC-2 `isDangerousSegment` early-skip from the prior audit is no
 * longer load-bearing and gets dropped — that guard silently
 * discarded legitimate `prototype` / `constructor` keys whose only
 * sin was sharing a name with a builtin.
 *
 * Two invariants per case:
 *   1. Positive roundtrip — a schema field literally named `prototype`
 *      / `constructor` carries its persisted value through hydration
 *      and lands at the declared path on the rehydrated form values.
 *   2. No pollution — a fresh plain `{}` does NOT inherit any canary
 *      property a hostile payload tried to inject.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeSparseHydration } from '../../src/runtime/core/persistence'

const SENTINEL = 'attaformPersistenceProtoPollutionCanary'

describe('persistence mergeDeep proto-less storage', () => {
  beforeEach(() => {
    const preProbe: Record<string, unknown> = {}
    expect(preProbe[SENTINEL]).toBeUndefined()
  })

  afterEach(() => {
    // Defensive cleanup: even though the prototype-less merge target
    // should prevent any mutation, scrub the canary so a regression
    // never bleeds into the rest of the suite.
    delete (Object.prototype as Record<string, unknown>)[SENTINEL]
  })

  it('hostile `__proto__` in persisted JSON does not pollute Object.prototype', () => {
    // JSON.parse promotes `__proto__` to an own data property — this
    // is the only way to land such a property short of
    // `Object.defineProperty`. A real attacker reaching localStorage
    // (XSS, third-party script, compromised dependency) drops this
    // shape into the persisted entry.
    const hostilePayload = JSON.parse(
      `{"__proto__": {"${SENTINEL}": "polluted"}, "email": "alice@example.com"}`
    )

    const merged = mergeSparseHydration({ email: '' }, hostilePayload) as {
      email: string
    }

    // Negative invariant — Object.prototype is unchanged.
    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()

    // The legitimate part of the payload still merged.
    expect(merged.email).toBe('alice@example.com')
  })

  it('legitimate `prototype` field round-trips through hydration', () => {
    // Architecture firm: form tracks building prototypes. The schema
    // declares a `prototype` container; the persisted payload restores
    // its name on rehydration.
    const defaults = { prototype: { name: '' } }
    const persisted = { prototype: { name: 'building-A' } }
    const merged = mergeSparseHydration(defaults, persisted) as {
      prototype: { name: string }
    }

    expect(merged.prototype.name).toBe('building-A')

    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()
  })

  it('legitimate `constructor` field round-trips through hydration', () => {
    // Construction-management form with a `constructor` field naming
    // who built the unit. Pre-fix this key was silently dropped by
    // the SEC-2 `isDangerousSegment` guard.
    const defaults = { constructor: { name: '' } }
    const persisted = { constructor: { name: 'east-wing-crew' } }
    const merged = mergeSparseHydration(defaults, persisted) as {
      constructor: { name: string }
    }

    expect(merged.constructor.name).toBe('east-wing-crew')
  })

  it('positive roundtrip survives a same-payload `__proto__` smuggle attempt', () => {
    // Defense in depth: even when a single payload mixes a legit
    // field write with a pollution attempt, the legit field still
    // round-trips correctly and Object.prototype stays untouched.
    const hostilePayload = JSON.parse(
      `{"__proto__": {"${SENTINEL}": "polluted"}, "prototype": {"name": "building-B"}}`
    )
    const merged = mergeSparseHydration({ prototype: { name: '' } }, hostilePayload) as {
      prototype: { name: string }
    }

    expect(merged.prototype.name).toBe('building-B')

    const probe: Record<string, unknown> = {}
    expect(probe[SENTINEL]).toBeUndefined()
  })
})
