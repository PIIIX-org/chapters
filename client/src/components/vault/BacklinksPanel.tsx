import { Link } from 'react-router'
import { Eyebrow } from '../ui/eyebrow.js'
import { Pill } from '../ui/pill.js'
import { useBacklinks } from '../../hooks/useBacklinks.js'

interface BacklinksPanelProps {
  vaultId: string
  path: string
}

export function BacklinksPanel({ vaultId, path }: BacklinksPanelProps) {
  const backlinks = useBacklinks(vaultId, path)

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Eyebrow as="h3">Backlinks</Eyebrow>
        <p className="text-xs text-muted-foreground">
          Notes that link to this note via wikilinks.
        </p>
      </div>

      {backlinks.isPending ? (
        <p className="text-sm text-muted-foreground">Loading backlinks…</p>
      ) : backlinks.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {backlinks.error.message}
        </p>
      ) : backlinks.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No notes link here yet. Add a wikilink <code className="font-mono text-xs">[[{path}]]</code> in another note to connect them.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label="Incoming backlinks">
          {backlinks.data.map((item) => (
            <li key={item.id}>
              <Link
                to={`/vaults/${vaultId}/notes/${item.path}`}
                className="group flex flex-col gap-1 rounded-md border border-border bg-card p-2.5 transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                    {item.title || item.name}
                  </span>
                  <Pill tone="neutral" className="text-[10px] font-mono">
                    {item.type}
                  </Pill>
                </div>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {item.path}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
