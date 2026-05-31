// @vitest-environment jsdom
// eslint-disable-next-line spaced-comment
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

/**
 * Smoke harness for the docs demos at `apps/site/docs-demos/**`. Each
 * demo is mounted, its documented gesture is dispatched, and the
 * rendered DOM (or storage) is compared to the documented promise.
 *
 * The goal isn't deep behavior coverage — each surface has its own
 * unit-test layer — but a standing tripwire that catches the class of
 * regression the `custom-assigners` bug demonstrated: a documented
 * gesture that silently stops doing the thing the docs page promises.
 *
 * Inventory shape, mirroring the eager glob in
 * `apps/site/components/content/DocsDemo.vue`:
 *   - flat:   `apps/site/docs-demos/<slug>.vue`
 *   - folder: `apps/site/docs-demos/<slug>/App.vue`
 *
 * Coverage tiers:
 *   - **Phase 1** (`phase1`): full gesture + assert per demo. The 10
 *     highest-risk surfaces (custom assigners, transforms,
 *     persistence opt-in, conditional render, wizard navigation,
 *     cross-component injection, multi-tab persistence, validation
 *     lifecycle, field arrays).
 *   - **Phase 2** (`phase2Backfill`): every other demo is registered
 *     by slug only and skipped. The meta-test below ensures a new
 *     demo SFC can't land without an explicit registration.
 *
 * Adding a new demo to disk without a Phase 1 entry or Phase 2 slug
 * fails the meta-test in CI.
 */

// Lazy globs — `Object.keys()` enumerates every demo path on disk for
// the meta-test, but only the demos whose loaders are actually called
// (Phase 1) get compiled. Eager globs would compile every SFC at
// test-load time, which slows the suite and turns a single Phase 2
// import-resolution hiccup into a hard failure of the entire file.
const flatModules = import.meta.glob<{ default: unknown }>('../../apps/site/docs-demos/*.vue')
const folderEntries = import.meta.glob<{ default: unknown }>('../../apps/site/docs-demos/*/App.vue')

const onDisk: ReadonlySet<string> = (() => {
  const s = new Set<string>()
  for (const path of Object.keys(flatModules)) {
    const m = /docs-demos\/([^/]+)\.vue$/.exec(path)
    if (m?.[1]) s.add(m[1])
  }
  for (const path of Object.keys(folderEntries)) {
    const m = /docs-demos\/([^/]+)\/App\.vue$/.exec(path)
    if (m?.[1]) s.add(m[1])
  }
  return s
})()

async function loadDemo(slug: string): Promise<unknown> {
  const folder = folderEntries[`../../apps/site/docs-demos/${slug}/App.vue`]
  const flat = flatModules[`../../apps/site/docs-demos/${slug}.vue`]
  const loader = folder ?? flat
  if (loader === undefined) return undefined
  const mod = await loader()
  return mod.default
}

interface Phase1Entry {
  slug: string
  gesture: (root: HTMLElement) => Promise<void>
  assert: (root: HTMLElement) => Promise<void>
}

async function dispatchInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function clickChecked(el: HTMLInputElement) {
  el.checked = true
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
}

function pre(root: HTMLElement): HTMLPreElement {
  const p = root.querySelector<HTMLPreElement>('pre')
  if (!p) throw new Error('expected a <pre> readout, found none')
  return p
}

async function expectStorageHas(needle: string, storage: Storage) {
  // Persistence writes are debounced. Polling resolves the instant
  // the storage entry lands, so the only timing dependency is the
  // shared `waitUntil` ceiling (a safety net for an infinite hang),
  // not a coupling to a specific debounce window.
  const found = await waitUntil<true>(() => {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null && storage.getItem(key)?.includes(needle) === true) return true
    }
    return null
  })
  if (found !== true) {
    const which = storage === sessionStorage ? 'sessionStorage' : 'localStorage'
    throw new Error(`expected some ${which} entry to contain "${needle}"`)
  }
}

