// Vitest global setup: generate the docs-demos' gitignored `styles.css` once
// before the suite. The docs-demos smoke test imports each demo's App.vue,
// which `import './styles.css'` (composed at dev/build time from the shared
// fragment registry). On a fresh checkout that file does not exist yet, so the
// import would fail to resolve; generating here keeps the smoke suite honest
// without committing generated CSS.
import { generateAll } from '../apps/site/scripts/demo-styles/codegen.mjs'

export default function setup(): void {
  generateAll()
}
