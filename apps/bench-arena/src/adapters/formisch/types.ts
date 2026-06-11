/**
 * The slice of a formisch field store the adapter binds. `input` is a reactive
 * getter whose setter writes the value AND runs the form's validation when the
 * form is in `'input'` mode, so a controlled `:value` binding drives formisch's
 * real per-keystroke valibot parse. `props.onBlur` is formisch's blur funnel,
 * used only on the blur-trigger pass.
 */
export interface FormischField {
  input: string
  readonly props: { onBlur(): void }
}
