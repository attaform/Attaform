// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, createApp, type App } from 'vue'
import { z } from 'zod'

import { useForm } from '../../src/zod'

/**
 * Cross-tab snapshot handshake MUST adopt the leader's live state on
 * join, even when the leader's current form value is mid-edit and
 * fails schema validation.
 *
 * The use case: two tabs share a form key. Tab A is being typed into;
 * Tab B refreshes mid-edit. When Tab B's `useForm` re-mounts, its
 * sync module posts `hello`, picks Tab A as leader, requests a
 * `snapshot`, and SHOULD adopt the value Tab A is currently holding,
 * including any value that would currently fail schema parse (a
 * half-typed email, a min-length string still under the threshold,
 * etc.). The receiving tab's own validation cycle surfaces those
 * errors locally on the next interaction.
 *
 * The current `handleSnapshot` implementation gates the apply on
 * `validateForm(msg.form)` and drops the snapshot when validation
 * throws. Since every peer holding shared state holds the SAME
 * invalid value, the joiner runs through every leader candidate,
 * drops them all, and falls back to solo mode with empty defaults.
 * This file pins the contract that this is wrong: snapshots carry
 * live state, not "valid state".
 */

const schema = z.object({
  email: z.email(),
  comment: z.string(),
})

type SyncForm = {
  readonly values: { readonly email: string; readonly comment: string }
  setValue: (path: string, value: unknown) => boolean
}

const ORIGINAL_IS_SECURE_CONTEXT = window.isSecureContext
const mountedApps: App[] = []
const mountedHosts: HTMLElement[] = []

beforeEach(() => {
  // Multi-tab sync gates on `window.isSecureContext`. jsdom defaults
  // it to `false`; treat the test environment as localhost-equivalent.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
})

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount()
  for (const host of mountedHosts.splice(0)) host.remove()
  Object.defineProperty(window, 'isSecureContext', {
    value: ORIGINAL_IS_SECURE_CONTEXT,
    configurable: true,
  })
})

function mountBareApp(setup: () => unknown): App {
  const Probe = defineComponent({ setup, render: () => h('div') })
  const app = createApp(Probe)
  const host = document.createElement('div')
  app.mount(host)
  mountedApps.push(app)
  mountedHosts.push(host)
  return app
}

