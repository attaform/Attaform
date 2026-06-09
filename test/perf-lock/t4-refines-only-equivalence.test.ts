/**
 * T4 GATE HARNESS — refines-only decomposition equivalence.
 *
 * NOT a shipped behavior-lock yet; this is the go/no-go gate that must go
 * GREEN before any runtime code lands. It answers ONE load-bearing question:
 *
 *   Can the whole-form parse a container/root refine forces on every keystroke
 *   be DECOMPOSED into (leaf validation) + (refines-only) byte-identically,
 *   on BOTH adapters (zod v3 and v4 are first-class peers)?
 *
 * Why this matters: when `hasContainerOrRootRefine()` is true the keystroke
 * scheduler must run a whole-form `safeParse` (create-form-store.ts:2651),
 * re-validating every unchanged sibling leaf's own constraints — measured at
 * O(F)/keystroke, ~92-98% redundant (PERF-ANALYSIS.md "T4"). The only
 * byte-identical lever is to split that pass into the edited leaf's validation
 * (already O(1) via the subtree branch) PLUS a pass that runs ONLY the
 * container/root refines. zod can strip refines (`getSlimSchema`) but not the
 * inverse, so a "refines-only" schema is a NEW adapter primitive. Before
 * scoping it, this harness proves the decomposition is sound.
 *
 * ── The reduction under test (Variant A″) ─────────────────────────────────
 *
 * Three schema variants are built from ONE spec so the only difference is the
 * strip (exactly what a real `getRefinesOnlySchema` walker would produce):
 *
 *   full      = real leaves                 + refines kept   (parsed today)
 *   slim      = real leaves                 + refines DROPPED (the leaf half)
 *   refinesA″ = leaves reduced to base type + custom refines kept, BUILT-IN
 *               format/range checks dropped + refines kept   (the refines half)
 *
 * The reduction drops only BUILT-IN checks (`.email()`, `.min()`, `.regex()`,
 * ...) — which are provably non-aborting (they go "dirty", never abort) — and
 * KEEPS the leaf's base type, coercion, and any CUSTOM `.refine()`/
 * `.superRefine()`. Keeping custom refines is what preserves zod's abort
 * short-circuit byte-identically: an aborting leaf refine still aborts the
 * object parse, so an ancestor container refine still skips, exactly as in the
 * whole-form parse. This needs NO fatal/abort detection — which is essential,
 * because the aborting-refine keyword DIFFERS by adapter (`abort` in v4,
 * `fatal` in v3) and v3 hides it inside a closure where it is not statically
 * inspectable. Dropping built-ins / keeping refines is statically decidable on
 * both adapters, so the win (shedding the expensive sibling format checks)
 * lands on v3 and v4 alike, with no gate and no whole-form fallback.
 *
 * ── The equivalence (subtraction, not a naive union) ──────────────────────
 *
 * A naive `issues(slim) ∪ issues(refinesA″)` double-counts: a wrong-type leaf
 * errors in BOTH halves (the reduction keeps the type check). The faithful
 * model of what the scheduler reconstructs is:
 *
 *   full  ==  issues(slim)  ⊎  ( issues(refinesA″) ∖ issues(reducedNoRefines) )
 *
 * where the subtracted term is the reduction's INCIDENTAL leaf issues (type
 * errors + kept-refine issues — the ones the leaf half already owns), leaving
 * its pure CONTAINER-REFINE delta. `slim` stands in for the aggregate leaf
 * issue set the scheduler maintains across keystrokes (the subtree branch's
 * faithful incremental maintenance is a separately-established property — it
 * ships today for refine-free forms).
 *
 * ── What this harness pins ────────────────────────────────────────────────
 *
 * 1. EQUIVALENCE: Variant A″ reconstructs the whole-form verdict for every
 *    scenario (incl. aborting leaf refines, both spellings) + 800 fuzz
 *    samples, on BOTH adapters.
 * 2. NECESSITY (`why keep custom refines`): the NAIVE type-only strip (drop
 *    custom refines too) DIVERGES on both adapters — v3 via `fatal`, v4 via
 *    `abort` — proving the reduction must keep custom refines, and that v3 is
 *    handled identically to v4. A future zod change to either spelling
 *    surfaces here.
 * 3. The refines-only half genuinely RAISES cross-field verdicts (non-vacuous
 *    password/confirm assertion), so equivalence can't pass by both sides
 *    silently agreeing on "no error".
 */
