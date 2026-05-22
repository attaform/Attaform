import { describe, expect, it } from 'vitest'
import {
  buildWizardGraph,
  walkRuntimePath,
  WizardCycleError,
} from '../../src/runtime/core/wizard-graph'
import type { AnyForm, NormalizedNext } from '../../src/runtime/types/types-wizard'

/**
 * `wizard-graph.ts` is a pure, framework-free module. It walks the
 * static graph described by `form.next` declarations, detects cycles,
 * builds a tree for sitemap rendering, and offers a runtime-path
 * walker that consults each form's `pick(parsed)` to pick a branch.
 *
 * No Vue mount needed — the module reads `{ key, next? }` from AnyForm
 * objects and is independent of the form lifecycle. Production usage
 * passes real `useForm` handles in (which satisfy AnyForm via their
 * structural shape); tests pass plain objects.
 */

type FormFixture = {
  key: string
  next?: NormalizedNext
}

function form(key: string, next?: NormalizedNext): FormFixture {
  if (next === undefined) return { key }
  return { key, next }
}

function identity(target: AnyForm): NormalizedNext {
  return { forms: [target], pick: () => target }
}

function branching(
  forms: readonly AnyForm[],
  picker: (parsed: unknown) => AnyForm | undefined
): NormalizedNext {
  return { forms, pick: picker }
}

describe('wizard-graph: buildWizardGraph', () => {
  describe('BFS enumeration', () => {
    it('enumerates a linear identity chain in BFS order', () => {
      const c = form('c')
      const b = form('b', identity(c))
      const a = form('a', identity(b))
      const graph = buildWizardGraph(a)
      expect(graph.allForms.map((f) => f.key)).toEqual(['a', 'b', 'c'])
    })

    it('enumerates a branching graph, deduping convergent paths in allForms', () => {
      const review = form('review')
      const admin = form('admin', identity(review))
      const user = form('user', identity(review))
      const account = form(
        'account',
        branching([admin, user], (p) => ((p as { role: string }).role === 'admin' ? admin : user))
      )
      const graph = buildWizardGraph(account)
      expect(graph.allForms.map((f) => f.key)).toEqual(['account', 'admin', 'user', 'review'])
    })

    it('exposes O(1) byKey lookup', () => {
      const c = form('c')
      const b = form('b', identity(c))
      const a = form('a', identity(b))
      const graph = buildWizardGraph(a)
      expect(graph.byKey.get('a')).toBe(a)
      expect(graph.byKey.get('b')).toBe(b)
      expect(graph.byKey.get('c')).toBe(c)
      expect(graph.byKey.get('missing')).toBeUndefined()
    })

    it('preserves form object identity (does not clone)', () => {
      const c = form('c')
      const b = form('b', identity(c))
      const a = form('a', identity(b))
      const graph = buildWizardGraph(a)
      expect(graph.allForms[0]).toBe(a)
      expect(graph.allForms[1]).toBe(b)
      expect(graph.allForms[2]).toBe(c)
    })

    it('exposes entry on the returned graph', () => {
      const a = form('a')
      const graph = buildWizardGraph(a)
      expect(graph.entry).toBe(a)
    })
  })

  describe('cycle detection', () => {
    it('throws WizardCycleError for a self-cycle', () => {
      const a: FormFixture = { key: 'a' }
      a.next = identity(a)
      expect(() => buildWizardGraph(a)).toThrow(WizardCycleError)
    })

    it('throws WizardCycleError for an A → B → A cycle', () => {
      const a: FormFixture = { key: 'a' }
      const b: FormFixture = { key: 'b' }
      a.next = identity(b)
      b.next = identity(a)
      expect(() => buildWizardGraph(a)).toThrow(WizardCycleError)
    })

    it('cycle error carries the cycle path through `cyclePath`', () => {
      const a: FormFixture = { key: 'a' }
      const b: FormFixture = { key: 'b' }
      const c: FormFixture = { key: 'c' }
      a.next = identity(b)
      b.next = identity(c)
      c.next = identity(a)
      try {
        buildWizardGraph(a)
        throw new Error('expected throw, got no throw')
      } catch (err) {
        expect(err).toBeInstanceOf(WizardCycleError)
        expect((err as WizardCycleError).cyclePath).toEqual(['a', 'b', 'c', 'a'])
      }
    })

    it('cycle error message names every step in the cycle', () => {
      const a: FormFixture = { key: 'a' }
      const b: FormFixture = { key: 'b' }
      a.next = identity(b)
      b.next = identity(a)
      try {
        buildWizardGraph(a)
        throw new Error('expected throw')
      } catch (err) {
        expect((err as Error).message).toContain(`'a'`)
        expect((err as Error).message).toContain(`'b'`)
      }
    })

    it('does NOT flag convergent paths as cycles', () => {
      const review = form('review')
      const admin = form('admin', identity(review))
      const user = form('user', identity(review))
      const account = form(
        'account',
        branching([admin, user], () => admin)
      )
      expect(() => buildWizardGraph(account)).not.toThrow()
    })

    it('does NOT flag sibling-shared-terminal as a cycle', () => {
      // a → (b → terminal) AND a → (c → terminal); terminal reached twice.
      const terminal = form('terminal')
      const b = form('b', identity(terminal))
      const c = form('c', identity(terminal))
      const a = form(
        'a',
        branching([b, c], () => b)
      )
      expect(() => buildWizardGraph(a)).not.toThrow()
    })
  })

  describe('tree builder', () => {
    it('builds a flat tree for a single-step entry', () => {
      const a = form('a')
      const graph = buildWizardGraph(a)
      expect(graph.tree).toEqual({ key: 'a', next: [] })
    })

    it('builds a nested tree for a linear identity chain', () => {
      const c = form('c')
      const b = form('b', identity(c))
      const a = form('a', identity(b))
      const graph = buildWizardGraph(a)
      expect(graph.tree).toEqual({
        key: 'a',
        next: [{ key: 'b', next: [{ key: 'c', next: [] }] }],
      })
    })

    it('duplicates convergent subtrees (DAG flattened to a tree)', () => {
      const review = form('review')
      const admin = form('admin', identity(review))
      const user = form('user', identity(review))
      const account = form(
        'account',
        branching([admin, user], () => admin)
      )
      const graph = buildWizardGraph(account)
      expect(graph.tree).toEqual({
        key: 'account',
        next: [
          { key: 'admin', next: [{ key: 'review', next: [] }] },
          { key: 'user', next: [{ key: 'review', next: [] }] },
        ],
      })
    })
  })

  describe('diagnostic warnings', () => {
    it('warns for an empty `forms` tuple on a branching next', () => {
      const a = form('a', { forms: [], pick: () => undefined })
      const graph = buildWizardGraph(a)
      const empty = graph.warnings.find((w) => w.kind === 'empty-forms')
      expect(empty).toBeDefined()
      expect(empty?.key).toBe('a')
      expect(empty?.severity).toBe('warn')
    })

    it('warns for a single-step wizard (entry has no next)', () => {
      const a = form('a')
      const graph = buildWizardGraph(a)
      const single = graph.warnings.find((w) => w.kind === 'single-step')
      expect(single).toBeDefined()
      expect(single?.key).toBe('a')
    })

    it('does NOT warn for multi-step linear chain', () => {
      const c = form('c')
      const b = form('b', identity(c))
      const a = form('a', identity(b))
      const graph = buildWizardGraph(a)
      expect(graph.warnings).toEqual([])
    })

    it('does NOT warn for multi-step branching graph', () => {
      const review = form('review')
      const admin = form('admin', identity(review))
      const user = form('user', identity(review))
      const account = form(
        'account',
        branching([admin, user], () => admin)
      )
      const graph = buildWizardGraph(account)
      expect(graph.warnings).toEqual([])
    })
  })
})

