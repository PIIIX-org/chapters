import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'

// Fires inside an unclosed `[[…` (any chars that aren't `]`), suggesting note
// paths; applying a completion inserts `path]]` to close the link.
export function wikilinkCompletions(targets: string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const open = context.matchBefore(/\[\[[^\]]*/)
    if (!open) return null
    return {
      from: open.from + 2,
      options: targets.map((path) => ({ label: path, type: 'link', apply: `${path}]]` })),
    }
  }
}
