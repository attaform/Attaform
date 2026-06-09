/**
 * T4 GATE HARNESS #2 — error-map BOOKKEEPING equivalence under the decomposition.
 *
 * STATUS: T4 was SCOPED OUT — a measured-and-scoped non-action (2026-06-09; see
 * PERF-ANALYSIS.md "T4"). This harness stays as reproducible EVIDENCE + a standing
 * guard, not as a gate for unshipped runtime code.
 *
 * Harness #1 (`t4-refines-only-equivalence.test.ts`) proved the VERDICT SET
 * decomposes byte-identically (Variant A″). This proved the SECOND obligation: the
 * scheduler maintains a persistent
 * `schemaErrors` map (PathKey -> issues[]) and mutates it INCREMENTALLY per
 * keystroke. Under the A″ decomposition each keystroke runs TWO passes that both
 * write into that one map:
 *
 *   - subtree-leaf pass: re-validate the edited path's subtree, then scope-clear +
 *     set `schemaErrors` UNDER that path (the EXISTING refine-free behaviour).
 *   - refines-only pass: re-run all container/root refines, then reapply their
 *     issues (which can land at ANY path).
 *
 * The real mutator (`create-form-store.ts:2985 applySchemaErrorsForSubtree`) clears
 * by PATH SCOPE: it deletes existing `schemaErrors` keys under the scope path that
 * the new pass doesn't rewrite, then sets the new ones. The hazard the second
 * obligation must rule out: a container refine can emit an issue to a path that
 * ALREADY holds a leaf error — `confirmPassword` carrying both its own `.min` leaf
 * error AND the cross-field match-refine error. A refines-only pass that scope-clears
 * root to reapply refine issues would CLOBBER the co-located leaf error; a leaf pass
 * that scope-clears its subtree would clobber a co-located refine error. Scope-based
 * clearing cannot separate leaf-origin from refine-origin issues at the same path.
 *
 * ── What this harness pins (both adapters) ────────────────────────────────────
 *
 * 1. EQUIVALENCE: an ORIGIN-CHANNELED decomposition — leaf issues maintained by
 *    subtree scope-clear (incremental), refine issues held in a SEPARATE channel
 *    wholesale-replaced each keystroke (the refines-only pass always yields the
 *    complete current refine verdict), merged leaf-THEN-refine on read —
 *    reconstructs the whole-form map path-by-path, across adversarial edit
 *    SEQUENCES (errors appearing, disappearing, and colliding at one path).
 * 2. NECESSITY: the naive SINGLE-channel decomposition (both passes scope-clear into
 *    one map, i.e. today's `applySchemaErrorsForSubtree` invoked twice) CLOBBERS and
 *    diverges from the whole-form map. This is the standing proof that an origin
 *    sub-channel is REQUIRED, not optional.
 * 3. ORDERING (within a path): the channeled merge reproduces zod's leaf-then-refine
 *    emission order at a colliding path. Cross-path INSERTION order (which
 *    `form.meta.errors` iterates) is a further constraint flagged for the impl,
 *    asserted lightly here.
 *
 * => The API-shape finding to settle with Oswald before the walker + scheduler code:
 *    `schemaErrors` needs a refine-origin sub-channel (or an equivalent per-issue
 *    origin tag) so the two decomposed passes never clobber each other.
 *
 * Scope note: this models the bookkeeping SEMANTICS of the real mutator (group by
 * each issue's own key, scope-clear stale keys under the pass path, merged read)
 * with simple dotted keys + a form-level bucket for root-refine issues — not its
 * exact `PathKey` encoding. When the runtime decomposition lands, harnesses #1 + #2
 * become its standing spec and the real scheduler is validated against them.
 */
import { describe, it, expect } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Z = any

// ── Spec model + builders (lockstep with harness #1's variant semantics) ──────
// full / slim / prime.refines / prime.noRefines mean exactly what they mean in
// `t4-refines-only-equivalence.test.ts`, so the two proofs compose.

type Leaf = {
  kind: 'leaf'
  full: (z: Z) => any
  typeOnly: (z: Z) => any
  refineKept: (z: Z) => any
}
type Refine = {
  type: 'refine'
  fn: (v: any) => boolean
  message: string
  path?: (string | number)[]
  abort?: boolean
}
type ObjNode = { kind: 'object'; fields: Record<string, Node>; refines?: Refine[] }
type Node = Leaf | ObjNode

