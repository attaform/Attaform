// @vitest-environment jsdom
/**
 * Opaque leaves: `z.instanceof(X)`, `z.custom<T>()`, `z.unknown()`,
 * `z.any()` (#542).
 *
 * An opaque leaf is one the schema declares without describing its
 * shape. Nothing descends into it, so the adapter carries the value
 * verbatim and lets the predicate run at parse time. The reported
 * symptom was narrower than the defect: v4 rejected `custom` at
 * construction, which is the kind BOTH `z.instanceof(File)` and
 * `z.custom<T>()` compile to, while v3 compiles the same two spellings
 * to `ZodEffects` / `ZodAny` and never rejected them. A `File` has no
 * other spelling outside of v4's own `z.file()`, so a file-input field
 * was unmodellable on v4 and modellable on v3.
 *
 * Three separate defects had to fall for the reported use case to work,
 * and each one is pinned below:
 *
 *   1. the construction gate rejecting `custom` (v4 only);
 *   2. the slim-primitive write gate descending INTO a container
 *      written at an opaque leaf, checking `files.0` against a schema
 *      that never declared it, and no-oping the whole write with a
 *      "not in your schema" warning (both adapters, and live for
 *      `z.unknown()` / `z.any()` before this change);
 *   3. the variant-memory cloner rebuilding objects key by key, which
 *      turns a `File` into `{}` on a discriminated-union round-trip
 *      because a File's properties all live on its prototype (both
 *      adapters, and live for the already-supported `z.file()`).
 *
 * Every case runs against both zod majors. The v3 column is not
 * decoration: it is the parity control that made the v4 gate a bug
 * rather than a design choice.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const mkFile = (name = 'a.txt') => new File(['hello'], name, { type: 'text/plain' })

/**
 * `validate()` hands back a status ref that starts pending. Drain
 * microtasks plus Vue ticks until the parse settles.
 */
async function settle(status: { value: { pending: boolean } }) {
  for (let i = 0; i < 20 && status.value.pending; i++) {
    await Promise.resolve()
    await nextTick()
  }
  expect(status.value.pending).toBe(false)
  return status.value as { pending: boolean; success: boolean; errors?: { path: unknown[] }[] }
}

/** Capture `console.warn` for the length of `fn`. */
function withWarnings(fn: () => void): string[] {
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(' '))
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return warns
}

// Each adapter names its own spelling of the same three shapes. v3 has
// no `z.file()`, which is exactly why `z.instanceof(File)` has to work.
const ADAPTERS = [
  {
    name: 'zod v4',
    useForm: useFormV4,
    fileArray: () => zV4.object({ files: zV4.array(zV4.instanceof(File)).min(1, 'need one') }),
    fileScalar: () => zV4.object({ doc: zV4.instanceof(File) }),
    customScalar: () =>
      zV4.object({
        files: zV4.custom<File[]>((v) => Array.isArray(v) && v.length > 0, 'need one'),
      }),
    unknownScalar: () => zV4.object({ v: zV4.unknown() }),
    anyScalar: () => zV4.object({ v: zV4.any() }),
    fileVariant: () =>
      zV4.object({
        src: zV4.discriminatedUnion('kind', [
          zV4.object({ kind: zV4.literal('upload'), doc: zV4.instanceof(File) }),
          zV4.object({ kind: zV4.literal('link'), url: zV4.string() }),
        ]),
      }),
  },
  {
    name: 'zod v3',
    useForm: useFormV3,
    fileArray: () => zV3.object({ files: zV3.array(zV3.instanceof(File)).min(1, 'need one') }),
    fileScalar: () => zV3.object({ doc: zV3.instanceof(File) }),
    customScalar: () =>
      zV3.object({
        files: zV3.custom<File[]>((v) => Array.isArray(v) && v.length > 0, 'need one'),
      }),
    unknownScalar: () => zV3.object({ v: zV3.unknown() }),
    anyScalar: () => zV3.object({ v: zV3.any() }),
    fileVariant: () =>
      zV3.object({
        src: zV3.discriminatedUnion('kind', [
          zV3.object({ kind: zV3.literal('upload'), doc: zV3.instanceof(File) }),
          zV3.object({ kind: zV3.literal('link'), url: zV3.string() }),
        ]),
      }),
  },
] as const

