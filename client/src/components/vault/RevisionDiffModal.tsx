import { useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { ConfirmAction } from '../admin/ConfirmAction.js'
import { useRevision } from '../../hooks/useRevisions.js'
import { useNote } from '../../hooks/useNote.js'
import { computeLineDiff } from '../../lib/diff.js'
import { cn } from '../../lib/utils.js'
import type { Revision } from '../../api/revisions.js'

const stamp = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatStamp(iso?: string): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '—' : stamp.format(parsed)
}

const AUTHOR: Record<Revision['actorType'], string> = {
  user: 'by a person',
  collab: 'by a person, co-editing',
  mcp: 'by AI via MCP',
}

interface RevisionDiffModalProps {
  vaultId: string
  path: string
  revision: Revision | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRevert: (revisionId: string) => void
  revertPending?: boolean
}

export function RevisionDiffModal({
  vaultId,
  path,
  revision,
  open,
  onOpenChange,
  onRevert,
  revertPending = false,
}: RevisionDiffModalProps) {
  const revisionQuery = useRevision(open && revision ? vaultId : '', open && revision ? revision.id : null)
  const currentNoteQuery = useNote(open ? vaultId : '', open ? path : '')

  const currentBody = currentNoteQuery.data?.body ?? ''
  const revisionBody = revisionQuery.data?.body ?? ''

  const bodyDiff = useMemo(() => {
    if (!revisionQuery.data || !currentNoteQuery.data) return []
    return computeLineDiff(currentBody, revisionBody)
  }, [currentBody, revisionBody, revisionQuery.data, currentNoteQuery.data])

  const isIdenticalBody = useMemo(() => {
    return bodyDiff.length > 0 && bodyDiff.every((d) => d.type === 'same')
  }, [bodyDiff])

  const frontmatterDiff = useMemo(() => {
    if (!revisionQuery.data || !currentNoteQuery.data) return []
    const curFm = JSON.stringify(currentNoteQuery.data.frontmatter ?? {}, null, 2)
    const revFm = JSON.stringify(revisionQuery.data.frontmatter ?? {}, null, 2)
    if (curFm === revFm) return []
    return computeLineDiff(curFm, revFm)
  }, [revisionQuery.data, currentNoteQuery.data])

  const authorLabel = revision ? (AUTHOR[revision.actorType] ?? `by ${revision.actorType}`) : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Revision diff preview</DialogTitle>
          <DialogDescription>
            {revision
              ? `Comparing current note with revision from ${formatStamp(revision.createdAt)} (${authorLabel}).`
              : 'Compare note revisions.'}
          </DialogDescription>
        </DialogHeader>

        <FormError
          message={
            revisionQuery.error?.message ??
            currentNoteQuery.error?.message ??
            null
          }
        />

        {revisionQuery.isPending || currentNoteQuery.isPending ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading revision preview…
          </div>
        ) : (
          <div className="flex flex-col gap-4 overflow-y-auto max-h-[55vh] pr-1">
            {frontmatterDiff.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Frontmatter Changes
                </h3>
                <div className="rounded border border-border bg-muted/20 p-2 font-mono text-xs">
                  {frontmatterDiff.map((line, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        'flex items-start gap-2 px-1.5 py-0.5 whitespace-pre-wrap break-all',
                        line.type === 'add' && 'bg-primary/10 text-primary border-l-2 border-primary',
                        line.type === 'remove' && 'bg-destructive/10 text-destructive border-l-2 border-destructive',
                        line.type === 'same' && 'text-muted-foreground',
                      )}
                    >
                      <span className="w-3 select-none font-bold text-center">
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                      </span>
                      <span className="sr-only">
                        {line.type === 'add' ? 'Added: ' : line.type === 'remove' ? 'Removed: ' : ''}
                      </span>
                      <span className="flex-1">{line.text || ' '}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Note Content Diff
                </h3>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-destructive" /> Current lines to be removed
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-primary" /> Revision lines to be restored
                  </span>
                </div>
              </div>

              {bodyDiff.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">Note body is empty.</p>
              ) : isIdenticalBody ? (
                <p className="text-xs text-muted-foreground italic">
                  Note body is identical to the current version.
                </p>
              ) : (
                <div className="rounded border border-border bg-muted/20 p-2 font-mono text-xs">
                  {bodyDiff.map((line, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        'flex items-start gap-2 px-1.5 py-0.5 whitespace-pre-wrap break-all',
                        line.type === 'add' && 'bg-primary/10 text-primary border-l-2 border-primary',
                        line.type === 'remove' && 'bg-destructive/10 text-destructive border-l-2 border-destructive',
                        line.type === 'same' && 'text-muted-foreground',
                      )}
                    >
                      <span className="w-3 select-none font-bold text-center">
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                      </span>
                      <span className="sr-only">
                        {line.type === 'add' ? 'Added: ' : line.type === 'remove' ? 'Removed: ' : ''}
                      </span>
                      <span className="flex-1">{line.text || ' '}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-border mt-auto">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          {revision && (
            <ConfirmAction
              label="Revert to this version"
              ariaLabel={`Confirm revert to revision from ${formatStamp(revision.createdAt)}`}
              consequence="Reverting writes this revision's content back as a new revision attributed to you. Nothing is erased."
              pending={revertPending}
              onConfirm={() => {
                onRevert(revision.id)
                onOpenChange(false)
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
