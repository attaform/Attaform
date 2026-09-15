import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { useAbstractForm as useForm } from '../../src/abstract'
import { createAttaform } from '../../src/runtime/core/plugin'
import { renderAttaformState } from '../../src/runtime/core/serialize'
import { fakeSchema } from '../utils/fake-schema'

/**
 * Two SSR pages publish a table of what survives the server → client
 * boundary, and a reader plans around it: a flag the table omits is a
 * flag they re-derive by hand on the client.
 *
 * Both tables drifted. `FieldRecord` gained `interacted` and
 * `blurredAfterInteraction` with the display-state work in #285, and the
 * per-field row still named five of the seven flags two majors later —
 * the same enumeration-drift shape as the auto-import manifest, the
 * `AbstractSchema` contract, `DisplayCtx`, and `FormStatus`. Nothing tied
 * the prose to the record.
 *
 * This is the tie, and it reads the shape off a real serialized payload
 * rather than off the type, so it holds whether the key is added to
 * `FieldRecord` or to what `renderAttaformState` chooses to send.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Pages carrying a per-field row, with a phrase unique to that row. */
const WIRE_TABLES: ReadonlyArray<{ file: string; anchor: string }> = [
  { file: 'docs/server-and-ssr/ssr-nuxt.md', anchor: 'whole per-path record' },
  { file: 'docs/server-and-ssr/ssr-bare-vue.md', anchor: 'whole per-path record' },
]

type Form = { email: string }

async function serializedFieldKeys(): Promise<string[]> {
  const App = defineComponent({
    setup() {
      const form = useForm<Form>({
        schema: fakeSchema<Form>({ email: '' }),
        key: 'signup',
      })
      return () => h('div', String(form.values.email))
    },
  })
  const app = createSSRApp(App)
  app.use(createAttaform({ ssr: true }))
  await renderToString(app)
  const entry = renderAttaformState(app).forms[0]?.[1]
  const record = entry?.fields[0]?.[1]
  expect(record, 'no field record made it into the payload').toBeTypeOf('object')
  // `path` is the record's own address, not a flag a reader tracks, so
  // it is the one key the prose is not expected to name.
  return Object.keys(record as object).filter((key) => key !== 'path')
}

describe('the per-field wire shape vs the prose that enumerates it', () => {
  it.each(WIRE_TABLES)('$file names every serialized flag', async ({ file, anchor }) => {
    const keys = await serializedFieldKeys()
    const rows = readFileSync(`${REPO_ROOT}${file}`, 'utf8')
      .split('\n')
      .filter((line) => line.includes(anchor))
    expect(rows, `no line in ${file} contains "${anchor}"`).toHaveLength(1)
    // Only the text AFTER the anchor: both pages label the row itself
    // `fields`, which is the surface, not one of the flags on it.
    const row = rows[0] ?? ''
    const listed = row.slice(row.indexOf(anchor) + anchor.length)
    const named = [...listed.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map((m) => m[1] ?? '')
    expect([...keys].sort()).toEqual([...new Set(named)].sort())
  })
})
