// @vitest-environment jsdom
/**
 * Strict-mode write-trap consistency gate for PASS2-4.
 *
 * `form.fields` (container + leaf-view) and the `form.fields(path)`
 * call-terminal each had `set/delete: () => false`, which throws
 * `TypeError` under strict mode (every ESM module and `<script setup>`
 * block). The library documents "writes warn and noop" — the contract
 * `form.values` / `wizard.statuses` already honored. This gate pins the
 * three drifted proxies onto the same contract:
 *
 *   - **no throw** from `form.fields.X = …`, `delete form.fields.X`,
 *     `form.fields.email.value = …`, `form.fields('email').value = …`,
 *     `form.errors.tags[0] = …`, on either adapter.
 *   - **dev warn** fires once per call.
 *
 * Pre-fix the strict-mode `TypeError` rejects the `not.toThrow`
 * assertions and the warn never lands because the throw escapes first.
 * Post-fix both succeed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const schemaV4 = zV4.object({
  email: zV4.string(),
  tags: zV4.array(zV4.string()),
})
const schemaV3 = zV3.object({
  email: zV3.string(),
  tags: zV3.array(zV3.string()),
})

const adapters = [
  {
    name: 'v4',
    mount: makeMounter(useFormV4, schemaV4, { defaultValues: { email: '', tags: ['a', 'b'] } }),
  },
  {
    name: 'v3',
    mount: makeMounter(useFormV3, schemaV3, { defaultValues: { email: '', tags: ['a', 'b'] } }),
  },
] as const

describe.each(adapters)('proxy write traps — $name', ({ mount }) => {
  let warnings: string[]
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnings = []
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  // PASS2-4 — surface-proxy container path: `form.fields.X = …` / `delete form.fields.X`
  it('form.fields container set + delete do not throw and warn in dev', () => {
    const { api, app } = mount()
    expect(() => {
      ;(api.fields as Record<string, unknown>).tags = 'whatever'
    }).not.toThrow()
    expect(() => {
      delete (api.fields as Record<string, unknown>).tags
    }).not.toThrow()
    app.unmount()
    expect(warnings.some((w) => w.includes('read-only'))).toBe(true)
  })

  // PASS2-4 — leaf-view path: `form.fields.email.value = …` / `delete form.fields.email.value`
  it('form.fields.<leaf>.value assign + delete do not throw and warn in dev', () => {
    const { api, app } = mount()
    expect(() => {
      ;(api.fields.email as Record<string, unknown>).value = 'x'
    }).not.toThrow()
    expect(() => {
      delete (api.fields.email as Record<string, unknown>).value
    }).not.toThrow()
    app.unmount()
    expect(warnings.some((w) => w.includes('read-only'))).toBe(true)
  })

  // PASS2-4 — call-form terminal: `form.fields('email').value = …`
  it('form.fields(path) terminal assign + delete do not throw and warn in dev', () => {
    const { api, app } = mount()
    const terminal = api.fields('email') as Record<string, unknown>
    expect(() => {
      terminal.value = 'x'
    }).not.toThrow()
    expect(() => {
      delete terminal.value
    }).not.toThrow()
    app.unmount()
    expect(warnings.some((w) => w.includes('read-only'))).toBe(true)
  })

  // PASS2-4 — form.errors container path mirrors form.fields. The
  // errors surface goes through the same `containerProxyAt` factory
  // and inherits the fix automatically.
  it('form.errors container set + delete do not throw and warn in dev', () => {
    const { api, app } = mount()
    expect(() => {
      ;(api.errors as Record<string, unknown>).tags = []
    }).not.toThrow()
    expect(() => {
      delete (api.errors as Record<string, unknown>).tags
    }).not.toThrow()
    app.unmount()
    expect(warnings.some((w) => w.includes('read-only'))).toBe(true)
  })
})
