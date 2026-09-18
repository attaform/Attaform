/** Type surface for the comment-only gate, consumed by test/packaging/comment-only-gate.test.ts. */

/** One file's verdict when it could not be proven comment-only. */
export interface CommentOnlyReport {
  /** Files the diff touched, scannable or not. */
  changed: number
  /** Files the fingerprint and census actually ran on. */
  checked: number
  /** Paths no parser here understands, left for a human to read. */
  skipped: string[]
  /** One line per file that changed code or moved a directive count. */
  failures: string[]
}

/** Extensions the TypeScript parser can fingerprint. */
export declare const SCANNABLE: RegExp

/** Comment text that is not commentary, counted per file by {@link census}. */
export declare const DIRECTIVES: string[]

/**
 * The leaf-token stream of one TypeScript program, as a comparable string.
 * Identical across a comment edit; different across any token change,
 * including one inside a string or template literal.
 * @param fileName only steers the parser's diagnostics; any name parses.
 */
export declare function codeprint(text: string, fileName?: string): string

/**
 * The same, for a single-file component: each `<script>` block is printed
 * as its own program, and everything outside them is compared as text with
 * HTML comments stripped.
 */
export declare function vueprint(text: string, fileName?: string): string

/** {@link vueprint} for a `.vue` path, {@link codeprint} for anything else. */
export declare function fingerprint(fileName: string, text: string): string

/** Per-directive occurrence counts, as a comparable string. */
export declare function census(text: string): string

/** Compare every file the diff touched against `base`. */
export declare function checkCommentOnly(base: string): CommentOnlyReport