import { describe, it, expect } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Z = any

// ── Spec model ────────────────────────────────────────────────────────────
// A spec is a schema tree. Leaves carry their real schema plus TWO reductions,
// so the harness never introspects zod internals — it wires structure +
// refines and swaps leaf builders:
//   - typeOnly   : base type + coercion only (the NAIVE strip; for the
//                  necessity block).
//   - refineKept : base type + coercion + custom refines, built-ins dropped
//                  (Variant A″; what we ship). Defaults to typeOnly when the
//                  leaf has no custom refine.

type Leaf = {
  kind: 'leaf'
  full: (z: Z) => any
  typeOnly: (z: Z) => any
  refineKept: (z: Z) => any
}
type Refine =
  | {
      type: 'refine'
      fn: (v: any) => boolean
      message: string
      path?: (string | number)[]
      /** Aborting refine. Emitted with BOTH adapter spellings (v4 `abort`, v3 `fatal`). */
      abort?: boolean
    }
  | { type: 'super'; run: (v: any, ctx: any) => void }
type ObjNode = { kind: 'object'; fields: Record<string, Node>; refines?: Refine[] }
type ArrNode = { kind: 'array'; element: Node; refines?: Refine[] }
type Node = Leaf | ObjNode | ArrNode

function leaf(full: (z: Z) => any, typeOnly: (z: Z) => any, refineKept?: (z: Z) => any): Leaf {
  return { kind: 'leaf', full, typeOnly, refineKept: refineKept ?? typeOnly }
}
function obj(fields: Record<string, Node>, refines?: Refine[]): ObjNode {
  return refines === undefined ? { kind: 'object', fields } : { kind: 'object', fields, refines }
}
function arr(element: Node, refines?: Refine[]): ArrNode {
  return refines === undefined ? { kind: 'array', element } : { kind: 'array', element, refines }
}

type LeafMode = 'full' | 'typeOnly' | 'refineKept'
type BuildOpts = { leafMode: LeafMode; dropRefines: boolean }

function applyRefines(schema: any, refines: Refine[] | undefined, opts: BuildOpts): any {
  if (opts.dropRefines || refines === undefined) return schema
  let s = schema
  for (const r of refines) {
    if (r.type === 'super') {
      s = s.superRefine(r.run)
    } else {
      const params = {
        message: r.message,
        ...(r.path !== undefined ? { path: r.path } : {}),
        // Portable abort: v4 reads `abort`, v3 reads `fatal`; pass both.
        ...(r.abort === true ? { abort: true, fatal: true } : {}),
      }
      s = s.refine(r.fn, params)
    }
  }
  return s
}

function build(z: Z, node: Node, opts: BuildOpts): any {
  switch (node.kind) {
    case 'leaf':
      return node[opts.leafMode](z)
    case 'object': {
      const shape: Record<string, any> = {}
      for (const [k, v] of Object.entries(node.fields)) shape[k] = build(z, v, opts)
      return applyRefines(z.object(shape), node.refines, opts)
    }
    case 'array':
      return applyRefines(z.array(build(z, node.element, opts)), node.refines, opts)
  }
}

type Reduction = { refines: any; noRefines: any }
type Variants = { full: any; slim: any; prime: Reduction; naive: Reduction }
function variants(z: Z, spec: Node): Variants {
  const mk = (leafMode: LeafMode, dropRefines: boolean) => build(z, spec, { leafMode, dropRefines })
  return {
    full: mk('full', false),
    slim: mk('full', true),
    prime: { refines: mk('refineKept', false), noRefines: mk('refineKept', true) },
    naive: { refines: mk('typeOnly', false), noRefines: mk('typeOnly', true) },
  }
}

// ── Issue normalization + multiset algebra ────────────────────────────────
// Compare issues as a MULTISET of {path, code, message}. Comparison is always
// within one adapter (full vs decomposition, same `z`), so v3/v4 wording
// differences never cross.

function normIssues(result: { success: boolean; error?: { issues: any[] } }): string[] {
  if (result.success) return []
  return (result.error?.issues ?? []).map((i: any) =>
    JSON.stringify({ path: i.path.join('.'), code: i.code, message: i.message })
  )
}

