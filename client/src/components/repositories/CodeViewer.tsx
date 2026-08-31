import { useImperativeHandle, type Ref } from 'react'
import { ExternalLink } from 'lucide-react'
import { EditorView } from '@codemirror/view'
import { gitHubFileUrl, type Repository, type RepositoryFile } from '../../api/repositories.js'
import { useRepositoryFile } from '../../hooks/useRepositories.js'
import { useCodeViewer } from '../../hooks/useCodeViewer.js'
import { Button } from '../ui/button.js'
import { PanelState } from '../ui/empty-state.js'
import { Pill } from '../ui/pill.js'

/**
 * Above this, the file is not handed to CodeMirror at all. The index stores
 * whatever ingestion read (gap 7 of the unit 7 plan), so a checked-in minified
 * bundle is not something to mount an editor over.
 *
 * Decided twice: before the request when the caller passed the file list's
 * metadata (`meta`, so an oversize file is never even downloaded), and after
 * it as the backstop for a caller that had no list to read a size from.
 */
export const MAX_INLINE_BYTES = 512 * 1024

/** Shared with the symbols panel: no outline beside a file that is not mounted. */
export function canShowInline(size: number): boolean {
  return size <= MAX_INLINE_BYTES
}

/** The one thing the inspector's outline may do to the viewer: move it. */
export interface CodeViewerHandle {
  /** Scrolls to and selects the given 1-based line; out of range is a no-op. */
  revealLine(line: number): void
}

interface CodeViewerProps {
  /** Only the fields the viewer needs — the route already holds the whole row. */
  repository: Pick<Repository, 'id' | 'ingestionMethod' | 'gitUrl' | 'defaultBranch'>
  path: string
  /**
   * The file's row from the list response, when the caller has one: the file
   * bar then shows language and size before the body arrives, and a file past
   * the byte cap is refused without being fetched.
   */
  meta?: Pick<RepositoryFile, 'language' | 'size'>
  ref?: Ref<CodeViewerHandle>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function CodeViewer({ repository, path, meta, ref }: CodeViewerProps) {
  // Known oversize from the list's metadata: don't download what will be
  // refused anyway. The query stays disabled (path null) in that case.
  const knownOversize = meta !== undefined && !canShowInline(meta.size)
  const file = useRepositoryFile(repository.id, knownOversize ? null : path)
  // Git-sourced only: a deep link serves neither `local_path` nor
  // `agent_push`, so the link is absent rather than present-and-disabled.
  const gitHubUrl = gitHubFileUrl(repository, path)

  // isError first, always: a failed read must never reach `.data` and render
  // as an empty file.
  const readable = !file.isError && file.data ? file.data : undefined
  const showable = readable && canShowInline(readable.size) ? readable : undefined
  const containerRef = useCodeViewer(showable?.content, path, showable?.language ?? null)

  useImperativeHandle(
    ref,
    () => ({
      revealLine(line: number) {
        const view = containerRef.current && EditorView.findFromDOM(containerRef.current)
        if (!view || line < 1 || line > view.state.doc.lines) return
        const pos = view.state.doc.line(line).from
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'start' }),
        })
      },
    }),
    [containerRef],
  )

  const language = showable?.language ?? meta?.language ?? null
  const size = readable?.size ?? meta?.size
  const oversizeBytes = knownOversize
    ? meta.size
    : readable && !canShowInline(readable.size)
      ? readable.size
      : undefined

  let body
  if (oversizeBytes !== undefined) {
    body = (
      <PanelState
        status="empty"
        title="Not shown inline"
        message={`This file is ${formatBytes(oversizeBytes)} — too large to show here. ${
          gitHubUrl ? 'Open it on GitHub instead.' : 'Open it in your own editor instead.'
        }`}
      />
    )
  } else if (file.isError) {
    body = <PanelState status="error" message={file.error.message} />
  } else if (file.isPending) {
    body = <PanelState status="loading" message="Loading this file…" />
  } else if (file.data.content === '') {
    body = <PanelState status="empty" message="This file is empty." />
  } else {
    body = <div ref={containerRef} className="h-full" />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* The 40px file bar: path, language, size, provenance — all machine
          text, all mono — and the one outward action there is. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate font-mono text-xs text-foreground" title={path}>
          {path}
        </span>
        {language && <Pill>{language}</Pill>}
        {size !== undefined && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {formatBytes(size)}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Permanent, not a mode: git stays the record of truth. */}
          <Pill title="Chapters never writes code back — git stays the record of truth.">
            Read-only
          </Pill>
          {gitHubUrl && (
            <Button asChild variant="ghost" size="xs">
              <a
                href={gitHubUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${path} on GitHub`}
              >
                Open on GitHub
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  )
}
