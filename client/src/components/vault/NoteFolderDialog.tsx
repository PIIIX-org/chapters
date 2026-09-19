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
} from './useVaultFolders.js'
import { CustomColorPickerDialog } from './CustomColorPickerDialog.js'
import type { NoteSummary } from '../../api/notes.js'

interface NoteFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  note: NoteSummary | null
  currentFolder: string
  currentFolderColor?: VaultColor
  currentNoteColor?: VaultColor
  allFolders: string[]
  onSave: (
    noteId: string,
    folder: string,
    noteColor?: VaultColor,
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

export function NoteFolderDialog({
  open,
  onOpenChange,
  note,
  currentFolder,
  currentFolderColor,
  currentNoteColor,
  allFolders,
  onSave,
}: NoteFolderDialogProps) {
  const [folderName, setFolderName] = useState(currentFolder)
  const [folderColor, setFolderColor] = useState<VaultColor | undefined>(currentFolderColor)
  const [noteColor, setNoteColor] = useState<VaultColor | undefined>(currentNoteColor)
  const [colorPickerTarget, setColorPickerTarget] = useState<'folder' | 'note' | null>(null)

  if (!note) return null

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSave(note!.id, folderName.trim(), noteColor, folderColor)
    onOpenChange(false)
  }

  function handleRemove() {
    onSave(note!.id, '', noteColor, folderColor)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Organize Note</DialogTitle>
          <DialogDescription>
            Assign &ldquo;{note.name}&rdquo; to a folder and customize color coding.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="note-folder-input">Folder Name</Label>
            <Input
              id="note-folder-input"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="e.g. Work, Meetings, Ideas"
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

          {/* Folder Color Picker */}
          {folderName.trim() && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground font-medium">
                Folder Color ({folderName.trim()}):
              </span>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => setFolderColor(undefined)}
                  title="Default color"
                  className={`size-6 rounded-full border border-border flex items-center justify-center text-[10px] text-muted-foreground hover:border-foreground/40 transition-colors ${
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
          )}

          {/* Note Accent Color Picker */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground font-medium">
              Note Accent Color:
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setNoteColor(undefined)}
                title="Default (no color)"
                className={`size-6 rounded-full border border-border flex items-center justify-center text-[10px] text-muted-foreground hover:border-foreground/40 transition-colors ${
                  !noteColor ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''
                }`}
              >
                ✕
              </button>
              {COLOR_PALETTE.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setNoteColor(c.id)}
                  title={c.label}
                  className={`size-6 rounded-full ${c.accent} transition-transform hover:scale-110 ${
                    noteColor === c.id
                      ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105'
                      : 'opacity-80 hover:opacity-100'
                  }`}
                />
              ))}
              <CustomColorWheel
                value={noteColor}
                onClick={() => setColorPickerTarget('note')}
                label="note accent color"
              />
            </div>
          </div>

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

      <CustomColorPickerDialog
        open={colorPickerTarget !== null}
        onOpenChange={(isOpen) => !isOpen && setColorPickerTarget(null)}
        initialColor={
          colorPickerTarget === 'folder'
            ? folderColor?.startsWith('#')
              ? folderColor
              : '#3b82f6'
            : noteColor?.startsWith('#')
              ? noteColor
              : '#3b82f6'
        }
        title={colorPickerTarget === 'folder' ? 'Folder Color' : 'Note Accent Color'}
        onConfirm={(hex) => {
          if (colorPickerTarget === 'folder') {
            setFolderColor(hex)
          } else if (colorPickerTarget === 'note') {
            setNoteColor(hex)
          }
        }}
      />
    </Dialog>
  )
}