/** Multiset difference A ∖ B: drop one occurrence of A per element of B. */
function multisetSubtract(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>()
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1)
  const out: string[] = []
  for (const x of a) {
    const c = counts.get(x) ?? 0
    if (c > 0) counts.set(x, c - 1)
    else out.push(x)
  }
  return out
}

function sortedMultiset(xs: string[]): string[] {
  return [...xs].sort()
}

/** issues(slim) ⊎ ( issues(reduction.refines) ∖ issues(reduction.noRefines) ) */
function decompose(v: Variants, data: unknown, mode: 'prime' | 'naive'): string[] {
  const reduction = mode === 'prime' ? v.prime : v.naive
  const leafIssues = normIssues(v.slim.safeParse(data))
  const refineDelta = multisetSubtract(
    normIssues(reduction.refines.safeParse(data)),
    normIssues(reduction.noRefines.safeParse(data))
  )
  return sortedMultiset([...leafIssues, ...refineDelta])
}

function wholeForm(v: Variants, data: unknown): string[] {
  return sortedMultiset(normIssues(v.full.safeParse(data)))
}

// ── Leaf builders (real + reductions) ─────────────────────────────────────
// Built-in checks reduce to their base type (dropped in both reductions).
// Custom refines are kept by `refineKept` (Variant A″) but dropped by the
// naive `typeOnly`.
const ABORT = { message: 'leaf-abort', abort: true, fatal: true } as const

const L = {
  str: () =>
    leaf(
      (z) => z.string(),
      (z) => z.string()
    ),
  email: () =>
    leaf(
      (z) => z.string().email(),
      (z) => z.string()
    ),
  min: (n: number) =>
    leaf(
      (z) => z.string().min(n),
      (z) => z.string()
    ),
  regex: (re: RegExp) =>
    leaf(
      (z) => z.string().regex(re),
      (z) => z.string()
    ),
  num: () =>
    leaf(
      (z) => z.number(),
      (z) => z.number()
    ),
  numRange: (lo: number, hi: number) =>
    leaf(
      (z) => z.number().min(lo).max(hi),
      (z) => z.number()
    ),
  coerceNum: () =>
    leaf(
      (z) => z.coerce.number(),
      (z) => z.coerce.number()
    ),
  coerceNumMin: (lo: number) =>
    leaf(
      (z) => z.coerce.number().min(lo),
      (z) => z.coerce.number()
    ),
  optMin: (n: number) =>
    leaf(
      (z) => z.string().min(n).optional(),
      (z) => z.string().optional()
    ),
  /** Non-fatal CUSTOM leaf refine: dirty, kept by A″. typeOnly drops it. */
  startsWith: (p: string) =>
    leaf(
      (z) => z.string().refine((s: string) => s.startsWith(p), { message: `starts ${p}` }),
      (z) => z.string(),
      (z) => z.string().refine((s: string) => s.startsWith(p), { message: `starts ${p}` })
    ),
  /** ABORTING custom leaf refine (both spellings). A″ keeps it; typeOnly drops it. */
  abortingMin: (n: number) =>
    leaf(
      (z) => z.string().refine((s: string) => s.length >= n, ABORT),
      (z) => z.string(),
      (z) => z.string().refine((s: string) => s.length >= n, ABORT)
    ),
  /** Built-in `.min` (dropped) AND an aborting custom refine (kept by A″). */
  minThenAbort: (builtin: number, abortLen: number) =>
    leaf(
      (z) =>
        z
          .string()
          .min(builtin)
          .refine((s: string) => s.length >= abortLen, ABORT),
      (z) => z.string(),
      (z) => z.string().refine((s: string) => s.length >= abortLen, ABORT)
    ),
}

// ── Adversarial scenarios (all must HOLD under Variant A″, both adapters) ──
type Scenario = {
  name: string
  spec: Node
  samples: Array<{ label: string; data: unknown }>
}

const eqRefine = (a: string, b: string, msg: string): Refine => ({
  type: 'refine',
  fn: (o: any) => o?.[a] === o?.[b],
  message: msg,
})