function leaf(full: (z: Z) => any, typeOnly: (z: Z) => any, refineKept?: (z: Z) => any): Leaf {
  return { kind: 'leaf', full, typeOnly, refineKept: refineKept ?? typeOnly }
}
function obj(fields: Record<string, Node>, refines?: Refine[]): ObjNode {
  return refines === undefined ? { kind: 'object', fields } : { kind: 'object', fields, refines }
}

const ABORT = { message: 'leaf-abort', abort: true, fatal: true } as const

const L = {
  str: () =>
    leaf(
      (z) => z.string(),
      (z) => z.string()
    ),
  min: (n: number) =>
    leaf(
      (z) => z.string().min(n),
      (z) => z.string()
    ),
  /** Built-in `.min` (dropped) AND an aborting custom refine (kept by A″). */
  abortingMin: (n: number) =>
    leaf(
      (z) => z.string().refine((s: string) => s.length >= n, ABORT),
      (z) => z.string(),
      (z) => z.string().refine((s: string) => s.length >= n, ABORT)
    ),
}

const eqRefine = (a: string, b: string, message: string, path: (string | number)[]): Refine => ({
  type: 'refine',
  fn: (o: any) => o?.[a] === o?.[b],
  message,
  path,
})

type LeafMode = 'full' | 'typeOnly' | 'refineKept'
type BuildOpts = { leafMode: LeafMode; dropRefines: boolean }

function applyRefines(schema: any, refines: Refine[] | undefined, opts: BuildOpts): any {
  if (opts.dropRefines || refines === undefined) return schema
  let s = schema
  for (const r of refines) {
    const params = {
      message: r.message,
      ...(r.path !== undefined ? { path: r.path } : {}),
      ...(r.abort === true ? { abort: true, fatal: true } : {}),
    }
    s = s.refine(r.fn, params)
  }
  return s
}

function build(z: Z, node: Node, opts: BuildOpts): any {
  if (node.kind === 'leaf') return node[opts.leafMode](z)
  const shape: Record<string, any> = {}
  for (const [k, v] of Object.entries(node.fields)) shape[k] = build(z, v, opts)
  return applyRefines(z.object(shape), node.refines, opts)
}

type Variants = { full: any; slim: any; prime: { refines: any; noRefines: any } }
function variants(z: Z, spec: Node): Variants {
  const mk = (leafMode: LeafMode, dropRefines: boolean) => build(z, spec, { leafMode, dropRefines })
  return {
    full: mk('full', false),
    slim: mk('full', true),
    prime: { refines: mk('refineKept', false), noRefines: mk('refineKept', true) },
  }
}

// ── Issues, keys, and the abstract schemaErrors map ───────────────────────────
// A root-refine issue has an empty path; the real store reroutes it to a
// form-level bucket (create-form-store.ts:2986). Model that with a sentinel key.

const FORM_KEY = '<form>' // storage key for an empty-path (root-refine) issue
const ROOT_SCOPE = '<root>' // a clear/replace scope covering EVERY key (real path === [])
type Issue = { key: string; code: string; message: string }

function keyOf(path: (string | number)[]): string {
  return path.length === 0 ? FORM_KEY : path.join('.')
}
function toIssues(result: { success: boolean; error?: { issues: any[] } }): Issue[] {
  if (result.success) return []
  return (result.error?.issues ?? []).map((i: any) => ({
    key: keyOf(i.path),
    code: i.code,
    message: i.message,
  }))
}
function issueId(i: Issue): string {
  return JSON.stringify([i.code, i.message])
}
/**
 * A key falls under a scope. ROOT_SCOPE covers EVERY key (the real path === []
 * sweep, where `isPathKeyUnder(anyKey, [])` is true); a dotted scope covers itself
 * and its descendants. The form bucket is just a normal key — only ROOT_SCOPE or an
 * exact match reaches it.
 */