describe('wizard-graph: walkRuntimePath', () => {
  it('walks a linear identity chain to the terminal', () => {
    const c = form('c')
    const b = form('b', identity(c))
    const a = form('a', identity(b))
    const path = walkRuntimePath(a, () => ({}))
    expect(path.map((f) => f.key)).toEqual(['a', 'b', 'c'])
  })

  it('walks the branch picked by `pick(parsed)`', () => {
    const review = form('review')
    const admin = form('admin', identity(review))
    const user = form('user', identity(review))
    const account = form(
      'account',
      branching([admin, user], (p) => ((p as { role: string }).role === 'admin' ? admin : user))
    )

    const adminPath = walkRuntimePath(account, () => ({ role: 'admin' }))
    expect(adminPath.map((f) => f.key)).toEqual(['account', 'admin', 'review'])

    const userPath = walkRuntimePath(account, () => ({ role: 'user' }))
    expect(userPath.map((f) => f.key)).toEqual(['account', 'user', 'review'])
  })

  it('stops at a dynamic terminal when `pick` returns undefined', () => {
    const optionalNext = form('optional-next')
    const a = form(
      'a',
      branching([optionalNext], () => undefined)
    )
    const path = walkRuntimePath(a, () => ({}))
    expect(path.map((f) => f.key)).toEqual(['a'])
  })

  it('stops on a single-step entry without invoking getParsed', () => {
    const a = form('a')
    const calls: string[] = []
    const path = walkRuntimePath(a, (f) => {
      calls.push(f.key)
      return {}
    })
    expect(path.map((f) => f.key)).toEqual(['a'])
    expect(calls).toEqual([])
  })

  it('calls `getParsed(form)` once per non-terminal step (not on terminal)', () => {
    const c = form('c')
    const b = form('b', identity(c))
    const a = form('a', identity(b))
    const calls: string[] = []
    walkRuntimePath(a, (f) => {
      calls.push(f.key)
      return {}
    })
    expect(calls).toEqual(['a', 'b'])
  })

  it('propagates `OutOfFormsListError` thrown by a normalized `pick`', () => {
    // normalize-next wraps `pick` with an out-of-list guard. Simulate that
    // here by constructing a `pick` that throws — walkRuntimePath should
    // propagate, not swallow.
    const declared = form('declared')
    const sentinel = new Error('out-of-list')
    const a = form('a', {
      forms: [declared],
      pick: () => {
        throw sentinel
      },
    })
    expect(() => walkRuntimePath(a, () => ({}))).toThrow(sentinel)
  })
})