const SCENARIOS: Scenario[] = [
  {
    name: 'flat: root refine over two constrained leaves',
    spec: obj({ f0: L.min(2), f1: L.email(), f2: L.str() }, [
      eqRefine('f0', 'f2', 'f0 must equal f2'),
    ]),
    samples: [
      { label: 'all-valid, refine passes', data: { f0: 'xx', f1: 'a@b.co', f2: 'xx' } },
      { label: 'all-valid, refine FAILS', data: { f0: 'xx', f1: 'a@b.co', f2: 'yy' } },
      { label: 'f1 bad email + refine fails', data: { f0: 'xx', f1: 'nope', f2: 'zz' } },
      { label: 'f0 too short + refine passes', data: { f0: 'x', f1: 'a@b.co', f2: 'x' } },
      { label: 'f0 wrong type (number)', data: { f0: 5, f1: 'a@b.co', f2: 'xx' } },
      { label: 'f2 wrong type + refine would fail', data: { f0: 'xx', f1: 'a@b.co', f2: 99 } },
      { label: 'all wrong type', data: { f0: 1, f1: 2, f2: 3 } },
      { label: 'missing keys', data: { f0: 'xx' } },
    ],
  },
  {
    name: 'flat: multiple independent root refines',
    spec: obj({ a: L.str(), b: L.str(), c: L.num() }, [
      eqRefine('a', 'b', 'a==b'),
      { type: 'refine', fn: (o: any) => (o?.c ?? 0) > 10, message: 'c>10', path: ['c'] },
    ]),
    samples: [
      { label: 'both refines pass', data: { a: 'q', b: 'q', c: 20 } },
      { label: 'first fails', data: { a: 'q', b: 'r', c: 20 } },
      { label: 'second fails', data: { a: 'q', b: 'q', c: 1 } },
      { label: 'both fail', data: { a: 'q', b: 'r', c: 1 } },
      { label: 'c wrong type aborts both', data: { a: 'q', b: 'q', c: 'NaN' } },
    ],
  },
  {
    name: 'nested: refine at a NON-root container (scope locality)',
    spec: obj({
      a: obj({ x: L.min(2), y: L.str() }, [eqRefine('x', 'y', 'a.x==a.y')]),
      b: obj({ z: L.email() }),
    }),
    samples: [
      { label: 'nested refine passes', data: { a: { x: 'pp', y: 'pp' }, b: { z: 'a@b.co' } } },
      { label: 'nested refine fails', data: { a: { x: 'pp', y: 'qq' }, b: { z: 'a@b.co' } } },
      {
        label: 'b errors, a refine still runs',
        data: { a: { x: 'pp', y: 'qq' }, b: { z: 'bad' } },
      },
      {
        label: 'a.x too short + a refine fails',
        data: { a: { x: 'p', y: 'qq' }, b: { z: 'a@b.co' } },
      },
      { label: 'a.x wrong type', data: { a: { x: 5, y: 'qq' }, b: { z: 'a@b.co' } } },
    ],
  },
  {
    name: 'nested: root refine reading across branches',
    spec: obj({ a: obj({ x: L.str() }), b: obj({ y: L.str() }) }, [
      {
        type: 'refine',
        fn: (o: any) => o?.a?.x === o?.b?.y,
        message: 'a.x==b.y',
        path: ['b', 'y'],
      },
    ]),
    samples: [
      { label: 'cross-branch refine passes', data: { a: { x: 'k' }, b: { y: 'k' } } },
      { label: 'cross-branch refine fails', data: { a: { x: 'k' }, b: { y: 'm' } } },
      { label: 'a.x type fail aborts root refine', data: { a: { x: 7 }, b: { y: 'm' } } },
    ],
  },
  {
    name: 'coercion: refine reads COERCED leaf values',
    spec: obj({ lo: L.coerceNumMin(0), hi: L.coerceNum() }, [
      { type: 'refine', fn: (o: any) => o?.hi >= o?.lo, message: 'hi>=lo', path: ['hi'] },
    ]),
    samples: [
      { label: 'coerced strings, refine passes', data: { lo: '3', hi: '5' } },
      { label: 'coerced strings, refine fails', data: { lo: '5', hi: '3' } },
      { label: 'lo below min (dirty) + refine', data: { lo: '-1', hi: '5' } },
      { label: 'hi uncoercible (type abort)', data: { lo: '3', hi: 'abc' } },
      { label: 'native numbers pass', data: { lo: 1, hi: 2 } },
    ],
  },
  {
    name: 'superRefine: custom-path issues',
    spec: obj({ p: L.str(), q: L.str() }, [
      {
        type: 'super',
        run: (o: any, ctx: any) => {
          if (o?.p === o?.q) ctx.addIssue({ code: 'custom', path: ['q'], message: 'must differ' })
          if ((o?.p?.length ?? 0) > 3)
            ctx.addIssue({ code: 'custom', path: ['p'], message: 'p too long' })
        },
      },
    ]),
    samples: [
      { label: 'no issues', data: { p: 'ab', q: 'cd' } },
      { label: 'equal -> q issue', data: { p: 'ab', q: 'ab' } },
      { label: 'long p -> p issue', data: { p: 'abcde', q: 'z' } },
      { label: 'both super issues', data: { p: 'aaaa', q: 'aaaa' } },
      { label: 'p type fail aborts super', data: { p: 5, q: 'cd' } },
    ],
  },
  {
    name: 'array: element-level + root refine',
    spec: obj(
      {
        rows: arr(
          obj({ name: L.min(2), qty: L.num() }, [
            {
              type: 'refine',
              fn: (r: any) => (r?.qty ?? 0) >= 0,
              message: 'qty>=0',
              path: ['qty'],
            },
          ])
        ),
      },
      [{ type: 'refine', fn: (o: any) => (o?.rows?.length ?? 0) > 0, message: 'rows nonempty' }]
    ),
    samples: [
      { label: 'valid rows', data: { rows: [{ name: 'aa', qty: 1 }] } },
      { label: 'empty -> root refine', data: { rows: [] } },
      { label: 'element refine fails', data: { rows: [{ name: 'aa', qty: -1 }] } },
      { label: 'element constraint + refine', data: { rows: [{ name: 'a', qty: -1 }] } },
      { label: 'element type abort', data: { rows: [{ name: 'aa', qty: 'x' }] } },
    ],
  },
  {
    name: 'optional/nullable leaves under a refine',
    spec: obj({ a: L.optMin(3), b: L.str() }, [
      {
        type: 'refine',
        fn: (o: any) => o?.a === undefined || o?.a !== o?.b,
        message: 'a!=b when present',
        path: ['a'],
      },
    ]),
    samples: [
      { label: 'a absent, refine passes', data: { b: 'x' } },
      { label: 'a present distinct', data: { a: 'abcd', b: 'x' } },
      { label: 'a present equal -> refine', data: { a: 'xxx', b: 'xxx' } },
      { label: 'a too short (dirty) + refine', data: { a: 'ab', b: 'ab' } },
    ],
  },
  {
    // The reduction is NOT "any custom leaf refine triggers a fallback": a
    // non-fatal custom leaf refine is dirty, the container refine still runs,
    // and A″ keeps the leaf refine so it decomposes.
    name: 'non-fatal custom leaf refine under a root refine',
    spec: obj({ f0: L.startsWith('a'), f1: L.str() }, [eqRefine('f0', 'f1', 'f0==f1')]),
    samples: [
      { label: 'leaf refine passes, root passes', data: { f0: 'ax', f1: 'ax' } },
      { label: 'leaf refine FAILS (dirty) + root fails', data: { f0: 'bx', f1: 'zz' } },
      { label: 'leaf refine fails (dirty) + root would pass', data: { f0: 'bx', f1: 'bx' } },
      { label: 'f0 wrong type aborts', data: { f0: 9, f1: 'zz' } },
    ],
  },
  {
    // The case v3-first-class demands: an ABORTING leaf refine (both spellings)
    // suppresses the root refine in `full` on BOTH adapters. A″ keeps the leaf
    // refine, so refines-only aborts identically -> holds on both.
    name: 'aborting leaf refine under a root refine (the v3/v4 short-circuit)',
    spec: obj({ f0: L.abortingMin(3), f1: L.str() }, [eqRefine('f0', 'f1', 'f0==f1')]),
    samples: [
      { label: 'f0 aborts, root would fail', data: { f0: 'ab', f1: 'zz' } },
      { label: 'f0 aborts, root would pass', data: { f0: 'ab', f1: 'ab' } },
      { label: 'f0 ok, root fails', data: { f0: 'abcd', f1: 'zz' } },
      { label: 'f0 ok, root passes', data: { f0: 'abcd', f1: 'abcd' } },
    ],
  },
  {
    // Mixed leaf: a dropped built-in `.min` PLUS a kept aborting refine.
    // Proves the reduction sheds the built-in cost while preserving the abort.
    name: 'leaf with a built-in check AND an aborting refine',
    spec: obj({ f0: L.minThenAbort(2, 3), f1: L.str() }, [eqRefine('f0', 'f1', 'f0==f1')]),
    samples: [
      { label: 'f0 fails both (abort) root would fail', data: { f0: 'a', f1: 'zz' } },
      { label: 'f0 passes min, aborts refine', data: { f0: 'ab', f1: 'zz' } },
      { label: 'f0 satisfies both, root fails', data: { f0: 'abcd', f1: 'zz' } },
    ],
  },
  {
    // Fatal refine at a CONTAINER node is self-handled: refines-only keeps
    // container refines, so it aborts exactly where `full` does.
    name: 'aborting refine at a container node (self-handled)',
    spec: obj(
      {
        a: obj({ x: L.str(), y: L.str() }, [
          { type: 'refine', fn: (o: any) => o?.x === o?.y, message: 'a.x==a.y', abort: true },
        ]),
      },
      [{ type: 'refine', fn: (o: any) => (o?.a?.x?.length ?? 0) > 1, message: 'a.x long' }]
    ),
    samples: [
      { label: 'container refine passes, root checks', data: { a: { x: 'pp', y: 'pp' } } },
      { label: 'container aborts -> root suppressed', data: { a: { x: 'p', y: 'q' } } },
      { label: 'container passes, root fails', data: { a: { x: 'p', y: 'p' } } },
    ],
  },
  {
    // Explicit password / confirmPassword — the canonical cross-field refine.
    name: 'password / confirmPassword equality refine',
    spec: obj({ password: L.min(8), confirmPassword: L.str() }, [
      {
        type: 'refine',
        fn: (o: any) => o?.password === o?.confirmPassword,
        message: 'Passwords must match',
        path: ['confirmPassword'],
      },
    ]),
    samples: [
      { label: 'match', data: { password: 'secretpw', confirmPassword: 'secretpw' } },
      // confirm changed to a mismatching value -> refine concludes mismatch
      {
        label: 'mismatch (confirm edited)',
        data: { password: 'secretpw', confirmPassword: 'secretpx' },
      },
      // password too short (leaf) AND mismatch -> both surface, refine still runs
      { label: 'short password + mismatch', data: { password: 'short', confirmPassword: 'nope' } },
      { label: 'confirm wrong type aborts', data: { password: 'secretpw', confirmPassword: 5 } },
    ],
  },
]

