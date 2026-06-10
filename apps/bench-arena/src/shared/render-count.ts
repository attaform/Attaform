/**
 * Per-field render counter shared by the bare-input field component.
 *
 * The harness mounts exactly one adapter per page load, so a module-global
 * counter never crosses library boundaries. The driver resets it, drives one
 * edit, settles, and reads how many field components re-rendered: the
 * render-scope signal. A granular library re-renders only the edited field
 * (total ~ 1); an O(F) library wakes every sibling (total ~ F).
 *
 * This counts ACTUAL render-function invocations (bumped in the render body),
 * not scheduler triggers, so coalesced updates are never double-counted.
 */
const counts = new Map<number, number>()

export function recordRender(index: number): void {
  counts.set(index, (counts.get(index) ?? 0) + 1)
}

export function resetRenderCounts(): void {
  counts.clear()
}

export function totalRenders(): number {
  let total = 0
  for (const n of counts.values()) total += n
  return total
}

export function renderCountFor(index: number): number {
  return counts.get(index) ?? 0
}
