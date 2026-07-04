# Validation

Attaform validates against the form's own Zod schema and drives the display signals from it. The schema is the contract; design it deliberately.

## Client is UX, server is truth

The client schema is a **UX gate only**. A direct request bypasses it entirely, so the server must validate every input independently. Client validation exists to give fast inline feedback, not to protect the backend. Write the schema for the person filling the form; never lean on it as a security boundary.

## Keep closed sets in sync

Where a field is a closed set on both sides (a country, a size band, a status), derive the client `z.enum` from the same option list the control renders, and mirror the server's set. The client should reject _exactly_ what the server would, never stricter on a value the server accepts. A drift between the two shows up as a form that blocks a submit the backend would have taken.

## Reflect server truth, not optimism

On a successful mutation, reset the form from the returned resource or re-read a server-truth source, rather than trusting the values you submitted. A success message should sit on server-confirmed state, not on the optimistic input. This keeps the form honest when the server normalizes, defaults, or rejects part of what you sent.

## A clearable edit field is a required string

A field the user must be able to **clear** should be a required, possibly-empty string, not `.optional()`:

```ts
const schema = z.object({
  // Wrong for a clearable edit field: a cleared value drops from the payload,
  // and a partial-update backend reads the omission as "unchanged".
  // nickname: z.string().optional(),

  // Right: an empty string still transmits, so the clear reaches the server.
  nickname: z.string(),
})
```

A cleared `.optional()` field drops out of the payload, and a partial-update backend that treats an absent key as "leave unchanged" silently ignores the clear. Use `z.string()` (allowed empty) so the cleared value is sent and the update takes.

## Move real requirements into the schema

If a field's only guard was a disabled submit button, that requirement is not enforced once you stop disabling the button (which you should, see the core rules). Put the requirement in the schema (`.min(1)`, `.refine(...)`) so `handleSubmit` actually fails on it and focuses the field. A field left as a bare `z.string()` or `z.boolean()` accepts empty or `false`, which is often not what an "acknowledge" checkbox or a required text field means.

## The display signals

The per-field `showErrors` / `showSuccess` / `showPending` signals already encode a reward-early, punish-late display policy: an error is revealed once the user has engaged with the field, success is shown when earned, and the async pending state is anti-flash timed. Read those signals; do not rebuild the visibility heuristic from raw `errors` and `touched`.