function isUnder(key: string, scope: string): boolean {
  if (scope === ROOT_SCOPE) return true
  return key === scope || key.startsWith(`${scope}.`)
}
function groupByKey(issues: Issue[]): Map<string, Issue[]> {
  const m = new Map<string, Issue[]>()
  for (const i of issues) {
    const list = m.get(i.key)
    if (list === undefined) m.set(i.key, [i])
    else list.push(i)
  }
  return m
}
/** Multiset A ∖ B over issue identity within each key (the refines-only delta). */
function refineDelta(v: Variants, data: unknown): Issue[] {
  const a = toIssues(v.prime.refines.safeParse(data))
  const b = toIssues(v.prime.noRefines.safeParse(data))
  const counts = new Map<string, number>()
  for (const i of b) {
    const id = `${i.key}|${issueId(i)}`
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const out: Issue[] = []
  for (const i of a) {
    const id = `${i.key}|${issueId(i)}`
    const c = counts.get(id) ?? 0
    if (c > 0) counts.set(id, c - 1)
    else out.push(i)
  }
  return out
}
function leafIssues(v: Variants, data: unknown): Issue[] {
  return toIssues(v.slim.safeParse(data))
}
function wholeFormGrouped(v: Variants, data: unknown): Map<string, Issue[]> {
  return groupByKey(toIssues(v.full.safeParse(data)))
}

/** Comparable normal form: per non-empty key, the SORTED multiset of issue ids. */
function normMultiset(m: Map<string, Issue[]>): string {
  const keys = [...m.keys()].filter((k) => (m.get(k)?.length ?? 0) > 0).sort()
  return JSON.stringify(keys.map((k) => [k, (m.get(k) ?? []).map(issueId).sort()]))
}

/**
 * The real `applySchemaErrorsForSubtree` (create-form-store.ts:2985) semantics:
 * group `incoming` by each issue's own key; the scope's parent key is dropped only
 * if the new pass doesn't rewrite it; descendant keys under the scope the new pass
 * doesn't rewrite are deleted; the rest are set. For ROOT_SCOPE the parent is the
 * form bucket and every other key is a descendant — i.e. the whole map is replaced.
 */
function scopeReplace(map: Map<string, Issue[]>, scope: string, incoming: Issue[]): void {
  const grouped = groupByKey(incoming)
  const parentKey = scope === ROOT_SCOPE ? FORM_KEY : scope
  if (!grouped.has(parentKey)) map.delete(parentKey)
  for (const k of [...map.keys()]) {
    if (k === parentKey) continue
    if (isUnder(k, scope) && !grouped.has(k)) map.delete(k)
  }
  for (const [k, list] of grouped) map.set(k, list)
}

// ── The two decomposition strategies ──────────────────────────────────────────

/** Origin-channeled: leaf channel (subtree scope-clear) + refine channel (wholesale). */
class Channeled {
  leaf = new Map<string, Issue[]>()
  refine = new Map<string, Issue[]>()
  seed(v: Variants, data: unknown): void {
    this.leaf = groupByKey(leafIssues(v, data))
    this.refine = groupByKey(refineDelta(v, data))
  }
  edit(v: Variants, data: unknown, editedKey: string): void {
    // subtree-leaf pass: re-validate, scope-clear + set UNDER the edited path.
    const under = leafIssues(v, data).filter((i) => isUnder(i.key, editedKey))
    scopeReplace(this.leaf, editedKey, under)
    // refines-only pass: the complete current refine verdict, wholesale.
    this.refine = groupByKey(refineDelta(v, data))
  }
  read(): Map<string, Issue[]> {
    const out = new Map<string, Issue[]>()
    for (const [k, l] of this.leaf) out.set(k, [...l])
    for (const [k, r] of this.refine) out.set(k, [...(out.get(k) ?? []), ...r])
    return out
  }
}

/** Naive single map: BOTH passes scope-clear into it (today's mutator, twice). */
class SingleChannel {
  map = new Map<string, Issue[]>()
  seed(v: Variants, data: unknown): void {
    this.map = groupByKey([...leafIssues(v, data), ...refineDelta(v, data)])
  }
  edit(v: Variants, data: unknown, editedKey: string): void {
    const under = leafIssues(v, data).filter((i) => isUnder(i.key, editedKey))
    scopeReplace(this.map, editedKey, under) // leaf pass
    // refine pass: refines emit anywhere, so the only honest scope is ROOT — which
    // sweeps every co-located leaf error the new refine verdict doesn't rewrite.
    scopeReplace(this.map, ROOT_SCOPE, refineDelta(v, data))
  }
  read(): Map<string, Issue[]> {
    return this.map
  }
}

// ── Edit-sequence scenarios ───────────────────────────────────────────────────
type Edit = { set: Record<string, unknown>; editedKey: string }
type Sequence = { name: string; spec: Node; initial: Record<string, unknown>; edits: Edit[] }

const SEQUENCES: Sequence[] = [
  {
    // The collision: password + confirmPassword BOTH .min(8), the match refine
    // targets confirmPassword. When confirm is short AND mismatched, that one path
    // carries a leaf min error AND the refine error simultaneously.
    name: 'password/confirm: leaf + refine collide at confirmPassword',
    spec: obj({ password: L.min(8), confirmPassword: L.min(8) }, [
      eqRefine('password', 'confirmPassword', 'Passwords must match', ['confirmPassword']),
    ]),
    initial: { password: 'short', confirmPassword: 'short' },
    edits: [
      { set: { confirmPassword: 'x' }, editedKey: 'confirmPassword' }, // collide: min + match
      { set: { password: 'longenough9' }, editedKey: 'password' }, // password clears, confirm still min+match
      { set: { confirmPassword: 'longenough9' }, editedKey: 'confirmPassword' }, // all clear
      { set: { password: 'short' }, editedKey: 'password' }, // password min returns, now mismatch again
    ],
  },
  {
    // Aborting leaf refine: when f0 aborts, the root refine is SUPPRESSED, so the
    // refine channel must be empty; the leaf channel carries f0's abort. Toggling
    // f0 in/out of abort must keep the bookkeeping in lockstep with whole-form.
    name: 'aborting leaf toggles refine suppression',
    spec: obj({ f0: L.abortingMin(3), f1: L.str() }, [eqRefine('f0', 'f1', 'f0==f1', ['f1'])]),
    initial: { f0: 'ab', f1: 'zz' }, // f0 aborts -> root refine suppressed
    edits: [
      { set: { f0: 'abcd' }, editedKey: 'f0' }, // f0 ok, now f0!=f1 -> refine error at f1
      { set: { f1: 'abcd' }, editedKey: 'f1' }, // match -> all clear
      { set: { f0: 'ab' }, editedKey: 'f0' }, // f0 aborts again -> refine suppressed
    ],
  },
  {
    // Independent leaves under a root refine: a sibling's error must PERSIST across
    // edits to other fields (the leaf channel is incremental, not re-derived).
    name: 'sibling leaf error persists across unrelated edits',
    spec: obj({ a: L.min(2), b: L.min(2), c: L.str() }, [eqRefine('a', 'c', 'a==c', ['c'])]),
    initial: { a: 'x', b: 'y', c: 'x' }, // a min, b min, refine passes (a==c)
    edits: [
      { set: { c: 'zz' }, editedKey: 'c' }, // a still min, b still min, a!=c -> refine at c
      { set: { b: 'ok' }, editedKey: 'b' }, // b clears; a min + refine@c must persist
      { set: { a: 'zz' }, editedKey: 'a' }, // a clears; now a==? c='zz' so a==c -> refine clears
    ],
  },
]

const ADAPTERS: Array<{ tag: 'v4' | 'v3'; z: Z }> = [
  { tag: 'v4', z: zV4 },
  { tag: 'v3', z: zV3 },
]

describe('T4 error-map bookkeeping equivalence (origin-channeled decomposition)', () => {
  for (const a of ADAPTERS) {
    describe(`[${a.tag}]`, () => {
      for (const seq of SEQUENCES) {
        it(`${seq.name}: channeled map tracks whole-form across the sequence`, () => {
          const v = variants(a.z, seq.spec)
          const model = new Channeled()
          let data: Record<string, unknown> = { ...seq.initial }
          model.seed(v, data)
          let sawErrors = wholeFormGrouped(v, data).size > 0
          expect(normMultiset(model.read())).toEqual(normMultiset(wholeFormGrouped(v, data)))
          for (const e of seq.edits) {
            data = { ...data, ...e.set }
            model.edit(v, data, e.editedKey)
            const whole = wholeFormGrouped(v, data)
            if (whole.size > 0) sawErrors = true
            expect(normMultiset(model.read())).toEqual(normMultiset(whole))
          }
          // Non-vacuous: the sequence must actually exercise errors, so equivalence
          // can't pass by both sides staying empty throughout.
          expect(sawErrors).toBe(true)
        })
      }
    })
  }
})

// ── Necessity: the naive single-channel decomposition clobbers ────────────────
// Prove the origin sub-channel is REQUIRED, and that the clobber is INHERENT to the
// collision, not an artefact of a poor scope choice. At confirmPassword the map must
// hold [min (leaf), match (refine)]. The refines-only pass only knows [match]; with a
// single map it can either drop min (scope-clears root, as modelled here) or, with a
// targeted clear of the refine key, still overwrite the whole [min, match] array —
// either way min is lost. Only separating origins holds both. The channeled model
// does. A future change that makes the naive strategy stop diverging flips the first
// expectation (and would mean the collision stopped being reachable).
describe('necessity: single-channel clobbers where channeled holds', () => {
  const seq = SEQUENCES[0]! // the password/confirm collision
  for (const a of ADAPTERS) {
    it(`[${a.tag}] single-channel diverges, channeled matches (at the collision)`, () => {
      const v = variants(a.z, seq.spec)
      const single = new SingleChannel()
      const channeled = new Channeled()
      let data: Record<string, unknown> = { ...seq.initial }
      single.seed(v, data)
      channeled.seed(v, data)
      // Drive to the collision edit (confirmPassword -> 'x': min leaf + match refine).
      const e = seq.edits[0]!
      data = { ...data, ...e.set }
      single.edit(v, data, e.editedKey)
      channeled.edit(v, data, e.editedKey)
      const whole = normMultiset(wholeFormGrouped(v, data))
      expect(normMultiset(single.read())).not.toEqual(whole) // clobbered
      expect(normMultiset(channeled.read())).toEqual(whole) // intact
    })
  }
})

// ── Ordering (within a path): leaf-then-refine at a colliding path ────────────
// The merged channel must reproduce zod's emission order at confirmPassword:
// the leaf `.min` issue (emitted during the parse) precedes the match-refine issue
// (emitted after). Cross-path insertion order is a separate impl constraint.
describe('ordering: channeled merge is leaf-then-refine at a collision', () => {
  const spec = obj({ password: L.min(8), confirmPassword: L.min(8) }, [
    eqRefine('password', 'confirmPassword', 'Passwords must match', ['confirmPassword']),
  ])
  const data = { password: 'longenough9', confirmPassword: 'x' } // confirm: min leaf + mismatch
  for (const a of ADAPTERS) {
    it(`[${a.tag}] confirmPassword issue order matches whole-form exactly`, () => {
      const v = variants(a.z, spec)
      const model = new Channeled()
      model.seed(v, data)
      const got = (model.read().get('confirmPassword') ?? []).map(issueId)
      const want = (wholeFormGrouped(v, data).get('confirmPassword') ?? []).map(issueId)
      expect(got.length).toBe(2) // both a leaf error and a refine error land here
      expect(got).toEqual(want) // exact order, not just multiset
    })
  }
})

// ── Seeded fuzz: random edit sequences over a flat refined form ────────────────
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('bookkeeping equivalence — seeded fuzz edit sequences (both adapters)', () => {
  const spec = obj({ a: L.min(3), b: L.min(3), c: L.str(), d: L.abortingMin(2) }, [
    eqRefine('a', 'b', 'a==b', ['b']),
    { type: 'refine', fn: (o: any) => o?.c !== o?.a, message: 'c!=a', path: ['c'] },
  ])
  const fields = ['a', 'b', 'c', 'd'] as const
  const values = ['', 'x', 'xx', 'xxx', 'match', 5, undefined]
  for (const a of ADAPTERS) {
    it(`[${a.tag}] 150 random edits stay byte-identical to whole-form`, () => {
      const v = variants(a.z, spec)
      const rnd = lcg(0x71b4d2)
      const model = new Channeled()
      let data: Record<string, unknown> = { a: 'x', b: 'x', c: 'y', d: 'zz' }
      model.seed(v, data)
      const divergences: Array<{ step: number; data: unknown }> = []
      if (normMultiset(model.read()) !== normMultiset(wholeFormGrouped(v, data))) {
        divergences.push({ step: -1, data: { ...data } })
      }
      for (let step = 0; step < 150; step++) {
        const field = fields[Math.floor(rnd() * fields.length)] as string
        const value = values[Math.floor(rnd() * values.length)]
        data = { ...data, [field]: value }
        model.edit(v, data, field)
        if (normMultiset(model.read()) !== normMultiset(wholeFormGrouped(v, data))) {
          divergences.push({ step, data: { ...data } })
        }
      }
      expect(divergences).toEqual([])
    })
  }
})
