import { EditorView } from '@codemirror/view'
import { gitHubFileUrl, type Repository } from '../../api/repositories.js'
import { useRepositoryFile } from '../../hooks/useRepositories.js'
import { useCodeViewer } from '../../hooks/useCodeViewer.js'
import { SymbolOutline } from './SymbolOutline.js'

/**
 * Above this, the file is not handed to CodeMirror at all. The index stores
 * whatever ingestion read (gap 7 of the unit 7 plan), so a checked-in minified
 * bundle is not something to mount an editor over.
 *
 * What this does NOT do is keep the bytes out of the tab: `size` is read off
 * the response, so the body has already been downloaded and parsed by the time
 * the cap is consulted. Deciding before the request needs the size from the
 * file-list metadata, which arrives with the tree that opens this viewer — and
 * that tree (and its route) is not built yet.
 *
 * ponytail: one flat byte cap, checked after the fetch. Move it to the tree's
 * metadata — `RepositoryFile.size` is already on the list response — as soon as
 * something other than a test renders this component.
 */
const MAX_INLINE_BYTES = 512 * 1024

interface CodeViewerProps {
  /** Only the fields the viewer needs — the route already holds the whole row. */
  repository: Pick<Repository, 'id' | 'ingestionMethod' | 'gitUrl' | 'defaultBranch'>
  path: string
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`
}

export function CodeViewer({ repository, path }: CodeViewerProps) {
  const file = useRepositoryFile(repository.id, path)
  // Git-sourced only: a deep link serves neither `local_path` nor
  // `agent_push`, so the button is absent rather than present-and-disabled.
  const gitHubUrl = gitHubFileUrl(repository, path)

  // isError first, always: a failed read must never reach `.data` and render
  // as an empty file.
  const readable = !file.isError && file.data ? file.data : undefined
  const showable = readable && readable.size <= MAX_INLINE_BYTES ? readable : undefined
  const containerRef = useCodeViewer(showable?.content, path, showable?.language ?? null)

  function revealLine(line: number) {
    const view = containerRef.current && EditorView.findFromDOM(containerRef.current)
    if (!view || line < 1 || line > view.state.doc.lines) return
    const pos = view.state.doc.line(line).from
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    })
  }

  let body
  if (file.isError) {
    body = (
      <p role="alert" className="p-4 text-sm text-destructive">
        {file.error.message}
      </p>
    )
  } else if (file.isPending) {
    body = <p className="p-4 text-sm text-muted-foreground">Loading this file…</p>
  } else if (file.data.size > MAX_INLINE_BYTES) {
    body = (
      <p className="p-4 text-sm text-muted-foreground">
        This file is {formatSize(file.data.size)} — too large to show here.{' '}
        {gitHubUrl ? 'Open it on GitHub instead.' : 'Open it in your own editor instead.'}
      </p>
    )
  } else if (file.data.content === '') {
    body = <p className="p-4 text-sm text-muted-foreground">This file is empty.</p>
  } else {
    body = <div ref={containerRef} className="h-full" />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
        <span className="font-mono text-xs text-foreground">{path}</span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Read-only — git stays the record of truth.
          </span>
          {gitHubUrl && (
            <a
              href={gitHubUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${path} on GitHub`}
              className="text-xs text-primary underline underline-offset-4"
            >
              Open on GitHub
            </a>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">{body}</div>
        {/* Only beside a file that is actually mounted: over the cap there is
            no editor for a symbol click to move, so the outline would be a
            jump list that jumps nowhere. */}
        {showable && (
          <aside className="w-56 shrink-0 overflow-auto border-l border-border p-3">
            <SymbolOutline symbols={showable.symbols} onSelect={revealLine} />
          </aside>
        )}
      </div>
    </div>
  )
}
