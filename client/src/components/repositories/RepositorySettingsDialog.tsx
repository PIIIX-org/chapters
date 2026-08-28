import { useState } from 'react'
import type { FormEvent } from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Button } from '../ui/button.js'
import { ConfirmAction } from '../admin/ConfirmAction.js'
import { FormError } from '../FormError.js'
import { RepositoryShareList } from './RepositoryShareList.js'
import { SyncTokenList } from './SyncTokenList.js'
import {
  useDeleteRepository,
  useRepositoryGraphPreference,
  useSetRepositoryGraphPreference,
  useUpdateRepository,
} from '../../hooks/useRepositories.js'
import type { AccessibleRepository } from '../../api/repositories.js'

const switchClassName =
  'relative h-5 w-9 shrink-0 rounded-full border border-border bg-muted transition-colors data-[state=checked]:bg-foreground disabled:opacity-50'
const thumbClassName =
  'block h-4 w-4 translate-x-0.5 rounded-full bg-card transition-transform data-[state=checked]:translate-x-[18px]'

interface RepositorySettingsDialogProps {
  repository: AccessibleRepository
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after the repository is gone — the viewer route it was open over no longer resolves. */
  onDeleted?: () => void
}

/**
 * Everything an owner can change about a connection, in one modal over
 * whatever is already on screen — the shape unit 2 gave vault settings, and
 * the reason there is no `/repos` index page to hang a settings tab off.
 *
 * Owner-only by construction: every call behind these controls is
 * `requireOwner` server side, so the caller renders this for an owner and a
 * viewer never sees a disabled version of someone else's controls.
 *
 * ponytail: no effect resyncing local state from `repository` — the caller
 * mounts this only while open, so every open starts from the current server
 * value.
 */
export function RepositorySettingsDialog({
  repository,
  open,
  onOpenChange,
  onDeleted,
}: RepositorySettingsDialogProps) {
  const [name, setName] = useState(repository.name)
  const [nameError, setNameError] = useState<string | null>(null)
  const [mergeable, setMergeable] = useState(repository.mergeable)
  const [mergeableError, setMergeableError] = useState<string | null>(null)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const updateRepository = useUpdateRepository(repository.id)
  const deleteRepository = useDeleteRepository()
  const graphPreference = useRepositoryGraphPreference(repository.id)
  const setGraphPreference = useSetRepositoryGraphPreference(repository.id)

  function handleRename(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || trimmed === repository.name) return
    setNameError(null)
    updateRepository.mutate(
      { name: trimmed },
      { onError: (err) => setNameError(err.message || 'Could not rename this repository.') },
    )
  }

  function handleMergeable(next: boolean) {
    setMergeable(next)
    setMergeableError(null)
    updateRepository.mutate(
      { mergeable: next },
      {
        onError: (err) => {
          // Roll back: this must never sit "on" after a failed write.
          setMergeable(!next)
          setMergeableError(err.message || 'Could not update merging for this repository.')
        },
      },
    )
  }

  function handleDelete() {
    setDeleteError(null)
    deleteRepository.mutate(repository.id, {
      onSuccess: () => {
        onOpenChange(false)
        onDeleted?.()
      },
      onError: (err) => setDeleteError(err.message || 'Could not delete this repository.'),
    })
  }

  // isError before .data: a preference that failed to load must not render as
  // an "off" switch the owner then thinks they have set.
  const graphInclude = !graphPreference.isError && graphPreference.data ? graphPreference.data.include : false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Repository settings — {repository.name}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleRename} className="flex flex-col gap-2">
          <Label htmlFor="repository-name">Name</Label>
          <div className="flex items-end gap-2">
            <Input
              id="repository-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameError(null)
              }}
              className="flex-1"
            />
            <Button type="submit" disabled={updateRepository.isPending || name.trim() === repository.name}>
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The name is Chapters&rsquo; own label for this connection. Nothing is renamed in git or on disk.
          </p>
          <FormError message={nameError} />
        </form>

        <section className="flex flex-col gap-2">
          <h3 className="font-display text-base text-foreground">Merging</h3>
          <div className="flex items-center gap-2">
            <SwitchPrimitive.Root
              id="repository-mergeable"
              checked={mergeable}
              onCheckedChange={handleMergeable}
              disabled={updateRepository.isPending}
              className={switchClassName}
            >
              <SwitchPrimitive.Thumb className={thumbClassName} />
            </SwitchPrimitive.Root>
            <Label htmlFor="repository-mergeable">Mergeable</Label>
          </div>
          <p className="text-sm text-muted-foreground">
            {mergeable
              ? 'Anyone this repository is shared with can fold its files into their own merged graph view.'
              : "This repository stays out of everyone's merged graph view, including your own."}
          </p>
          <FormError message={mergeableError} />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="font-display text-base text-foreground">My merged graph</h3>
          <div className="flex items-center gap-2">
            <SwitchPrimitive.Root
              id="repository-graph-preference"
              checked={graphInclude}
              // Not while the current value is unknown: flipping a switch off a
              // guess would write the guess back.
              disabled={graphPreference.isPending || graphPreference.isError || setGraphPreference.isPending}
              onCheckedChange={(next) => {
                setGraphError(null)
                setGraphPreference.mutate(next, {
                  onError: (err) =>
                    setGraphError(err.message || 'Could not update your graph preference.'),
                })
              }}
              className={switchClassName}
            >
              <SwitchPrimitive.Thumb className={thumbClassName} />
            </SwitchPrimitive.Root>
            <Label htmlFor="repository-graph-preference">Include in my merged graph</Label>
          </div>
          <p className="text-sm text-muted-foreground">
            {graphPreference.isError
              ? 'Could not load your graph preference, so this switch is showing nothing rather than guessing.'
              : mergeable
                ? 'Yours alone — this is where your own merged graph is decided, not what anyone else sees.'
                : 'Merging is off for this repository, so this has no effect until you turn it on above.'}
          </p>
          <FormError message={graphError} />
        </section>

        <RepositoryShareList repositoryId={repository.id} />

        <SyncTokenList repositoryId={repository.id} />

        <section className="flex flex-col gap-2">
          <h3 className="font-display text-base text-foreground">Delete</h3>
          <ConfirmAction
            label="Delete repository"
            ariaLabel={`Delete ${repository.name}`}
            destructive
            pending={deleteRepository.isPending}
            error={deleteError}
            consequence={`Deleting removes this connection and everything Chapters indexed from it — files, symbols, shares and sync tokens. Your code is untouched: ${
              repository.ingestionMethod === 'git'
                ? 'the remote and its history stay exactly as they are.'
                : repository.ingestionMethod === 'local_path'
                  ? 'the folder on the server is not read again and nothing in it is changed.'
                  : 'whatever the agent pushed from is not touched.'
            } Reconnecting re-indexes it from scratch.`}
            onConfirm={handleDelete}
          />
        </section>
      </DialogContent>
    </Dialog>
  )
}
