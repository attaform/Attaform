/**
 * Bundled-types guard for opaque leaves through the published artifact.
 *
 * `z.instanceof(X)` and `z.custom<T>()` both compile to kind `custom`,
 * which the v4 adapter rejected at construction until #542. The
 * in-repo suite pins the runtime behaviour against `src`; this fixture
 * pins the TYPE side against the bundled `.d.ts`, where the leaf has
 * to survive `z.input<Schema>` and the path-union walk with no
 * structural information to go on.
 *
 * A `File` leaf is the case that matters most: it is the reason the
 * construction gate was a bug rather than a design choice, and it is
 * the shape a consumer reaches for first.
 */
import { z } from 'zod'
import { useForm } from 'attaform/zod'
import type { ArrayItem, ArrayPath } from 'attaform'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

class Token {
  constructor(readonly id: string) {}
  describe(): string {
    return `token:${this.id}`
  }
}

const schema = z.object({
  avatar: z.instanceof(File).nullable(),
  attachments: z.array(z.instanceof(File)),
  bag: z.custom<Record<string, string>>((v) => typeof v === 'object'),
  token: z.instanceof(Token),
  anything: z.unknown(),
  native: z.file().nullable(),
})

const form = useForm({
  schema,
  defaultValues: { avatar: null, attachments: [], native: null },
})

// The leaf types survive the walk rather than collapsing to unknown.
export type AvatarIsFile = Expect<Equal<typeof form.values.avatar, File | null>>
export type BagKeepsItsType = Expect<Equal<typeof form.values.bag, Record<string, string>>>

// A user-defined class arrives structurally expanded rather than under
// its nominal name, so `Equal` against `Token` is false while the two
// stay mutually assignable. What matters to a consumer is that every
// member survives the expansion, methods included: reading a stored
// instance and calling into it has to typecheck.
const roundTripped: Token = form.values.token
const backAgain: typeof form.values.token = new Token('t')
export type TokenMethodSurvives = Expect<Equal<ReturnType<typeof roundTripped.describe>, string>>
void backAgain
export type NativeFileLeaf = Expect<Equal<typeof form.values.native, File | null>>

// An array of opaque elements is still a field-array path, and its
// element type is the opaque leaf rather than `never`.
export type AttachmentsIsArrayPath = Expect<
  Equal<Extract<ArrayPath<z.input<typeof schema>>, 'attachments'>, 'attachments'>
>
export type AttachmentItemIsFile = Expect<
  Equal<ArrayItem<z.input<typeof schema>, 'attachments'>, File>
>

// Writes through the public surface accept the opaque value.
form.setValue('avatar', new File(['x'], 'a.txt'))
form.setValue('avatar', null)
form.setValue('token', new Token('t'))
form.append('attachments', new File(['x'], 'b.txt'))

// An opaque leaf exposes no sub-paths: nothing descends into it, so
// `avatar.name` is not a writable path even though a File has a
// `name` property.
// @ts-expect-error `avatar` is a leaf, not a container
form.setValue('avatar.name', 'nope')

// The wrong value type at a typed opaque leaf is still rejected.
// @ts-expect-error a string is not a File
form.setValue('avatar', 'not-a-file')