const ADAPTERS: Array<{ tag: 'v4' | 'v3'; z: Z }> = [
  { tag: 'v4', z: zV4 },
  { tag: 'v3', z: zV3 },
]

describe('T4 refines-only decomposition equivalence (Variant A″)', () => {
  for (const a of ADAPTERS) {
    describe(`[${a.tag}]`, () => {
      for (const sc of SCENARIOS) {
        describe(sc.name, () => {
          const v = variants(a.z, sc.spec)
          for (const s of sc.samples) {
            it(s.label, () => {
              expect(decompose(v, s.data, 'prime')).toEqual(wholeForm(v, s.data))
            })
          }
        })
      }
    })
  }
})

// ── Necessity: the naive type-only strip breaks on BOTH adapters ──────────
// Drops custom refines too. The aborting leaf refine then no longer aborts in
// the refines-only half, so a suppressed (would-fail) root refine wrongly
// reappears — v3 via `fatal`, v4 via `abort`. This is exactly why A″ keeps
// custom refines, and why v3 needs identical treatment to v4. If a future zod
// release changes an abort spelling, the "diverges" expectation flips here.
describe('necessity: naive type-only strip diverges where A″ holds', () => {
  const spec = obj({ f0: L.abortingMin(3), f1: L.str() }, [eqRefine('f0', 'f1', 'f0==f1')])
  // The data where the abort suppresses a WOULD-FAIL root refine.
  const data = { f0: 'ab', f1: 'zz' }
  for (const a of ADAPTERS) {
    it(`[${a.tag}] naive diverges, A″ holds`, () => {
      const v = variants(a.z, spec)
      const whole = wholeForm(v, data)
      expect(decompose(v, data, 'naive')).not.toEqual(whole) // naive is WRONG
      expect(decompose(v, data, 'prime')).toEqual(whole) // A″ is right
    })
  }
})

