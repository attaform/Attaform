// @vitest-environment jsdom
/**
 * Standing invariant: a class instance parked in form storage is
 * carried through every mutation path, never rebuilt into a plain
 * object.
 *
 * Several runtime walkers rebuild a value key by key, and each one has
 * to decide what counts as descendable. The ones that answered with a
 * hand-written `instanceof` list (`Date` / `RegExp` / `Map` / `Set`)
 * silently destroyed everything the list did not name:
 * `Object.keys(new File(...))` is `[]`, because a File keeps its state
 * behind prototype accessors, so the rebuild produced `{}`. Two
 * walkers had that bug (`cloneVariantSnapshot` and `walkDuStubs`) and
 * two had it right (`structuralSnapshot` and `stripSymbolsDeep`, both
 * testing the prototype). Found via #542.
 *
 * This file exists because the correct guard is easy to forget when
 * the next walker is written, and because the failure is silent: the
 * value does not throw, it becomes an empty object several operations
 * later. The matrix is deliberately broad rather than aimed at the two
 * known sites, so a new walker that forgets the guard fails here.
 *
 * The subject is `File` rather than a bespoke class for a reason that
 * is itself pinned at the bottom of this file: Vue reactive-wraps a
 * plain class instance but not an exotic built-in, so `File` is the
 * case where strict identity is the honest assertion.
 */
import { describe, expect, it } from 'vitest'
import { markRaw, toRaw } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const mkFile = (name: string) => new File(['payload'], name, { type: 'text/plain' })

const ADAPTERS = [
  {
    name: 'zod v4',
    useForm: useFormV4,
    scalar: () => zV4.object({ doc: zV4.instanceof(File) }),
    nested: () => zV4.object({ wrap: zV4.object({ doc: zV4.instanceof(File), n: zV4.number() }) }),
    list: () => zV4.object({ docs: zV4.array(zV4.instanceof(File)) }),
    variant: () =>
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
    scalar: () => zV3.object({ doc: zV3.instanceof(File) }),
    nested: () => zV3.object({ wrap: zV3.object({ doc: zV3.instanceof(File), n: zV3.number() }) }),
    list: () => zV3.object({ docs: zV3.array(zV3.instanceof(File)) }),
    variant: () =>
      zV3.object({
        src: zV3.discriminatedUnion('kind', [
          zV3.object({ kind: zV3.literal('upload'), doc: zV3.instanceof(File) }),
          zV3.object({ kind: zV3.literal('link'), url: zV3.string() }),
        ]),
      }),
  },
] as const

describe.each(ADAPTERS)('class instances survive every write path — $name', (adapter) => {
  it('survives scalar writes, sibling writes, and the callback form', () => {
    const doc = mkFile('a.txt')
    const { api } = makeMounter(adapter.useForm, adapter.nested(), {
      defaultValues: { wrap: { doc: undefined, n: 1 } },
    })()

    api.setValue('wrap.doc', doc)
    expect(api.values.wrap?.doc).toBe(doc)

    // A write to a SIBLING key rebuilds the containing record. The
    // instance has to ride through untouched.
    api.setValue('wrap.n', 2)
    expect(api.values.wrap?.doc).toBe(doc)
    expect(api.values.wrap?.doc.name).toBe('a.txt')

    // The callback form snapshots `prev` before merging.
    api.setValue('wrap.n', (prev: unknown) => (prev as number) + 1)
    expect(api.values.wrap?.doc).toBe(doc)
  })

  it('survives every field-array operation', () => {
    const a = mkFile('a.txt')
    const b = mkFile('b.txt')
    const c = mkFile('c.txt')
    const { api } = makeMounter(adapter.useForm, adapter.list(), { defaultValues: { docs: [] } })()

    api.append('docs', a)
    api.prepend('docs', b)
    expect(api.values.docs).toEqual([b, a])

    api.swap('docs', 0, 1)
    expect(api.values.docs?.[0]).toBe(a)

    api.move('docs', 0, 1)
    expect(api.values.docs?.[1]).toBe(a)

    api.insert('docs', 1, c)
    expect(api.values.docs?.[1]).toBe(c)

    api.remove('docs', 0)
    expect(api.values.docs?.[0]).toBe(c)

    api.replace('docs', 0, b)
    expect(api.values.docs?.[0]).toBe(b)

    // The list view reads through to the same instances.
    expect(api.list('docs')[0]?.value).toBe(b)
  })

  it('survives reset, reset(next) and resetField', () => {
    const seeded = mkFile('seeded.txt')
    const next = mkFile('next.txt')
    const { api } = makeMounter(adapter.useForm, adapter.scalar(), {
      defaultValues: { doc: seeded },
    })()
    expect(api.values.doc).toBe(seeded)

    api.setValue('doc', next)
    api.reset()
    expect(api.values.doc).toBe(seeded)

    // `reset(next)` re-seats the durable defaults, so the new object is
    // what a later bare `reset()` restores.
    api.reset({ doc: next })
    expect(api.values.doc).toBe(next)

    api.setValue('doc', seeded)
    api.resetField('doc')
    expect(api.values.doc).toBe(next)
  })

  it('survives a discriminated-union round-trip', () => {
    // `rememberVariants` snapshots the outgoing variant and restores it
    // on the way back. Both the snapshot walker and the DU-stub walker
    // rebuild objects on that path, and both used to flatten the File.
    const doc = mkFile('kept.pdf')
    const { api } = makeMounter(adapter.useForm, adapter.variant(), {
      defaultValues: { src: { kind: 'upload', doc: undefined } },
    })()

    api.setValue('src.doc', doc)
    api.setValue('src.kind', 'link')
    api.setValue('src.kind', 'upload')

    expect(api.values.src?.doc).toBe(doc)
    expect(api.values.src?.doc).toBeInstanceOf(File)
    expect(api.values.src?.doc.name).toBe('kept.pdf')
  })

  it('hands the instance to handleSubmit by identity', async () => {
    const doc = mkFile('submitted.txt')
    const { api } = makeMounter(adapter.useForm, adapter.list(), {
      defaultValues: { docs: [] },
    })()
    api.append('docs', doc)

    let received: { docs: File[] } | undefined
    await api.handleSubmit((data: unknown) => {
      received = data as { docs: File[] }
    })()

    // The consumer hands this straight to FormData or an upload
    // pipeline, so a copy here would be as broken as a `{}`.
    expect(received?.docs[0]).toBe(doc)
  })
})

