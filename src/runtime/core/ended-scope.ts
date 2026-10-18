import { effectScope, getCurrentScope } from 'vue'

/**
 * Runs `build` in a scope of its own when the current one has already
 * ended, and returns `undefined` when it has not, so the caller builds in
 * place as usual.
 *
 * A `setup()` that resumes after an `await` once Vue has dropped its
 * component (a pending `<Suspense>` branch replaced before it resolved)
 * resumes inside that component's scope after it stopped. An effect started
 * there is never stopped, and an `onScopeDispose` callback parked there
 * never runs, so a composable called there would keep its registry entries,
 * its listeners and its subscriptions for the life of the app (#712). Its
 * own scope is stopped as soon as `build` returns: what it built still
 * works, and nothing it registered outlives the call.
 */
export function buildOutsideEndedScope<T>(build: () => T): T | undefined {
  if (getCurrentScope()?.active !== false) return undefined
  const own = effectScope(true)
  const built = own.run(build)
  own.stop()
  return built
}