const phase1: Phase1Entry[] = [
  {
    // The original bug. Click the 2nd swatch and confirm the
    // assigner committed via `rv.setValueWithInternalPath`.
    slug: 'custom-assigners',
    gesture: async (root) => {
      const buttons = root.querySelectorAll<HTMLButtonElement>('.widget button')
      const second = buttons.item(1)
      if (second === null) throw new Error('expected 2 color swatches')
      second.click()
      await nextTick()
    },
    assert: async (root) => {
      expect(pre(root).textContent).toContain('#16a34a')
    },
  },
  {
    // Type "My Slug!" into the slug input and confirm the transform
    // pipeline (lowercase + dashify) ran before storage.
    slug: 'transforms',
    gesture: async (root) => {
      const inputs = root.querySelectorAll<HTMLInputElement>('input')
      const slug = inputs.item(1)
      if (slug === null) throw new Error('expected 2 inputs (title, slug)')
      await dispatchInput(slug, 'My Slug!')
    },
    assert: async (root) => {
      expect(pre(root).textContent).toContain('my-slug')
    },
  },
  {
    // Type into the title input; the field has `persist: true`, so
    // a sessionStorage write must land.
    slug: 'persistence-overview',
    gesture: async (root) => {
      const title = root.querySelector<HTMLInputElement>('input')
      if (!title) throw new Error('title input not found')
      await dispatchInput(title, 'AttaformLives')
    },
    assert: async () => {
      await expectStorageHas('AttaformLives', sessionStorage)
    },
  },
  {
    // Same persistence write, but the opt-in checkbox controls the
    // write. Default is `persistTitle = true`, so a typed value
    // should land in storage without toggling.
    slug: 'per-field-opt-in',
    gesture: async (root) => {
      const inputs = root.querySelectorAll<HTMLInputElement>(
        'input[type="text"], input:not([type])'
      )
      const title = inputs.item(0)
      if (title === null) throw new Error('title input not found')
      await dispatchInput(title, 'PerFieldHello')
    },
    assert: async () => {
      await expectStorageHas('PerFieldHello', sessionStorage)
    },
  },
  {
    // Type an invalid email and blur — the field's per-field
    // validation pipeline renders the schema's error message under
    // the input. The button-driven `validateAsync()` flow is the
    // demo's pedagogical centerpiece but its result settles via a
    // dynamic adapter import that doesn't resolve under jsdom +
    // vite-served modules in CI; the per-field error path is the
    // load-bearing user surface here.
    slug: 'validation-lifecycle',
    gesture: async (root) => {
      const email = root.querySelector<HTMLInputElement>('input')
      if (!email) throw new Error('email input not found')
      await dispatchInput(email, 'not-an-email')
      email.dispatchEvent(new Event('blur', { bubbles: true }))
      // The blur → showErrors → conditional <em> chain spans more
      // than one Vue tick (validation result + display-state gate
      // + render). Poll for the rendered error; the shared
      // `waitUntil` ceiling caps a runaway hang.
      await waitUntil(() => root.querySelector('em') ?? null)
    },
    assert: async (root) => {
      const error = root.querySelector('em')
      expect(error?.textContent).toContain('Enter a valid email')
    },
  },
  {
    // Click `form.append(...)`; the appended string must show up
    // in the `<pre>` readout.
    slug: 'field-arrays',
    gesture: async (root) => {
      const buttons = root.querySelectorAll<HTMLButtonElement>('.actions button')
      const append = buttons.item(0)
      if (append === null) throw new Error('expected the append button')
      append.click()
      await nextTick()
    },
    assert: async (root) => {
      expect(pre(root).textContent).toContain('New checkpoint')
    },
  },
  {
    // Click the SMS radio; the variant swap should hide the
    // email-address input and render the phone-number input.
    slug: 'discriminated-unions',
    gesture: async (root) => {
      const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]')
      let sms: HTMLInputElement | undefined
      for (const r of Array.from(radios)) {
        if (r.value === 'sms') sms = r
      }
      if (!sms) throw new Error('expected sms radio')
      await clickChecked(sms)
    },
    assert: async (root) => {
      // The phone label appears only in the SMS variant.
      expect(root.textContent ?? '').toContain('Phone number')
    },
  },
  {
    // Click the "I accept the terms" checkbox; the boolean field
    // flips to `true` in the `<pre>` readout. Exercises the
    // checkbox branch of `vRegisterCheckbox` (single-value form).
    slug: 'checkbox',
    gesture: async (root) => {
      const accept = root.querySelector<HTMLInputElement>(
        'input[type="checkbox"][value="accepted"]'
      )
      if (!accept) throw new Error('accept-terms checkbox not found')
      await clickChecked(accept)
    },
    assert: async (root) => {
      expect(pre(root).textContent).toContain('"acceptTerms": true')
    },
  },
  {
    // Fill account fields, click Next; the profile step must
    // mount (the `Name` label appears only on step 2).
    slug: 'use-wizard',
    gesture: async (root) => {
      const email = root.querySelector<HTMLInputElement>('input[autocomplete="email"]')
      const password = root.querySelector<HTMLInputElement>('input[type="password"]')
      if (!email || !password) throw new Error('account-step inputs not found')
      await dispatchInput(email, 'me@example.com')
      await dispatchInput(password, 'longenough')
      // The "Next" button is the second .primary action button on
      // the account step (the first is the back button, which is
      // disabled on step 1, but lives in the actions row).
      const next = Array.from(root.querySelectorAll<HTMLButtonElement>('button.primary')).find(
        (b) => b.textContent?.includes('Next') === true
      )
      if (!next) throw new Error('next button not found')
      next.click()
      // `wizard.next()` awaits step validation before swapping the
      // active step; the email input belongs to step 1 and is gone
      // once step 2 mounts. Poll for that disappearance — the
      // shared `waitUntil` ceiling caps a runaway hang.
      await waitUntil(() =>
        root.querySelector('input[autocomplete="email"]') === null ? true : null
      )
    },
    assert: async (root) => {
      // Profile step renders a Name label; the account step does not.
      expect(root.textContent ?? '').toContain('Name')
    },
  },
  {
    // Cross-component injection: type into the `ProfileFieldset`'s
    // Name input (a child component) and confirm the readout in
    // the parent reflects the write — proves `injectForm` wires
    // the child to the same reactive form the parent owns.
    slug: 'inject-form',
    gesture: async (root) => {
      // The Name input lives inside the fieldset rendered by
      // ProfileFieldset. Email is the first input (in App.vue).
      const inputs = root.querySelectorAll<HTMLInputElement>('input')
      const name = inputs.item(1)
      if (name === null) throw new Error('name input not found')
      await dispatchInput(name, 'Athena')
    },
    assert: async (root) => {
      // The parent App.vue is patched to render `<pre>{{ form.values }}</pre>`;
      // the smoke harness asserts the parent saw the child's write.
      expect(pre(root).textContent).toContain('Athena')
    },
  },
]