// ── Non-vacuous: the refines-only half genuinely raises the mismatch ──────
// Equivalence could pass if BOTH sides silently agreed on "no error". This
// asserts the cross-field verdict is actually PRODUCED by the refines-only
// pass (the container-refine delta), not merely matched by absence.
describe('non-vacuous: refines-only raises the password mismatch', () => {
  const spec = obj({ password: L.min(8), confirmPassword: L.str() }, [
    {
      type: 'refine',
      fn: (o: any) => o?.password === o?.confirmPassword,
      message: 'Passwords must match',
      path: ['confirmPassword'],
    },
  ])
  const mismatch = { password: 'secretpw', confirmPassword: 'secretpx' }
  const hasMismatch = (issues: string[]) =>
    issues.some((s) => s.includes('confirmPassword') && s.includes('Passwords must match'))
  for (const a of ADAPTERS) {
    it(`[${a.tag}] the mismatch is real and carried by the refines-only delta`, () => {
      const v = variants(a.z, spec)
      // whole-form raises it
      expect(hasMismatch(wholeForm(v, mismatch))).toBe(true)
      // the refines-only delta (not the leaf half) is what carries it
      const delta = multisetSubtract(
        normIssues(v.prime.refines.safeParse(mismatch)),
        normIssues(v.prime.noRefines.safeParse(mismatch))
      )
      expect(hasMismatch(delta)).toBe(true)
      // the leaf half alone does NOT raise it
      expect(hasMismatch(normIssues(v.slim.safeParse(mismatch)))).toBe(false)
      // and the whole thing decomposes
      expect(decompose(v, mismatch, 'prime')).toEqual(wholeForm(v, mismatch))
    })
  }
})

