import { useState } from 'react'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { ConfirmAction } from '../admin/ConfirmAction.js'
import { usePurgeRevision, useRevertNote, useRevisions } from '../../hooks/useRevisions.js'
import type { Revision } from '../../api/revisions.js'

const PAGE_SIZE = 25

const stamp = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatStamp(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : stamp.format(parsed)
}

/**
 * Authorship is what this list is for, and the design system's two accents say
 * it: vermillion (primary) = a person wrote this, teal (accent) = AI/MCP did.
 * Colour alone is not a signal anyone can hear, so each row says it in words
 * too — the colour only reinforces the text.
 */
/**
 * The authorship rule, and the whole reason this column exists: vermillion
 * (text-primary) means a person wrote it, teal (text-accent) means AI did.
 *
 * 'collab' is a person — it is the actor recorded for every save through the
 * realtime relay, which is how most edits arrive — so it is vermillion. There
 * is no 'system' actor; the pg enum is exactly these three, and a map missing
 * one crashes the whole panel rather than mislabelling one row.
 */
const AUTHOR: Record<Revision['actorType'], { label: string; className: string }> = {
  user: { label: 'by a person', className: 'text-primary' },
  collab: { label: 'by a person, co-editing', className: 'text-primary' },
  mcp: { label: 'by AI via MCP', className: 'text-accent' },
}

interface RevisionHistoryProps {
  vaultId: string
  path: string
  access: 'read' | 'edit' | 'owner'
}

export function RevisionHistory({ vaultId, path, access }: RevisionHistoryProps) {
  const [offset, setOffset] = useState(0)
  // The server requires edit for history (audit rule), so a read-only viewer
  // gets the reason instead of a 403 rendered as an error. Empty path keeps
  // the query disabled rather than firing a request that cannot succeed.
  const revisions = useRevisions(vaultId, access === 'read' ? '' : path, PAGE_SIZE, offset)
  const revert = useRevertNote(vaultId, path)
  const purge = usePurgeRevision(vaultId, path)

  if (access === 'read') {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="font-display text-base text-foreground">History</h3>
        <p className="text-sm text-muted-foreground">
          Read access shows you the note as it is now. Seeing who changed it, and when, needs edit access.
        </p>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base text-foreground">History</h3>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Newer revisions"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Newer
          </Button>
          {/* No total is served, so "there is more" is inferred the only way it
              can be: a full page means another may follow, a short one is last. */}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Older revisions"
            disabled={(revisions.data?.length ?? 0) < PAGE_SIZE}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Older
          </Button>
        </div>
      </div>

      <FormError message={revert.error?.message ?? purge.error?.message ?? null} />

      {revisions.isPending ? (
        <p className="text-sm text-muted-foreground">Loading history…</p>
      ) : revisions.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {revisions.error.message}
        </p>
      ) : revisions.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {offset === 0 ? 'No changes recorded for this note yet.' : 'Nothing on this page.'}
        </p>
      ) : (
        <ul className="flex flex-col">
          {revisions.data.map((revision) => (
            <li
              key={revision.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {formatStamp(revision.createdAt)}
              </span>
              <span className="text-sm text-foreground">{revision.action}</span>
              {/* Falls back rather than throwing: a new actor_type added
                  server-side should mislabel one row, never unmount the panel
                  the person is using to recover their work. */}
              <span
                className={`text-xs ${AUTHOR[revision.actorType]?.className ?? 'text-muted-foreground'}`}
              >
                {AUTHOR[revision.actorType]?.label ?? `by ${revision.actorType}`}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <ConfirmAction
                  label="Revert"
                  ariaLabel={`Revert to the version from ${formatStamp(revision.createdAt)}`}
                  consequence="Reverting writes that older content back as a new revision attributed to you. Nothing is erased — every version stays here, including the one showing now."
                  pending={revert.isPending}
                  onConfirm={() => revert.mutate(revision.id)}
                />
                {/* Owner only. The server also lets an instance admin through,
                    but the client cannot see that here, so it promises the one
                    thing it can actually check. */}
                {access === 'owner' && (
                  <ConfirmAction
                    label="Purge"
                    destructive
                    ariaLabel={`Purge the version from ${formatStamp(revision.createdAt)}`}
                    consequence="Purging deletes the recorded content of this revision permanently. It cannot be reverted to afterwards, and this cannot be undone."
                    pending={purge.isPending}
                    onConfirm={() => purge.mutate(revision.id)}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
