import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { useForm as useFormV4 } from '../../src/zod-v4'
import type { DisplayState, FieldState } from '../../src'

/**
 * Type-level pin for the `form.fields(path)` CALL form at a container.
 *
 * The two spellings resolve to the same runtime proxy, so they must
 * carry the same type:
 *
 *   form.fields('members.0')        // string call-form
 *   form.fields(['members', 0])     // tuple call-form
 *
 * The tuple overload used to return the drillable child map
 * (`{ name: FieldState, email: FieldState }`), which was unsound: at a
 * container the call form hands back that path's rolled-up FieldState
 * and exposes NO children, so `form.fields(['members', 0]).email`
 * type-checked and then read `undefined` at runtime. Worse, the
 * container's own state (`displayState`, `valid`, ...) was untypeable
 * through the tuple form, which is the spelling you are forced into
 * when the index comes from a `v-for`.
 *
 * Drilling into a container is dot/bracket access
 * (`form.fields.members[i].email`), not the call form.
 *
 * Tests run at typecheck time; `_neverInvoked` exercises inference
 * without mounting a Vue app.
 */

const schema = z.object({
  team: z.string(),
  members: z.array(z.object({ name: z.string(), email: z.string() })),
  profile: z.object({ nickname: z.string() }),
})

describe('form.fields() call form at a container', () => {
  it('tuple and string spellings agree at an array row', () => {
    function _neverInvoked() {
      const form = useFormV4({ schema })
      const i: number = 0

      expectTypeOf(form.fields(['members', i])).toEqualTypeOf(form.fields('members.0'))
    }
    void _neverInvoked
  })

  it('exposes the container rollup through the tuple form', () => {
    function _neverInvoked() {
      const form = useFormV4({ schema })
      const i: number = 0

      // The regression this file exists to catch: a `v-for` index forces
      // the tuple spelling, and the row badge needs `displayState`.
      expectTypeOf(form.fields(['members', i]).displayState).toEqualTypeOf<DisplayState>()
      expectTypeOf(form.fields(['members', i]).valid).toEqualTypeOf<boolean>()
      expectTypeOf(form.fields(['members', i]).showErrors).toEqualTypeOf<boolean>()
    }
    void _neverInvoked
  })

  it('agrees at a static object container too', () => {
    function _neverInvoked() {
      const form = useFormV4({ schema })
      expectTypeOf(form.fields(['profile'])).toEqualTypeOf(form.fields('profile'))
      expectTypeOf(form.fields(['profile']).displayState).toEqualTypeOf<DisplayState>()
    }
    void _neverInvoked
  })

  it('still resolves a leaf to its value-typed FieldState', () => {
    function _neverInvoked() {
      const form = useFormV4({ schema })
      const i: number = 0

      expectTypeOf(form.fields(['team'])).toEqualTypeOf<FieldState<string>>()
      expectTypeOf(form.fields(['members', i, 'email'])).toEqualTypeOf<FieldState<string>>()
      expectTypeOf(form.fields(['members', i, 'email']).value).toEqualTypeOf<string>()
    }
    void _neverInvoked
  })

  it('keeps dot/bracket access as the way to descend', () => {
    function _neverInvoked() {
      const form = useFormV4({ schema })
      const i: number = 0
      // Drilling is the proxy's job, not the call form's.
      expectTypeOf(form.fields.members[i]?.email.value).toEqualTypeOf<string | undefined>()
    }
    void _neverInvoked
  })
})
