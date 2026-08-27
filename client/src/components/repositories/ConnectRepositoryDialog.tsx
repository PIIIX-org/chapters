import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Button } from '../ui/button.js'
import { FormError } from '../FormError.js'
import { useCreateRepository } from '../../hooks/useRepositories.js'
import type { CreateRepositoryInput, IngestionMethod, Repository } from '../../api/repositories.js'

interface ConnectRepositoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The connected repository, for the caller to navigate to or select. */
  onConnected?: (repository: Repository) => void
}

/**
 * The three ingestion methods differ in where the code comes from, not in
 * what Chapters does with it, so they are three branches of one form rather
 * than three dialogs. Each branch carries only its own fields — the request
 * body is built from the chosen method, never from whatever is still sitting
 * in a field the user has switched away from.
 */
const METHODS: { value: IngestionMethod; label: string; blurb: string }[] = [
  {
    value: 'git',
    label: 'Git remote',
    blurb: 'Chapters clones the remote and re-indexes it after every push.',
  },
  {
    value: 'local_path',
    label: 'Folder on this server',
    blurb: 'Chapters indexes a folder that already exists on the machine it runs on, then watches it for changes.',
  },
  {
    value: 'agent_push',
    label: 'Agent push',
    blurb: 'An agent sends files in over the API with a sync token. Nothing is cloned.',
  },
]

export function ConnectRepositoryDialog({ open, onOpenChange, onConnected }: ConnectRepositoryDialogProps) {
  const [name, setName] = useState('')
  const [method, setMethod] = useState<IngestionMethod>('git')
  const [gitUrl, setGitUrl] = useState('')
  const [gitCredential, setGitCredential] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createRepository = useCreateRepository()

  function buildInput(): CreateRepositoryInput | string {
    const trimmedName = name.trim()
    if (!trimmedName) return 'Give the repository a name.'
    if (method === 'git') {
      const url = gitUrl.trim()
      if (!url) return 'A git remote needs a clone URL.'
      const credential = gitCredential.trim()
      // Only the git branch's own fields travel, credential only when typed.
      return credential
        ? { name: trimmedName, ingestionMethod: 'git', gitUrl: url, gitCredential: credential }
        : { name: trimmedName, ingestionMethod: 'git', gitUrl: url }
    }
    if (method === 'local_path') {
      const path = localPath.trim()
      if (!path) return 'A folder connection needs a path.'
      return { name: trimmedName, ingestionMethod: 'local_path', localPath: path }
    }
    return { name: trimmedName, ingestionMethod: 'agent_push' }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const input = buildInput()
    if (typeof input === 'string') {
      setError(input)
      return
    }
    setError(null)
    createRepository.mutate(input, {
      onSuccess: (repository) => {
        setName('')
        setGitUrl('')
        setGitCredential('')
        setLocalPath('')
        onConnected?.(repository)
        onOpenChange(false)
      },
      onError: (err) => setError(err.message || 'Could not connect the repository.'),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a repository</DialogTitle>
          <DialogDescription>
            Chapters reads code and never writes it back — git stays the record of truth.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="connect-repo-name">Repository name</Label>
            <Input
              id="connect-repo-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              placeholder="e.g. chapters"
            />
          </div>

          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="text-sm font-medium text-foreground">How should Chapters get the code?</legend>
            {METHODS.map((option) => (
              <div
                key={option.value}
                className="flex items-start gap-2 rounded-lg border border-border p-2 text-sm"
              >
                <input
                  id={`connect-repo-method-${option.value}`}
                  type="radio"
                  name="connect-repo-method"
                  className="mt-1"
                  value={option.value}
                  checked={method === option.value}
                  aria-describedby={`connect-repo-method-${option.value}-blurb`}
                  onChange={() => {
                    setMethod(option.value)
                    setError(null)
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  {/* The blurb is a description, not part of the name: a radio
                      called "Agent push" is targetable, one called "Agent push
                      An agent sends files in over the API…" is not. */}
                  <Label htmlFor={`connect-repo-method-${option.value}`} className="text-foreground">
                    {option.label}
                  </Label>
                  <span
                    id={`connect-repo-method-${option.value}-blurb`}
                    className="text-xs text-muted-foreground"
                  >
                    {option.blurb}
                  </span>
                </span>
              </div>
            ))}
          </fieldset>

          {method === 'git' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="connect-repo-git-url">Git remote URL</Label>
                <Input
                  id="connect-repo-git-url"
                  value={gitUrl}
                  onChange={(e) => {
                    setGitUrl(e.target.value)
                    setError(null)
                  }}
                  placeholder="https://github.com/owner/repo.git"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="connect-repo-git-credential">Access token or password (optional)</Label>
                <Input
                  id="connect-repo-git-credential"
                  type="password"
                  value={gitCredential}
                  onChange={(e) => {
                    setGitCredential(e.target.value)
                    setError(null)
                  }}
                  autoComplete="off"
                />
                {/* Said where it is typed, not in a help page: this is the last
                    moment the value is visible to anyone, including its owner. */}
                <p className="text-xs text-muted-foreground">
                  Only needed for a private remote. It is stored encrypted and never shown again — to change
                  it later you connect the repository again.
                </p>
              </div>
            </div>
          )}

          {method === 'local_path' && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="connect-repo-local-path">Folder path</Label>
              <Input
                id="connect-repo-local-path"
                value={localPath}
                onChange={(e) => {
                  setLocalPath(e.target.value)
                  setError(null)
                }}
                placeholder="my-project"
              />
              {/* Without this the server's 400 reads as a bug rather than a rule. */}
              <p className="text-xs text-muted-foreground">
                Relative to the repositories folder configured on this server. A path that resolves outside
                it is refused.
              </p>
            </div>
          )}

          {method === 'agent_push' && (
            <p className="text-xs text-muted-foreground">
              Nothing else to fill in. After connecting, create a sync token in this repository&rsquo;s settings
              and give it to the agent — until an agent pushes, the repository stays empty.
            </p>
          )}

          <FormError message={error} />

          <Button type="submit" disabled={createRepository.isPending} className="self-start">
            {createRepository.isPending ? 'Connecting…' : 'Connect repository'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