// ── Seeded fuzz: parametric flat form, randomized data ────────────────────
// Breadth past the hand-picked cases. A deterministic LCG keeps failures
// reproducible (a divergence prints the offending sample).

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function fuzzFlatSpec(): Node {
  return obj(
    {
      f0: L.min(2),
      f1: L.email(),
      f2: L.regex(/^[a-z]+$/),
      f3: L.numRange(0, 100),
      f4: L.coerceNumMin(0),
      f5: L.startsWith('z'),
    },
    [
      { type: 'refine', fn: (o: any) => o?.f0 !== o?.f2, message: 'f0!=f2', path: ['f2'] },
      { type: 'refine', fn: (o: any) => (o?.f3 ?? 0) + (o?.f4 ?? 0) < 150, message: 'sum<150' },
    ]
  )
}

function fuzzSample(rnd: () => number): Record<string, unknown> {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  return {
    f0: pick(['x', 'xx', 'xxx', 5, undefined]),
    f1: pick(['a@b.co', 'bad', 'xx', 7]),
    f2: pick(['abc', 'ABC', 'a1c', 'xx', null]),
    f3: pick([10, 50, 200, -5, 'NaN', 50.5]),
    f4: pick(['0', '5', '-3', 'abc', 80, 200]),
    f5: pick(['zoo', 'zip', 'nope', 4]),
  }
}

describe('T4 decomposition equivalence — seeded fuzz (flat, both adapters)', () => {
  for (const a of ADAPTERS) {
    it(`[${a.tag}] 400 randomized samples reconstruct the whole-form verdict`, () => {
      const v = variants(a.z, fuzzFlatSpec())
      const rnd = lcg(0x5eed1234)
      const divergences: Array<{ data: unknown; whole: string[]; decomposed: string[] }> = []
      for (let i = 0; i < 400; i++) {
        const data = fuzzSample(rnd)
        const whole = wholeForm(v, data)
        const decomposed = decompose(v, data, 'prime')
        if (JSON.stringify(whole) !== JSON.stringify(decomposed)) {
          divergences.push({ data, whole, decomposed })
        }
      }
      expect(divergences).toEqual([])
    })
  }
})
