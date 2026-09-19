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
import {
  COLOR_PALETTE,
  type VaultColor,
} from '../vault/useVaultFolders.js'
import { CustomColorPickerDialog } from '../vault/CustomColorPickerDialog.js'
import type { Repository } from '../../api/repositories.js'

interface RepoFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo: Repository | null
  currentFolder: string
  currentFolderColor?: VaultColor
  currentRepoColor?: VaultColor
  allFolders: string[]
  onSave: (
    repoId: string,
    folder: string,
    repoColor?: VaultColor,
    folderColor?: VaultColor,
  ) => void
}

function CustomColorWheel({
  value,
  onClick,
  label,
}: {
  value?: VaultColor
  onClick: () => void
  label: string
}) {
  const isCustom = Boolean(value && !COLOR_PALETTE.some((c) => c.id === value))
  const hexValue = isCustom && value?.startsWith('#') ? value : undefined

  return (
    <button
      type="button"
      onClick={onClick}
      title={isCustom ? `Custom color: ${value}` : `Custom ${label}`}
      aria-label={`Open custom ${label} picker`}
      className={`relative size-6 rounded-full cursor-pointer flex items-center justify-center transition-transform hover:scale-110 shadow-sm ${
        isCustom
          ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105'
          : 'opacity-80 hover:opacity-100'
      }`}
      style={{
        background:
          'conic-gradient(from 90deg, #ff0000, #ff8000, #ffff00, #00ff00, #00ffff, #0000ff, #8000ff, #ff0080, #ff0000)',
      }}
    >
      {isCustom && hexValue && (
        <span
          className="size-2.5 rounded-full border border-white/80 shadow-xs pointer-events-none"
          style={{ backgroundColor: hexValue }}
        />
      )}
    </button>
  )
}

export function RepoFolderDialog({
  open,
  onOpenChange,
  repo,
  currentFolder,
  currentFolderColor,
  currentRepoColor,
  allFolders,
  onSave,
}: RepoFolderDialogProps) {
  const [folderName, setFolderName] = useState(currentFolder)
  const [folderColor, setFolderColor] = useState<VaultColor | undefined>(currentFolderColor)
  const [repoColor, setRepoColor] = useState<VaultColor | undefined>(currentRepoColor)
  const [colorPickerTarget, setColorPickerTarget] = useState<'folder' | 'repo' | null>(null)

  if (!repo) return null

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSave(repo!.id, folderName.trim(), repoColor, folderColor)
    onOpenChange(false)
  }

  function handleRemove() {
    onSave(repo!.id, '', repoColor, folderColor)
    onOpenChange(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Organize Repository</DialogTitle>
            <DialogDescription>
              Assign &quot;{repo.name}&quot; to a folder and customize its color coding.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repo-folder-input">Folder Name</Label>
              <Input
                id="repo-folder-input"
                placeholder="e.g. Frontend, Backend, Infrastructure"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                autoFocus
              />
              {allFolders.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  <span className="text-xs text-muted-foreground mr-1 self-center">
                    Existing:
                  </span>
                  {allFolders.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFolderName(f)}
                      className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                        folderName === f
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground border-border'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Folder Color */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label>Folder Color</Label>
                {folderColor && (
                  <button
                    type="button"
                    onClick={() => setFolderColor(undefined)}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    title={c.label}
                    onClick={() => setFolderColor(c.id)}
                    className={`size-6 rounded-full ${c.accent} transition-transform hover:scale-110 ${
                      folderColor === c.id
                        ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105'
                        : 'opacity-80 hover:opacity-100'
                    }`}
                  />
                ))}
                <CustomColorWheel
                  value={folderColor}
                  onClick={() => setColorPickerTarget('folder')}
                  label="folder color"
                />
              </div>
            </div>

            {/* Repo Accent Color */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label>Repository Accent Color</Label>
                {repoColor && (
                  <button
                    type="button"
                    onClick={() => setRepoColor(undefined)}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    title={c.label}
                    onClick={() => setRepoColor(c.id)}
                    className={`size-6 rounded-full ${c.accent} transition-transform hover:scale-110 ${
                      repoColor === c.id
                        ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105'
                        : 'opacity-80 hover:opacity-100'
                    }`}
                  />
                ))}
                <CustomColorWheel
                  value={repoColor}
                  onClick={() => setColorPickerTarget('repo')}
                  label="repository color"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              {currentFolder ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleRemove}
                  className="text-destructive hover:text-destructive"
                >
                  Remove from folder
                </Button>
              ) : (
                <div />
              )}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
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

      {/* Custom Color Picker Modal */}
      <CustomColorPickerDialog
        open={colorPickerTarget !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setColorPickerTarget(null)
        }}
        initialColor={
          colorPickerTarget === 'folder'
            ? folderColor
            : colorPickerTarget === 'repo'
              ? repoColor
              : undefined
        }
        title={colorPickerTarget === 'folder' ? 'Folder Color' : 'Repository Color'}
        onConfirm={(hex) => {
          if (colorPickerTarget === 'folder') {
            setFolderColor(hex)
          } else if (colorPickerTarget === 'repo') {
            setRepoColor(hex)
          }
          setColorPickerTarget(null)
        }}
      />
    </>
  )
}
