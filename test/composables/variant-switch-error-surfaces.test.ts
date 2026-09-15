// @vitest-environment jsdom
/**
 * Which error surface follows a discriminated-union switch.
 *
 * `docs/schemas/discriminated-unions.md` had these exactly backwards:
 * it said the per-leaf view filters by active variant while
 * `form.meta.errors` does not, and prescribed hand-filtering the
 * aggregate to work around stale entries. Measured, it is the other
 * way round, and the page's own worked snippet was the bug — a
 * `<small v-if="form.errors.notify.address?.[0]">` commented "only
 * renders when notify.channel === 'email'" renders an email error
 * beside the SMS input whenever a server error is parked there.
 *
 * The asymmetry is deliberate rather than accidental: a reshape drops
 * the outgoing variant's VALUES, and the schema errors derived from
 * them go with it, but an error the consumer set by hand lives in its
 * own store (#468) and Attaform does not get to decide it stopped
 * counting because a value moved.
 *
 * Pinned because the page now prescribes a rendering rule that depends
 * on both halves holding.
 */
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

/** Let the validation sweep that a reshape kicks off settle. */
async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await nextTick()
}

const ADAPTERS = [
  {
    name: 'zod v4',
    useForm: useFormV4,
    schema: () =>
      zV4.object({
        notify: zV4.discriminatedUnion('channel', [
          zV4.object({ channel: zV4.literal('email'), address: zV4.email() }),
          zV4.object({ channel: zV4.literal('sms'), phone: zV4.string().min(3, 'too short') }),
        ]),
      }),
  },
  {
    name: 'zod v3',
    useForm: useFormV3,
    schema: () =>
      zV3.object({
        notify: zV3.discriminatedUnion('channel', [
          zV3.object({ channel: zV3.literal('email'), address: zV3.string().email() }),
          zV3.object({ channel: zV3.literal('sms'), phone: zV3.string().min(3, 'too short') }),
        ]),
      }),
  },
] as const

describe.each(ADAPTERS)('error surfaces across a variant switch — $name', (adapter) => {
  it('drops the outgoing variant’s schema errors from the aggregate', async () => {
    const { api } = makeMounter(adapter.useForm, adapter.schema(), {})()
    api.setValue('notify.channel', 'sms')
    api.setValue('notify.phone', 'x')
    await settle()
    expect(api.errors().map((e: { message: string }) => e.message)).toContain('too short')

    api.setValue('notify.channel', 'email')
    await settle()

    const messages = api.errors().map((e: { message: string }) => e.message)
    expect(messages).not.toContain('too short')
    expect(api.meta.errors.map((e: { message: string }) => e.message)).not.toContain('too short')
  })

  it('keeps a hand-set error at its path, on both the leaf view and nowhere else', async () => {
    const { api } = makeMounter(adapter.useForm, adapter.schema(), {})()
    api.setValue('notify.channel', 'email')
    await settle()
    api.setErrors([{ message: 'address rejected upstream', path: ['notify', 'address'] }])
    await settle()

    api.setValue('notify.channel', 'sms')
    await settle()

    // The leaf view still reports it: this is what makes the
    // discriminator, not the error's presence, the right v-if guard.
    const leaf = api.errors.notify?.address as { message: string }[] | undefined
    expect(leaf?.map((e) => e.message)).toContain('address rejected upstream')

    // The aggregate has moved on with the variant.
    expect(api.errors().map((e: { message: string }) => e.message)).not.toContain(
      'address rejected upstream'
    )
  })
})
