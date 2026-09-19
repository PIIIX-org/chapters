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
import type { Vault } from '../../api/vaults.js'

interface VaultFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vault: Vault | null
  currentFolder: string
  allFolders: string[]
  onSave: (vaultId: string, folder: string) => void
}

export function VaultFolderDialog({
  open,
  onOpenChange,
  vault,
  currentFolder,
  allFolders,
  onSave,
}: VaultFolderDialogProps) {
  const [folderName, setFolderName] = useState(currentFolder)

  if (!vault) return null

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSave(vault!.id, folderName.trim())
    onOpenChange(false)
  }

  function handleRemove() {
    onSave(vault!.id, '')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Organize Vault</DialogTitle>
          <DialogDescription>
            Assign &ldquo;{vault.name}&rdquo; to a folder to keep your vaults
            organized.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="folder-input">Folder Name</Label>
            <Input
              id="folder-input"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="e.g. Work, Personal, Research"
              autoFocus
            />
          </div>

          {allFolders.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground font-medium">
                Existing Folders:
              </span>
              <div className="flex flex-wrap gap-1.5">
                {allFolders.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFolderName(f)}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                      folderName.toLowerCase() === f.toLowerCase()
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                  >
                    📁 {f}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between sm:justify-between pt-2">
            {currentFolder ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleRemove}
                className="text-muted-foreground hover:text-destructive"
              >
                Remove from folder
              </Button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Save
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
