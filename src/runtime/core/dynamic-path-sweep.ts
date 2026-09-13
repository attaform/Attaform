/**
 * One liveness sweep over every per-path cache a form holds (#612,
 * #617).
 *
 * Each surface memoises per canonical path so repeated reads stay
 * cheap: the field-state accessor's `ComputedRef`s, `form.fields`'s
 * view proxies, the container proxies behind `form.fields` and
 * `form.errors`, their schema-presence memo, and the errors surface's
 * materialised trees. None of them was ever evicted, so across a
 * churning dynamic path set they grew with the number of paths the
 * form had ever read rather than the number it currently has. A form
 * editing a `z.record` across a session accumulated an entry per key
 * it ever touched, in every one of them.
 *
 * The field-state cache was the sharp end, because an entry holds its
 * path's `value` and its `original` and so pinned form data rather
 * than bookkeeping alone: 200 of 200 removed keys still reachable,
 * 12.5 MB pinned by a form whose value was `{}`. The rest hold proxies,
 * closures and path strings, which is a milder problem of the same
 * shape.
 *
 * Every write checks a bounded slice of the tracked set for liveness
 * and drops what the form no longer has from every registered cache at
 * once, resuming where the last write stopped. A fixed slice rather
 * than a whole pass keeps the per-write cost flat as the form grows,
 * which a per-write O(cache) walk would not: these entries are
 * deliberately per-path so one field's change does not wake another,
 * and sweeping all of them on every keystroke would spend exactly what
 * that buys. One shared registry rather than one per cache means one
 * subscription, one cursor and ONE liveness walk per candidate, which
 * is the expensive half; the evictions are map deletes.
 *
 * Evicting is invisible to consumers, but only because the sweep drops
 * a path the form no longer HAS. `form.fields.<path>` is pinned to
 * return an identity-stable view, so dropping the view of a live path
 * would break that contract outright. A dead path's view is
 * unreachable through the surface it came from, and if a consumer
 * still holds one its traps re-resolve live state per hit, so it keeps
 * reading correctly and simply stops being served from a cache.
 */
import { toRaw } from 'vue'
import type { GenericForm } from '../types/types-core'
import type { FormStore } from './create-form-store'
import { hasAtPath } from './path-walker'
import { segmentsForPathKey, type Path, type PathKey } from './paths'

/**
 * How many tracked paths one write checks for liveness. The sweep
 * resumes where it left off, so the whole set is covered every
 * `size / SWEEP_SLICE` writes at a cost per write that does not grow
 * with the form. Measured against a 27-row form holding 135 of them,
 * 8 puts the added write cost at the noise floor where 32 cost a
 * repeatable ~28%, and still sweeps that form end to end every 17
 * writes.
 */
const SWEEP_SLICE = 8

export type DynamicPathSweep = {
  /**
   * Note that a cache has just stored an entry for `segments` under
   * `key`. Paths a schema shape bounds are ignored, so only the
   * candidates the sweep could ever drop are walked.
   */
  readonly track: (segments: Path, key: PathKey) => void
  /**
   * Register a cache's own eviction. It receives the canonical
   * `PathKey` of a path the form no longer has, and deletes whatever it
   * files under that path. A cache keying by more than the path (a
   * shape sigil, say) deletes every variant; a key it never held is a
   * no-op.
   */
  readonly onEvict: (evict: (key: PathKey) => void) => void
}

export function createDynamicPathSweep<F extends GenericForm>(
  state: FormStore<F, GenericForm>
): DynamicPathSweep {
  const dynamicKeys = new Set<PathKey>()
  const evictors: ((key: PathKey) => void)[] = []

  /**
   * A path no schema shape bounds: it traverses an array index or a
   * record / map key, so the set of such paths grows with what the
   * form has held rather than with what it declares. A path through
   * fixed object shapes alone is one of finitely many, and is never
   * swept, which also keeps an absent optional field from being
   * dropped and rebuilt on a loop.
   */
  const isDynamicPath = (segments: Path): boolean => {
    for (let i = 0; i < segments.length; i++) {
      if (typeof segments[i] === 'number') return true
      if (!state.schema.isFixedObjectAtPath(segments.slice(0, i))) return true
    }
    return false
  }

  // A Set iterator is live under mutation, so keys added mid-pass are
  // picked up and deleted ones skipped.
  let sweepCursor: Iterator<PathKey> | null = null

  // `onFormChange` hands the listener the next value, and `toRaw`
  // strips its reactive wrapper, so a write made from inside an effect
  // cannot subscribe that effect to every path this touches.
  state.onFormChange((next) => {
    if (dynamicKeys.size === 0) return
    const raw = toRaw(next)
    for (let i = 0; i < SWEEP_SLICE; i++) {
      sweepCursor ??= dynamicKeys.values()
      const step = sweepCursor.next()
      if (step.done === true) {
        // One full pass done; the next write starts a fresh one.
        sweepCursor = null
        break
      }
      const segments = segmentsForPathKey(step.value)
      if (segments !== null && hasAtPath(raw, segments)) continue
      dynamicKeys.delete(step.value)
      for (const evict of evictors) evict(step.value)
    }
  })

  return {
    track(segments, key) {
      // Already tracked: skip the schema walk. A path reaches here once
      // per cache that stores it, and only the first call has anything
      // to decide.
      if (dynamicKeys.has(key)) return
      if (isDynamicPath(segments)) dynamicKeys.add(key)
    },
    onEvict(evict) {
      evictors.push(evict)
    },
  }
}