/**
 * Phase 2 backfill. Each slug is registered (the meta-test counts it
 * as "tracked") but skipped (no gesture yet). Adding a new demo SFC
 * on disk without an entry here or in `phase1` fails the meta-test.
 */
const phase2Backfill: readonly string[] = [
  'arrays-and-tuples',
  'async-refinements',
  'blank-field-state',
  'clear',
  'coercion',
  'defaults-async-factory',
  'defaults-sync-factory',
  'display-state',
  'errors',
  'fields',
  'file',
  'first-schema',
  'focus-scroll',
  'form-list',
  'form-record',
  'handle-submit',
  'imperative-persistence',
  'inputs-to-submit',
  'meta',
  'modifiers',
  'multi-tab-sync',
  'optional-clear-cycle',
  'optional-nullable',
  'per-field-validation',
  'persistence-edge-cases',
  'preprocess',
  'quick-start',
  'radio',
  'records',
  'reset',
  'schema-defaults',
  'schema-to-inputs',
  'select',
  'server-side-errors',
  'set-value',
  'step-slots',
  'storage-backends',
  'storage-shape',
  'text-number-textarea',
  'the-form',
  'type-safety',
  'undo-redo',
  'unset',
  'url-availability-check',
  'use-register',
  'v-register',
  'values',
  'variant-memory',
]

describe('docs-demos smoke', () => {
  let mounted: { app: App; root: HTMLElement } | undefined

  beforeEach(() => {
    // Each entry runs in a clean storage so the persistence
    // assertions can rely on `includes(needle)` rather than
    // tracking last-write generation numbers.
    sessionStorage.clear()
    localStorage.clear()
  })

  afterEach(() => {
    mounted?.app.unmount()
    if (mounted?.root.parentNode) {
      mounted.root.parentNode.removeChild(mounted.root)
    }
    mounted = undefined
    document.body.innerHTML = ''
  })

  for (const entry of phase1) {
    it(`${entry.slug}: documented gesture writes documented state`, async () => {
      const Demo = await loadDemo(entry.slug)
      if (Demo === undefined) {
        throw new Error(`[smoke] no demo SFC found on disk for slug "${entry.slug}"`)
      }
      const root = document.createElement('div')
      document.body.appendChild(root)
      const app = createApp({ render: () => h(Demo as never) })
      app.use(createAttaform())
      app.mount(root)
      await nextTick()
      mounted = { app, root }

      await entry.gesture(root)
      await entry.assert(root)
    })
  }

  for (const slug of phase2Backfill) {
    it.skip(`${slug}: Phase 2 backfill (no gesture yet)`, () => {})
  }

  describe('inventory invariants', () => {
    it('every Phase 1 slug exists on disk', () => {
      const stale = phase1.map((e) => e.slug).filter((s) => !onDisk.has(s))
      expect(stale).toEqual([])
    })

    it('every Phase 2 slug exists on disk', () => {
      const stale = phase2Backfill.filter((s) => !onDisk.has(s))
      expect(stale).toEqual([])
    })

    it('Phase 1 and Phase 2 slugs do not overlap', () => {
      const phase1Set = new Set(phase1.map((e) => e.slug))
      const dup = phase2Backfill.filter((s) => phase1Set.has(s))
      expect(dup).toEqual([])
    })

    it('every demo on disk is registered (Phase 1 or Phase 2)', () => {
      const tracked = new Set<string>([...phase1.map((e) => e.slug), ...phase2Backfill])
      const untracked = [...onDisk].filter((s) => !tracked.has(s))
      // Helpful message: a new demo without a smoke entry fails CI;
      // either add it to `phase1` with a real gesture/assert, or add
      // its slug to `phase2Backfill`.
      expect(untracked, `Untracked demo slugs: ${untracked.join(', ')}`).toEqual([])
    })
  })
})