describe.each(ADAPTERS)('opaque leaves — $name', (adapter) => {
  // ── 1. the construction gate ──────────────────────────────────────

  it('mounts a schema whose leaf is z.instanceof(File)', () => {
    expect(() => makeMounter(adapter.useForm, adapter.fileScalar(), {})()).not.toThrow()
  })

  it('mounts a schema whose leaf is z.custom<T>()', () => {
    expect(() => makeMounter(adapter.useForm, adapter.customScalar(), {})()).not.toThrow()
  })

  it('derives no blank for an opaque leaf, leaving the slot absent', () => {
    const { api } = makeMounter(adapter.useForm, adapter.fileScalar(), {})()
    // An opaque leaf has no derivable empty value. `null` would be a
    // guess that only holds when the predicate happens to describe a
    // File; `undefined` is the truthful answer and matches what
    // `z.unknown()` has always produced.
    expect(api.values.doc).toBeUndefined()
  })

  // ── 2. the value round-trip ───────────────────────────────────────

  it('carries a File through setValue without cloning or proxying it', () => {
    const { api } = makeMounter(adapter.useForm, adapter.fileScalar(), {})()
    const file = mkFile()
    api.setValue('doc', file)
    const read = api.values.doc as File
    // Identity, not just equality: the consumer hands this straight to
    // FormData or an upload pipeline, so a clone or a reactive proxy
    // would break it. A Proxy would also throw on the internal-slot
    // getters below.
    expect(read).toBe(file)
    expect(read).toBeInstanceOf(File)
    expect(read.name).toBe('a.txt')
    expect(read.size).toBe(5)
  })

  it('validates a container of opaque elements at both levels', async () => {
    const { api } = makeMounter(adapter.useForm, adapter.fileArray(), {
      defaultValues: { files: [] },
      strict: true,
    })()

    // Container-level refinement fires at the container's own path.
    const empty = await settle(api.validate())
    expect(empty.success).toBe(false)
    expect(api.errors('files')[0]?.message).toBe('need one')

    // A satisfied container parses clean.
    api.setValue('files', [mkFile()])
    expect((await settle(api.validate())).success).toBe(true)
    expect(api.errors('files')).toEqual([])

    // Element-level predicate fires at the ELEMENT's path, not the
    // container's. This is what proves the opaque predicate actually
    // runs rather than being skipped as un-introspectable.
    api.setValue('files', ['not-a-file'])
    const bad = await settle(api.validate())
    expect(bad.success).toBe(false)
    expect(api.errors('files.0')).toHaveLength(1)
  })

  // ── 3. the write gate must not fabricate sub-paths ────────────────

  it.each([
    ['z.custom<File[]>()', 'customScalar', 'files'],
    ['z.unknown()', 'unknownScalar', 'v'],
    ['z.any()', 'anyScalar', 'v'],
  ] as const)('writes an array into a %s leaf', (_label, key, path) => {
    const schema = adapter[key]()
    const { api } = makeMounter(adapter.useForm, schema, { defaultValues: { [path]: [] } })()
    const file = mkFile()

    // The gate used to accept the array at `files`, then descend and
    // check `files.0` against a schema that declares no such path. The
    // empty accept set there reads as "this path is not in your
    // schema", and the whole write no-oped.
    const warns = withWarnings(() => api.setValue(path, [file]))

    expect(api.values[path]).toHaveLength(1)
    expect((api.values[path] as File[])[0]).toBe(file)
    expect(warns).toEqual([])
  })

  it('writes an object into an opaque leaf', () => {
    const schema = adapter.unknownScalar()
    const { api } = makeMounter(adapter.useForm, schema, { defaultValues: { v: {} } })()
    const warns = withWarnings(() => api.setValue('v', { a: 1, nested: { b: 2 } }))
    expect(api.values.v).toEqual({ a: 1, nested: { b: 2 } })
    expect(warns).toEqual([])
  })

  it('still rejects a write to a path the schema genuinely lacks', () => {
    // The counterweight. Opening the gate at opaque leaves must not
    // open it at typos, or the diagnostic that catches
    // `register('addr.zipp')` stops firing.
    const schema = adapter.fileScalar()
    const { api } = makeMounter(adapter.useForm, schema, {})()
    const warns = withWarnings(() => api.setValue('docc' as 'doc', mkFile()))
    expect(warns.join('\n')).toContain('not in your schema')
  })

  // ── 4. the variant-memory cloner ──────────────────────────────────

  it('preserves a File across a discriminated-union round-trip', () => {
    const { api } = makeMounter(adapter.useForm, adapter.fileVariant(), {
      defaultValues: { src: { kind: 'upload', doc: undefined } },
    })()
    const doc = mkFile('doc.pdf')
    api.setValue('src.doc', doc)
    expect(api.values.src?.doc).toBe(doc)

    // `rememberVariants` defaults to true, so leaving and returning
    // restores the outgoing snapshot. The cloner rebuilt plain objects
    // key by key; a File's properties all live on File.prototype, so
    // `Object.keys(file)` is empty and the snapshot came back as `{}`.
    api.setValue('src.kind', 'link')
    api.setValue('src.kind', 'upload')

    expect(api.values.src?.doc).toBe(doc)
    expect(api.values.src?.doc).toBeInstanceOf(File)
    expect((api.values.src?.doc as File).name).toBe('doc.pdf')
  })

  it('still deep-clones plain objects in a variant snapshot', () => {
    // The counterweight to passing class instances by reference: a
    // plain object must stay detached from the live reactive tree, or
    // a later write into the restored variant would mutate the
    // snapshot it was restored from.
    const schema =
      adapter.name === 'zod v4'
        ? zV4.object({
            src: zV4.discriminatedUnion('kind', [
              zV4.object({ kind: zV4.literal('a'), bag: zV4.object({ n: zV4.number() }) }),
              zV4.object({ kind: zV4.literal('b'), url: zV4.string() }),
            ]),
          })
        : zV3.object({
            src: zV3.discriminatedUnion('kind', [
              zV3.object({ kind: zV3.literal('a'), bag: zV3.object({ n: zV3.number() }) }),
              zV3.object({ kind: zV3.literal('b'), url: zV3.string() }),
            ]),
          })
    const { api } = makeMounter(adapter.useForm, schema, {
      defaultValues: { src: { kind: 'a', bag: { n: 1 } } },
    })()
    const seated = api.values.src?.bag
    api.setValue('src.bag.n', 2)
    api.setValue('src.kind', 'b')
    api.setValue('src.kind', 'a')
    expect(api.values.src?.bag).toEqual({ n: 2 })
    // Detached: the restored object is a copy, not the live node that
    // was in the tree before the switch.
    expect(api.values.src?.bag).not.toBe(seated)
  })
})