async function waitForEstablished(apps: ReadonlyArray<App>, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const allEstablished = apps.every((app) => {
      const registry = app._attaform
      if (registry === undefined) return false
      for (const state of registry.forms.values()) {
        const mod = state.modules.get('multiTabSync') as
          | { lifecycle: () => 'joining' | 'established' }
          | undefined
        if (mod === undefined) return false
        if (mod.lifecycle() !== 'established') return false
      }
      return true
    })
    if (allEstablished) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Multi-tab sync did not reach 'established' in ${timeoutMs}ms`)
}

describe('multi-tab sync: opt-in default', () => {
  it('no sync module instantiates when multiTab is unset (library default off)', async () => {
    const captureA: { form?: SyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema,
        key: 'multitab-default-off-solo',
        // NOTE: no `multiTab: true` — assert the library default is off.
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    if (captureA.form === undefined) throw new Error('setup did not capture formA')

    // Allow any potential lazy-init window to elapse.
    await new Promise((r) => setTimeout(r, 100))

    const registry = appA._attaform
    if (registry === undefined) throw new Error('app has no attaform registry')
    let syncModule: unknown
    for (const [key, state] of registry.forms) {
      if (key !== 'multitab-default-off-solo') continue
      syncModule = state.modules.get('multiTabSync')
    }
    expect(syncModule).toBeUndefined()
  })

  it('two tabs sharing a key but not opting in do NOT exchange patches', async () => {
    const captureA: { form?: SyncForm } = {}
    const captureB: { form?: SyncForm } = {}
    mountBareApp(() => {
      captureA.form = useForm({
        schema,
        key: 'multitab-default-off-pair',
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    mountBareApp(() => {
      captureB.form = useForm({
        schema,
        key: 'multitab-default-off-pair',
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formA = captureA.form
    const formB = captureB.form
    if (formA === undefined || formB === undefined) throw new Error('setup did not capture form')

    formA.setValue('email', 'alice@example.com')
    await new Promise((r) => setTimeout(r, 100))

    // No multiTab on either form, so Tab A's write stays local.
    expect(formA.values.email).toBe('alice@example.com')
    expect(formB.values.email).toBe('')
  })
})

describe('multi-tab sync: snapshot handshake adopts live state on join', () => {
  it('joiner inherits leader VALID value (control case: handshake works for valid state)', async () => {
    // Positive control: when the leader's form parses cleanly, the
    // snapshot handshake currently does work. Keeps the suite from
    // regressing the happy path if the fix to the invalid case
    // accidentally breaks it.
    const captureA: { form?: SyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema,
        key: 'multitab-snapshot-valid',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formA = captureA.form
    if (formA === undefined) throw new Error('setup did not capture formA')
    await waitForEstablished([appA])

    formA.setValue('email', 'alice@example.com')
    expect(formA.values.email).toBe('alice@example.com')

    const captureB: { form?: SyncForm } = {}
    const appB = mountBareApp(() => {
      captureB.form = useForm({
        schema,
        key: 'multitab-snapshot-valid',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formB = captureB.form
    if (formB === undefined) throw new Error('setup did not capture formB')
    await waitForEstablished([appA, appB])

    expect(formB.values.email).toBe('alice@example.com')
  })

  it('joiner inherits leader MID-EDIT invalid value (currently failing, this is the bug)', async () => {
    // Tab A mounts solo with empty defaults; user starts typing an
    // email but only gets partway ("sdf" fails z.email() parse).
    const captureA: { form?: SyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema,
        key: 'multitab-snapshot-invalid',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formA = captureA.form
    if (formA === undefined) throw new Error('setup did not capture formA')
    await waitForEstablished([appA])

    formA.setValue('email', 'sdf')
    expect(formA.values.email).toBe('sdf')

    // Tab B mounts fresh (simulates a refresh in the second tab).
    const captureB: { form?: SyncForm } = {}
    const appB = mountBareApp(() => {
      captureB.form = useForm({
        schema,
        key: 'multitab-snapshot-invalid',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formB = captureB.form
    if (formB === undefined) throw new Error('setup did not capture formB')
    await waitForEstablished([appA, appB])

    // The contract: Tab B's snapshot handshake should have pulled the
    // current state from Tab A, including the mid-edit invalid value.
    // Currently this assertion fails because `handleSnapshot` rejects
    // any snapshot whose form fails schema validation; Tab B falls
    // back to solo mode with the empty default.
    expect(formB.values.email).toBe('sdf')
  })

  it('joiner inherits leader value even when a non-leaf field is invalid', async () => {
    // Variant: only one of several fields is invalid. The whole-form
    // validate gate currently rejects the snapshot even though the
    // joiner could have adopted every other field without issue.
    const captureA: { form?: SyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema,
        key: 'multitab-snapshot-partial-invalid',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formA = captureA.form
    if (formA === undefined) throw new Error('setup did not capture formA')
    await waitForEstablished([appA])

    formA.setValue('email', 'sdf') // invalid
    formA.setValue('comment', 'looks good') // valid

    const captureB: { form?: SyncForm } = {}
    const appB = mountBareApp(() => {
      captureB.form = useForm({
        schema,
        key: 'multitab-snapshot-partial-invalid',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formB = captureB.form
    if (formB === undefined) throw new Error('setup did not capture formB')
    await waitForEstablished([appA, appB])

    // Both fields should land on Tab B, not just the valid one.
    expect(formB.values.email).toBe('sdf')
    expect(formB.values.comment).toBe('looks good')
  })
})

/**
 * Companion suite: malicious or otherwise wrong-typed inbound traffic.
 *
 * Once the snapshot path stopped gating on deep schema validation
 * (test suite above), an in-progress invalid string like `"sdf"` for
 * an email field now flows through. The slim-shape contract still
 * applies though: a peer sending a NUMBER where the schema expects a
 * STRING is structural garbage, not a mid-edit value, and the
 * receiver must reject it. These tests pin that contract from both
 * the `patches` (established lifecycle) and `snapshot` (joining
 * lifecycle) directions, using a raw `BroadcastChannel` to
 * impersonate a hostile peer.
 */

function getChannelName(app: App, formKey: string): string {
  const registry = app._attaform
  if (registry === undefined) throw new Error('app has no attached attaform registry')
  for (const [key, state] of registry.forms) {
    if (key !== formKey) continue
    const mod = state.modules.get('multiTabSync') as { channelName: string } | undefined
    if (mod !== undefined) return mod.channelName
  }
  throw new Error(`no sync module found for key '${formKey}'`)
}

/**
 * `File` (and `Blob`) values must NEVER traverse the cross-tab channel.
 * The threat model is concrete:
 *
 *   - User picks a sensitive file (passport, tax doc, ID) in Tab A.
 *   - A second tab is open on the same origin: shared computer, family
 *     member, coworker browsing nearby, forgotten popup, or a script
 *     that opened a hidden sibling via XSS / window.open.
 *   - User closes Tab A thinking "I never submitted, it's gone."
 *   - Second tab silently captured the File via multi-tab sync.
 *
 * Strings and primitives are also user data but their volume is
 * bounded; File blobs are a different category of disclosure (an MB-
 * sized passport scan, not a half-typed comment). Default-deny is
 * the only safe stance. A dev who genuinely needs cross-tab file
 * sharing can serialise to a string (base64, blob URL, etc.) at a
 * different field and accept the explicit trade-off.
 *
 * The tests assert the gate at the channel layer via a
 * `BroadcastChannel.postMessage` interceptor — Node's `structuredClone`
 * has incomplete `File` support, so a behavioural test (set File on
 * A, check value on B) wouldn't reliably fail on the bug. The
 * interceptor catches the outbound traffic regardless of whether the
 * clone would have succeeded downstream.
 */
const fileSchema = z.object({
  avatar: z.file().nullable(),
  caption: z.string(),
})

type FileSyncForm = {
  readonly values: { readonly avatar: File | null | undefined; readonly caption: string }
  setValue: (path: string, value: unknown) => boolean
}

type CapturedMessage = { readonly channelName: string; readonly msg: Record<string, unknown> }

function containsFileLikeValue(value: unknown): boolean {
  if (typeof File !== 'undefined' && value instanceof File) return true
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsFileLikeValue)
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (containsFileLikeValue(v)) return true
  }
  return false
}

describe('multi-tab sync: File values stay local (security gate)', () => {
  let captured: CapturedMessage[] = []
  let originalPostMessage: typeof BroadcastChannel.prototype.postMessage

  beforeEach(() => {
    captured = []
    originalPostMessage = BroadcastChannel.prototype.postMessage
    BroadcastChannel.prototype.postMessage = function (this: BroadcastChannel, msg: unknown) {
      if (msg !== null && typeof msg === 'object') {
        captured.push({ channelName: this.name, msg: msg as Record<string, unknown> })
      }
      return originalPostMessage.call(this, msg)
    }
  })

  afterEach(() => {
    BroadcastChannel.prototype.postMessage = originalPostMessage
  })

  it('outbound patches strip File values before reaching the channel', async () => {
    const captureA: { form?: FileSyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema: fileSchema,
        key: 'multitab-file-patches',
        multiTab: true,
        defaultValues: { avatar: null, caption: '' },
      }) as unknown as FileSyncForm
    })
    const formA = captureA.form
    if (formA === undefined) throw new Error('setup did not capture formA')
    await waitForEstablished([appA])

    const file = new File(['secret passport bytes'], 'passport.png', { type: 'image/png' })
    formA.setValue('avatar', file)
    formA.setValue('caption', 'attached')
    await new Promise((r) => setTimeout(r, 50))

    // Every patches message that reached the channel must be File-clean.
    const patchMessages = captured.filter((c) => c.msg['kind'] === 'patches')
    expect(patchMessages.length).toBeGreaterThan(0) // caption patch DID broadcast
    for (const { msg } of patchMessages) {
      const formPatches = msg['formPatches'] as ReadonlyArray<{ readonly value?: unknown }>
      for (const p of formPatches) {
        if ('value' in p) expect(containsFileLikeValue(p.value)).toBe(false)
      }
    }
  })

  it('outbound snapshot strips File values from the form payload', async () => {
    const captureA: { form?: FileSyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema: fileSchema,
        key: 'multitab-file-snapshot',
        multiTab: true,
        defaultValues: { avatar: null, caption: '' },
      }) as unknown as FileSyncForm
    })
    const formA = captureA.form
    if (formA === undefined) throw new Error('setup did not capture formA')
    await waitForEstablished([appA])

    const file = new File(['secret passport bytes'], 'passport.png', { type: 'image/png' })
    formA.setValue('avatar', file)
    formA.setValue('caption', 'attached')

    // Mounting a second tab triggers the snapshot handshake.
    const captureB: { form?: FileSyncForm } = {}
    const appB = mountBareApp(() => {
      captureB.form = useForm({
        schema: fileSchema,
        key: 'multitab-file-snapshot',
        multiTab: true,
        defaultValues: { avatar: null, caption: '' },
      }) as unknown as FileSyncForm
    })
    if (captureB.form === undefined) throw new Error('setup did not capture formB')
    await waitForEstablished([appA, appB])

    const snapshotMessages = captured.filter((c) => c.msg['kind'] === 'snapshot')
    expect(snapshotMessages.length).toBeGreaterThan(0)
    for (const { msg } of snapshotMessages) {
      expect(containsFileLikeValue(msg['form'])).toBe(false)
    }
  })

  it('inbound patch carrying a File value is rejected (defense in depth)', async () => {
    // Even with outbound stripping in place, a hostile peer could
    // fabricate a patches message containing a File. The receiver
    // must drop it.
    const captureA: { form?: FileSyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema: fileSchema,
        key: 'multitab-file-inbound',
        multiTab: true,
        defaultValues: { avatar: null, caption: '' },
      }) as unknown as FileSyncForm
    })
    const formA = captureA.form
    if (formA === undefined) throw new Error('setup did not capture formA')
    await waitForEstablished([appA])

    const channelName = getChannelName(appA, 'multitab-file-inbound')
    const evil = new BroadcastChannel(channelName)
    const file = new File(['hostile bytes'], 'evil.png', { type: 'image/png' })
    try {
      evil.postMessage({
        v: 1,
        kind: 'patches',
        senderId: 'evil-sender',
        formPatches: [{ op: 'replace', path: ['avatar'], value: file }],
        blankPathsAdded: [],
        blankPathsRemoved: [],
      })
      await new Promise((r) => setTimeout(r, 100))
    } finally {
      evil.close()
    }

    expect(formA.values.avatar).not.toBeInstanceOf(File)
  })
})

describe('multi-tab sync: structural type-mismatch defense', () => {
  it('established tab rejects a patch that would replace a string field with a number', async () => {
    const captureA: { form?: SyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema,
        key: 'multitab-bad-type-patch',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formA = captureA.form
    if (formA === undefined) throw new Error('setup did not capture formA')
    await waitForEstablished([appA])

    // Put formA in an in-progress invalid state. Without this, the
    // existing handlePatches schema-validate rollback already catches
    // the bad type because pre-state is valid. The slim-shape
    // contract has to hold REGARDLESS of pre-state validity.
    formA.setValue('email', 'still typing')
    expect(formA.values.email).toBe('still typing')

    const channelName = getChannelName(appA, 'multitab-bad-type-patch')
    const evil = new BroadcastChannel(channelName)
    try {
      evil.postMessage({
        v: 1,
        kind: 'patches',
        senderId: 'evil-tab',
        formPatches: [{ op: 'replace', path: ['email'], value: 12345 }],
        blankPathsAdded: [],
        blankPathsRemoved: [],
      })
      // Give the channel time to deliver and the receiver time to apply.
      await new Promise((r) => setTimeout(r, 100))
    } finally {
      evil.close()
    }

    expect(typeof formA.values.email).toBe('string')
    expect(formA.values.email).toBe('still typing')
  })

  it('joining tab rejects a snapshot that places a number into a string field', async () => {
    // Joining tab needs at least one announced peer to pick a leader
    // and request a snapshot from. We use the evil channel itself to
    // play that role: it sees the joiner's hello, announces, receives
    // the requestSnapshot, and replies with a structurally hostile
    // snapshot.
    const channelName = (() => {
      // Run a probe app just to compute the channelName the joiner
      // will use, then unmount it so the joiner is the only "real"
      // participant. We can't use _attaform.forms keys here because
      // computing the channel name requires the schema fingerprint
      // which the runtime hashes internally.
      const captureProbe: { form?: SyncForm } = {}
      const appProbe = mountBareApp(() => {
        captureProbe.form = useForm({
          schema,
          key: 'multitab-bad-type-snapshot',
          multiTab: true,
          defaultValues: { email: '', comment: '' },
        }) as unknown as SyncForm
      })
      const name = getChannelName(appProbe, 'multitab-bad-type-snapshot')
      appProbe.unmount()
      return name
    })()

    const evilSenderId = 'evil-sender'
    const evil = new BroadcastChannel(channelName)
    let requestSeen = false
    evil.onmessage = (event: MessageEvent): void => {
      const data = event.data as
        | { v: number; kind: string; senderId: string; targetId?: string }
        | undefined
      if (data === undefined) return
      if (data.kind === 'hello') {
        evil.postMessage({ v: 1, kind: 'announce', senderId: evilSenderId })
        return
      }
      if (data.kind === 'requestSnapshot' && data.targetId === evilSenderId) {
        requestSeen = true
        evil.postMessage({
          v: 1,
          kind: 'snapshot',
          senderId: evilSenderId,
          form: { email: 12345, comment: 'safe' },
          blankPaths: [],
        })
        return
      }
    }

    const captureB: { form?: SyncForm } = {}
    const appB = mountBareApp(() => {
      captureB.form = useForm({
        schema,
        key: 'multitab-bad-type-snapshot',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formB = captureB.form
    if (formB === undefined) throw new Error('setup did not capture formB')

    try {
      await waitForEstablished([appB])
    } finally {
      evil.close()
    }

    // The hostile snapshot got delivered (requestSeen) but should not
    // have applied. formB's email stays a string at the configured
    // default; if the slim-shape check fired, the joiner falls back
    // to solo mode without adopting the bad shape.
    expect(requestSeen).toBe(true)
    expect(typeof formB.values.email).toBe('string')
    expect(formB.values.email).toBe('')
  })
})

describe('multi-tab sync: hostile-message no-uncaught guard (SEC-3)', () => {
  // The inbound shape-check recursion is already bounded by the schema
  // walker's maxRecursionDepth (a pathologically deep snapshot is
  // dropped, not walked to the bottom). The reachable risk is a THROW
  // escaping the message handler: isValidSyncMessage only checks that
  // the blank-path fields are arrays, not their element types, so a
  // hostile `patches` carrying `blankPathsAdded: [null]` reaches
  // `canonicalizePath(null)` (Array.from(null) → TypeError) and the
  // exception escapes the uncaught onmessage handler into the app.
  it('an established tab survives a malformed hostile patches message', async () => {
    const uncaught: unknown[] = []
    const onProcessError = (err: unknown): void => {
      uncaught.push(err)
    }
    const onWindowError = (event: Event): void => {
      uncaught.push(event)
    }
    process.on('uncaughtException', onProcessError)
    process.on('unhandledRejection', onProcessError)
    window.addEventListener('error', onWindowError)

    const captureA: { form?: SyncForm } = {}
    const appA = mountBareApp(() => {
      captureA.form = useForm({
        schema,
        key: 'multitab-hostile-msg',
        multiTab: true,
        defaultValues: { email: '', comment: '' },
      }) as unknown as SyncForm
    })
    const formA = captureA.form
    if (formA === undefined) throw new Error('setup did not capture formA')

    const channelName = getChannelName(appA, 'multitab-hostile-msg')
    const evil = new BroadcastChannel(channelName)
    try {
      await waitForEstablished([appA])
      evil.postMessage({
        v: 1,
        kind: 'patches',
        senderId: 'evil-malformed',
        formPatches: [],
        // Non-string element: passes the array-shape check, then trips
        // canonicalizePath(null) deep inside handlePatches.
        blankPathsAdded: [null],
        blankPathsRemoved: [],
      })
      await new Promise((r) => setTimeout(r, 100))
    } finally {
      evil.close()
      process.off('uncaughtException', onProcessError)
      process.off('unhandledRejection', onProcessError)
      window.removeEventListener('error', onWindowError)
    }

    // No exception escaped into the app, and the form is intact.
    expect(uncaught).toEqual([])
    expect(formA.values.email).toBe('')
  })
})
