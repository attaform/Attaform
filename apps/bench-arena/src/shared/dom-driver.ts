import type { TriggerMode } from '../adapters/contract'
import { flush } from './clock'

/** Locate a rendered bare input by its stable index. */
function inputAt(container: HTMLElement, index: number): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`[data-bench-field="${index}"]`)
  if (!el) throw new Error(`bench: no input [data-bench-field="${index}"] mounted`)
  return el
}

/** Set the value and fire the native `input` event a real keystroke produces. */
export function domType(container: HTMLElement, index: number, value: string): void {
  const el = inputAt(container, index)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Fire the native `blur` event (the on-blur trigger pass). */
export function domBlur(container: HTMLElement, index: number): void {
  inputAt(container, index).dispatchEvent(new Event('blur', { bubbles: true }))
}

/**
 * The shared keystroke path every bare-input adapter reuses, so the DOM event
 * sequence is identical across the cohort: a keystroke is a value set plus a
 * native `input`, with an added `blur` when the trigger under test is on-blur.
 * It awaits the shared `flush()`, so the settle barrier is the same everywhere
 * and the driver simply times the awaited call.
 *
 * `typeChar` (measured) and `setFieldValue` (unmeasured warmup / seeding) take
 * the same path; only the driver's choice to time one and not the other
 * distinguishes them.
 */
export function domDriver(
  container: HTMLElement,
  trigger: TriggerMode
): {
  typeChar: (index: number, value: string) => Promise<void>
  setFieldValue: (index: number, value: string) => Promise<void>
} {
  const keystroke = async (index: number, value: string): Promise<void> => {
    domType(container, index, value)
    if (trigger === 'blur') domBlur(container, index)
    await flush()
  }
  return { typeChar: keystroke, setFieldValue: keystroke }
}
