import { useState } from 'react'
import type { FormEvent } from 'react'
import { Cloud, HardDrive } from 'lucide-react'
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
  type VaultStorageMode,
} from './useVaultFolders.js'
import { CustomColorPickerDialog } from './CustomColorPickerDialog.js'
import type { Vault } from '../../api/vaults.js'

interface VaultFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vault: Vault | null
  currentFolder: string
  currentFolderColor?: VaultColor
  currentVaultColor?: VaultColor
  allFolders: string[]
  storageMode?: VaultStorageMode
  onSave: (
    vaultId: string,
    folder: string,
    vaultColor?: VaultColor,
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
      className={`relative size-6.5 sm:size-6 rounded-full cursor-pointer flex items-center justify-center transition-transform hover:scale-110 shadow-sm touch-manipulation ${
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

export function VaultFolderDialog({
  open,
  onOpenChange,
  vault,
  currentFolder,
  currentFolderColor,
  currentVaultColor,
  allFolders,
  storageMode = 'online',
  onSave,
}: VaultFolderDialogProps) {
  const [folderName, setFolderName] = useState(currentFolder)
  const [folderColor, setFolderColor] = useState<VaultColor | undefined>(currentFolderColor)
  const [vaultColor, setVaultColor] = useState<VaultColor | undefined>(currentVaultColor)
  const [colorPickerTarget, setColorPickerTarget] = useState<'folder' | 'vault' | null>(null)

  if (!vault) return null

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSave(vault!.id, folderName.trim(), vaultColor, folderColor)
    onOpenChange(false)
  }

  function handleRemove() {
    onSave(vault!.id, '', vaultColor, folderColor)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-md max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Organize Vault</DialogTitle>
          <DialogDescription>
            Assign &ldquo;{vault.name}&rdquo; to a folder and customize color coding.
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
                    className={`text-xs px-2.5 py-1 sm:py-0.5 rounded border transition-colors touch-manipulation ${
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
          {/* Folder Color Picker */}
          {folderName.trim() && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground font-medium">
                Folder Color ({folderName.trim()}):
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setFolderColor(undefined)}
                  title="Default color"
                  className={`size-6.5 sm:size-6 rounded-full border border-border flex items-center justify-center text-[10px] text-muted-foreground hover:border-foreground/40 transition-colors touch-manipulation ${
                    !folderColor ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''
                  }`}
                >
                  ✕
                </button>
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setFolderColor(c.id)}
                    title={c.label}
                    className={`size-6.5 sm:size-6 rounded-full ${c.accent} transition-transform hover:scale-110 touch-manipulation ${
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
          )}

          {/* Vault Accent Color Picker */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground font-medium">
              Vault Accent Color:
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setVaultColor(undefined)}
                title="Default (no color)"
                className={`size-6.5 sm:size-6 rounded-full border border-border flex items-center justify-center text-[10px] text-muted-foreground hover:border-foreground/40 transition-colors touch-manipulation ${
                  !vaultColor ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''
                }`}
              >
                ✕
              </button>
              {COLOR_PALETTE.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setVaultColor(c.id)}
                  title={c.label}
                  className={`size-6.5 sm:size-6 rounded-full ${c.accent} transition-transform hover:scale-110 touch-manipulation ${
                    vaultColor === c.id
                      ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105'
                      : 'opacity-80 hover:opacity-100'
                    }`}
                />
              ))}
              <CustomColorWheel
                value={vaultColor}
                onClick={() => setColorPickerTarget('vault')}
                label="vault accent color"
              />
            </div>
          </div>

          {/* Storage indicator */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/40 px-2.5 py-1.5 rounded-md border border-border/50">
            {storageMode === 'online' ? (
              <>
                <Cloud className="size-3.5 text-primary shrink-0" aria-hidden="true" />
                <span>Folders and colors sync with your account across devices.</span>
              </>
            ) : (
              <>
                <HardDrive className="size-3.5 text-amber-500 shrink-0" aria-hidden="true" />
                <span>Folders and colors are kept in this browser only.</span>
              </>
            )}
          </div>

          <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-2 pt-2">
            {currentFolder ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleRemove}
                className="text-muted-foreground hover:text-destructive h-9 sm:h-8"
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
                className="flex-1 sm:flex-none h-9 sm:h-8"
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" className="flex-1 sm:flex-none h-9 sm:h-8">
                Save
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>

      <CustomColorPickerDialog
        open={colorPickerTarget !== null}
        onOpenChange={(isOpen) => !isOpen && setColorPickerTarget(null)}
        initialColor={
          colorPickerTarget === 'folder'
            ? folderColor?.startsWith('#')
              ? folderColor
              : '#3b82f6'
            : vaultColor?.startsWith('#')
              ? vaultColor
              : '#3b82f6'
        }
        title={colorPickerTarget === 'folder' ? 'Folder Color' : 'Vault Accent Color'}
        onConfirm={(hex) => {
          if (colorPickerTarget === 'folder') {
            setFolderColor(hex)
          } else if (colorPickerTarget === 'vault') {
            setVaultColor(hex)
          }
        }}
      />
    </Dialog>
  )
}
