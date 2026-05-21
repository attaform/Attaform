import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { buildWizardStatusesProxy } from '../../src/runtime/core/wizard-statuses-proxy'
import type { FormStatus } from '../../src/runtime/types/types-wizard'

/**
 * `buildWizardStatusesProxy(statusMap)` mirrors `form.values`'
 * call-or-read pattern at one level of depth.
 *
 *   wizard.statuses.cargo          // FormStatus (readable)
 *   wizard.statuses('cargo')       // FormStatus (callable single-key)
 *   wizard.statuses()              // Record<key, FormStatus> (callable no-arg)
 *
 * Reactivity contract: each per-key entry is a `ComputedRef<FormStatus>`,
 * unwrapped by the proxy at read time so consumers don't deal with
 * `.value`. Writes are blocked.
 */

const pending: FormStatus = {
  valid: false,
  dirty: false,
  submitted: false,
  errorCount: 0,
}

function makeProxy<K extends string>(map: Record<K, FormStatus>) {
  type StatusMap = { readonly [P in K]: FormStatus }
  const sources = Object.fromEntries(
    Object.entries(map).map(([key, value]) => [key, ref(value as FormStatus)])
  ) as Record<K, ReturnType<typeof ref<FormStatus>>>
  const computeds = Object.fromEntries(
    Object.entries(sources).map(([key, source]) => [
      key,
      computed(() => (source as ReturnType<typeof ref<FormStatus>>).value),
    ])
  ) as Record<K, ReturnType<typeof computed<FormStatus>>>
  const proxy = buildWizardStatusesProxy<StatusMap>(computeds)
  return { proxy, sources }
}

describe('buildWizardStatusesProxy', () => {
  it('exposes per-key entries via property access', () => {
    const { proxy } = makeProxy({
      a: { valid: true, dirty: false, submitted: false, errorCount: 0 },
      b: { valid: false, dirty: true, submitted: false, errorCount: 2 },
    })
    expect(proxy.a.valid).toBe(true)
    expect(proxy.b.errorCount).toBe(2)
  })

  it('returns a single entry via callable form', () => {
    const { proxy } = makeProxy({
      cargo: { valid: true, dirty: false, submitted: false, errorCount: 0 },
    })
    const status = proxy('cargo') as FormStatus
    expect(status.valid).toBe(true)
  })

  it('returns the full record via no-arg callable form', () => {
    const { proxy } = makeProxy({
      a: pending,
      b: { valid: true, dirty: false, submitted: false, errorCount: 0 },
    })
    const all = proxy() as Record<string, FormStatus>
    expect(all['a']).toMatchObject(pending)
    const b = all['b'] as FormStatus
    expect(b.valid).toBe(true)
  })

  it('reflects reactive updates from the underlying computeds', () => {
    const { proxy, sources } = makeProxy({ a: pending })
    expect(proxy.a.valid).toBe(false)
    const aSource = sources.a as ReturnType<typeof ref<FormStatus>>
    aSource.value = { valid: true, dirty: true, submitted: true, errorCount: 0 }
    expect(proxy.a.valid).toBe(true)
    expect(proxy.a.dirty).toBe(true)
  })

  it('returns undefined for an unknown key in property access', () => {
    const { proxy } = makeProxy({ a: pending })
    expect((proxy as unknown as Record<string, unknown>)['unknown']).toBeUndefined()
  })

  it('returns undefined when called with an unknown key', () => {
    const { proxy } = makeProxy({ a: pending })
    const fn = proxy as unknown as (
      key?: string
    ) => FormStatus | Record<string, FormStatus> | undefined
    expect(fn('unknown')).toBeUndefined()
  })

  it('blocks writes with a dev-only warning', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { proxy } = makeProxy({ a: pending })
    try {
      ;(proxy as unknown as { a: FormStatus }).a = pending
    } catch {
      // strict-mode environments may throw — fine either way
    }
    warnSpy.mockRestore()
    expect(warnings.some((w) => w.includes('read-only'))).toBe(true)
  })

  it('serializes via toJSON to the current record snapshot', () => {
    const { proxy } = makeProxy({
      a: { valid: true, dirty: false, submitted: false, errorCount: 0 },
    })
    const serialized = JSON.parse(JSON.stringify(proxy))
    expect(serialized.a.valid).toBe(true)
  })
})
