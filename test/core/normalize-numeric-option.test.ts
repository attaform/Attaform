import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FIELD_VALIDATION_DEBOUNCE_MS,
  DEFAULT_HISTORY_MAX_SNAPSHOTS,
  DEFAULT_MAX_RECURSION_DEPTH,
  DEFAULT_PERSISTENCE_DEBOUNCE_MS,
  normalizeNumericOption,
} from '../../src/runtime/core/defaults'

/**
 * `normalizeNumericOption` is the shared sanitiser for every
 * consumer-supplied numeric option that reaches comparison gates
 * (`>=`, `>`) or `setTimeout` durations inside the runtime. Each
 * option's call site supplies:
 *
 *   - `min` — clamp floor for negatives (typically 0).
 *   - `defaultValue` — fall-back for invalid input.
 *   - `source` — the label the dev warning names.
 *
 * Every option it guards wants a finite value: `Infinity` stalls
 * timers, grows memory unboundedly, and defeats DoS protection. So
 * `±Infinity` falls back like any other invalid input rather than
 * carrying an opt-out meaning.
 *
 * These tests pin the contract centrally so each call-site test
 * only has to verify the call-site's policy choice, not the
 * sanitiser's behaviour.
 */
describe('normalizeNumericOption', () => {
  describe('valid inputs', () => {
    it('passes non-negative integers through unchanged', () => {
      const cfg = { source: 'x', min: 0, defaultValue: 64 }
      expect(normalizeNumericOption({ ...cfg, value: 0 })).toBe(0)
      expect(normalizeNumericOption({ ...cfg, value: 1 })).toBe(1)
      expect(normalizeNumericOption({ ...cfg, value: 64 })).toBe(64)
      expect(normalizeNumericOption({ ...cfg, value: 1024 })).toBe(1024)
    })

    it('floors non-integer positives', () => {
      const cfg = { source: 'x', min: 0, defaultValue: 64 }
      expect(normalizeNumericOption({ ...cfg, value: 5.7 })).toBe(5)
      expect(normalizeNumericOption({ ...cfg, value: 0.9 })).toBe(0)
      expect(normalizeNumericOption({ ...cfg, value: 64.999 })).toBe(64)
    })

    it('clamps negative finites to min', () => {
      const cfg = { source: 'x', defaultValue: 64 }
      expect(normalizeNumericOption({ ...cfg, value: -1, min: 0 })).toBe(0)
      expect(normalizeNumericOption({ ...cfg, value: -100, min: 0 })).toBe(0)
      expect(normalizeNumericOption({ ...cfg, value: -1, min: 5 })).toBe(5)
    })
  })

  describe('invalid inputs', () => {
    it('falls back to defaultValue for NaN and emits a dev warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const result = normalizeNumericOption({
          value: NaN,
          source: 'useForm.debounceMs',
          min: 0,
          defaultValue: 64,
        })
        expect(result).toBe(64)
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NaN'))
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('useForm.debounceMs'))
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('falls back to defaultValue for both infinities', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const cfg = { source: 'useForm.debounceMs', min: 0, defaultValue: 64 }
        expect(normalizeNumericOption({ ...cfg, value: Infinity })).toBe(64)
        expect(normalizeNumericOption({ ...cfg, value: -Infinity })).toBe(64)
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-negative finite integer'))
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('falls back to defaultValue for non-number values (defying TS)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const cfg = { source: 'x', min: 0, defaultValue: 64 }
        expect(normalizeNumericOption({ ...cfg, value: '64' as unknown as number })).toBe(64)
        expect(normalizeNumericOption({ ...cfg, value: null as unknown as number })).toBe(64)
        expect(normalizeNumericOption({ ...cfg, value: undefined as unknown as number })).toBe(64)
        expect(normalizeNumericOption({ ...cfg, value: {} as unknown as number })).toBe(64)
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  describe('source label appears in warnings', () => {
    it('uses the source label to identify the offending option', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        normalizeNumericOption({
          value: NaN,
          source: 'historyPlugin({ max })',
          min: 0,
          defaultValue: 50,
        })
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('historyPlugin({ max })'))
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  describe('library defaults snapshot', () => {
    // The defaults are referenced from each call site, so this just
    // pins the canonical values to make future tuning a single-file
    // change AND surface the snapshot in the test report.
    it('exposes the per-option defaults at well-known constants', () => {
      expect(DEFAULT_MAX_RECURSION_DEPTH).toBe(64)
      expect(DEFAULT_FIELD_VALIDATION_DEBOUNCE_MS).toBe(0)
      expect(DEFAULT_PERSISTENCE_DEBOUNCE_MS).toBe(300)
      expect(DEFAULT_HISTORY_MAX_SNAPSHOTS).toBe(128)
    })
  })
})
