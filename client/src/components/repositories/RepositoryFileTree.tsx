import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ChevronRight } from 'lucide-react'
import type { RepositoryFile } from '../../api/repositories.js'
import { cn } from '../../lib/utils.js'
import { ancestorFolders, buildFileTree, type FileTreeNode } from './fileTree.js'

interface RepositoryFileTreeProps {
  repositoryId: string
  files: readonly RepositoryFile[]
  /** Path of the open file; empty string when none is open. */
  activePath: string
}

/**
 * The context panel's directory tree, built from the index's flat paths
 * (`buildFileTree` — folders first, sorted). Folders collapse; the open
 * file's ancestors are held open so its row is always visible, and the row
 * itself carries `aria-current="page"`. Everything is a real button or link,
 * so it is keyboard reachable with nothing beyond Tab — Arrow right/left on a
 * folder additionally expand/collapse, the way every file explorer does.
 */
export function RepositoryFileTree({ repositoryId, files, activePath }: RepositoryFileTreeProps) {
  const tree = useMemo(() => buildFileTree(files), [files])
  // Top-level folders start open — a fully collapsed column reads as an empty
  // repository — and the open file's ancestors start open so its row shows.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set([
        ...tree.filter((n) => n.kind === 'folder').map((n) => n.path),
        ...ancestorFolders(activePath),
      ]),
  )

  // Navigating to a file inside a collapsed folder (⌘K, a deep link) must
  // reveal it. Adjusted during render, keyed on the previous path — React's
  // own pattern for state that follows a prop — so there is no effect flash.
  const [lastPath, setLastPath] = useState(activePath)
  if (activePath !== lastPath) {
    setLastPath(activePath)
    const missing = ancestorFolders(activePath).filter((a) => !expanded.has(a))
    if (missing.length > 0) setExpanded(new Set([...expanded, ...missing]))
  }

  function setOpen(path: string, open: boolean) {
    if (expanded.has(path) === open) return
    const next = new Set(expanded)
    if (open) next.add(path)
    else next.delete(path)
    setExpanded(next)
  }

  return (
    <ul className="flex flex-col gap-px">
      {tree.map((node) => (
        <TreeRow
          key={`${node.kind}:${node.path}`}
          node={node}
          depth={0}
          repositoryId={repositoryId}
          activePath={activePath}
          expanded={expanded}
          onSetOpen={setOpen}
        />
      ))}
    </ul>
  )
}

function TreeRow({
  node,
  depth,
  repositoryId,
  activePath,
  expanded,
  onSetOpen,
}: {
  node: FileTreeNode
  depth: number
  repositoryId: string
  activePath: string
  expanded: ReadonlySet<string>
  onSetOpen: (path: string, open: boolean) => void
}) {
  // Files skip the chevron's slot so names line up under their folder's name.
  const indent = { paddingLeft: `${8 + depth * 14 + (node.kind === 'file' ? 16 : 0)}px` }

  if (node.kind === 'file') {
    const active = node.path === activePath
    return (
      <li>
        <Link
          to={`/repos/${repositoryId}/files/${node.path}`}
          aria-current={active ? 'page' : undefined}
          // The full path: two `index.ts` rows in different folders must not
          // share one accessible name. It contains the visible text.
          aria-label={node.path}
          title={node.path}
          style={indent}
          className={cn(
            'flex items-center rounded-md py-1 pr-2 font-mono text-xs outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/40',
            active
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <span className="truncate">{node.name}</span>
        </Link>
      </li>
    )
  }

  const open = expanded.has(node.path)
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-label={node.path}
        title={node.path}
        style={indent}
        onClick={() => onSetOpen(node.path, !open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' && !open) {
            e.preventDefault()
            onSetOpen(node.path, true)
          } else if (e.key === 'ArrowLeft' && open) {
            e.preventDefault()
            onSetOpen(node.path, false)
          }
        }}
        className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left font-mono text-xs text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 text-faint transition-transform duration-100',
            open && 'rotate-90',
          )}
        />
        <span className="truncate">{node.name}</span>
      </button>
      {open && (
        <ul className="flex flex-col gap-px">
          {node.children.map((child) => (
            <TreeRow
              key={`${child.kind}:${child.path}`}
              node={child}
              depth={depth + 1}
              repositoryId={repositoryId}
              activePath={activePath}
              expanded={expanded}
              onSetOpen={onSetOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