/**
 * Vue's reactivity, not Attaform's storage, decides whether a stored
 * instance is handed back as itself or as a proxy of itself. The rule
 * is `Object.prototype.toString` on the value: an exotic built-in
 * (`File`, `Blob`, `Date`, `URL`) reports its own tag and Vue declines
 * to wrap it, while a plain user-defined class reports `[object
 * Object]` and gets wrapped like any other object.
 *
 * Both keep the instance intact. The distinction is pinned because it
 * decides which assertion is honest above (strict identity for File),
 * and because the proxy has one sharp edge worth knowing about.
 */
describe('reactivity boundary for stored class instances', () => {
  class Plain {
    constructor(readonly id: string) {}
    describe(): string {
      return `plain:${this.id}`
    }
  }

  class Secret {
    #id: string
    constructor(id: string) {
      this.#id = id
    }
    reveal(): string {
      return this.#id
    }
  }

  it('hands an exotic built-in back by strict identity', () => {
    const doc = mkFile('exotic.txt')
    const { api } = makeMounter(useFormV4, zV4.object({ doc: zV4.instanceof(File) }), {})()
    api.setValue('doc', doc)
    expect(api.values.doc).toBe(doc)
  })

  it('wraps a plain class instance, keeping it intact behind the proxy', () => {
    const tok = new Plain('a')
    const { api } = makeMounter(useFormV4, zV4.object({ tok: zV4.instanceof(Plain) }), {})()
    api.setValue('tok', tok)

    const read = api.values.tok as Plain
    // Not the same object, but the same instance: the prototype chain
    // and every public member come through the proxy.
    expect(read).not.toBe(tok)
    expect(toRaw(read)).toBe(tok)
    expect(read).toBeInstanceOf(Plain)
    expect(read.describe()).toBe('plain:a')
  })

  it('markRaw opts a class instance out of wrapping entirely', () => {
    // The escape hatch for a class whose methods touch private fields:
    // `#id` is keyed to the instance, so calling through the proxy
    // throws `Cannot read private member`. This is a property of Vue
    // reactivity rather than of Attaform, and `markRaw` is its
    // documented answer. Pinned here so the guidance in
    // docs/schemas/contract.md stays true.
    const secret = markRaw(new Secret('shh'))
    const { api } = makeMounter(useFormV4, zV4.object({ s: zV4.instanceof(Secret) }), {})()
    api.setValue('s', secret)

    expect(api.values.s).toBe(secret)
    expect((api.values.s as Secret).reveal()).toBe('shh')
  })

  it('a private-field class throws through the proxy without markRaw', () => {
    // The counterweight: this is the failure `markRaw` avoids. Pinned
    // so the docs note keeps a reason to exist.
    const secret = new Secret('shh')
    const { api } = makeMounter(useFormV4, zV4.object({ s: zV4.instanceof(Secret) }), {})()
    api.setValue('s', secret)
    expect(() => (api.values.s as Secret).reveal()).toThrow(TypeError)
  })
})
