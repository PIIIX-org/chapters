import { useEffect, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router'
import { EditorView } from '@codemirror/view'
import { useNote } from '../../hooks/useNote.js'
import { useCreateNote } from '../../hooks/useCreateNote.js'
import { useVaultTree } from '../../hooks/useVaultTree.js'
import { useRepositories } from '../../hooks/useRepositories.js'
import { useCodeMirrorEditor } from '../../hooks/useCodeMirrorEditor.js'
import { useCollabDoc } from '../../hooks/useCollabDoc.js'
import { useLiveNote } from '../../hooks/useLiveNote.js'
import type { LiveStatus } from '../../hooks/useLiveNote.js'
import { useSession } from '../../hooks/useSession.js'
import { canEdit } from '../../api/vaults.js'
import type { Vault, VaultAccess } from '../../api/vaults.js'
import { CollabPropertyPanel, LivePropertyPanel } from '../../components/vault/PropertyPanel.js'
import { CollabStatusLine, collabShellStatus } from '../../components/vault/CollabStatusLine.js'
import { CollaboratorAvatars } from '../../components/vault/CollaboratorAvatars.js'
import { NoteActions } from '../../components/vault/NoteActions.js'
import { RevokedNotice } from '../../components/vault/RevokedNotice.js'
import { BacklinksPanel } from '../../components/vault/BacklinksPanel.js'
import { LocalGraphPanel } from '../../components/vault/LocalGraphPanel.js'
import { RevisionHistory } from '../../components/vault/RevisionHistory.js'
import { SharingPanel } from '../../components/vault/SharingPanel.js'
import {
  NoteRichToolbar,
  NoteFloatingSelectionToolbar,
} from '../../components/vault/NoteRichToolbar.js'
import {
  useNoteWidth,
  NOTE_WIDTH_CLASSES,
  useNoteDirection,
} from '../../components/vault/note-toolbar-utils.js'
import type { NoteDirection } from '../../components/vault/note-toolbar-utils.js'
import { Edit2, History, Link2, Network, Share2, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { Inspector, PanelRailButton, PanelRailNav } from '../../components/shell/ShellPanels.js'
import { usePanel, useShellBreadcrumb, useShellStatus } from '../../components/shell/shell-context.js'
import type { ShellStatus } from '../../components/shell/shell-context.js'
import { Pill } from '../../components/ui/pill.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { Button } from '../../components/ui/button.js'
import { FormError } from '../../components/FormError.js'
import { SLUG, SlugRequirements } from '../../components/vault/SlugRequirements.js'
import { useRenameNote } from '../../hooks/useRenameNote.js'
import { useDeleteNote } from '../../hooks/useDeleteNote.js'
import { toast } from '../../lib/toast.js'
import { handleWikilinkClick } from '../../lib/handleWikilinkClick.js'
import { cn } from '../../lib/utils.js'

/**
 * Neither path saves through the notes API any more. Editors' keystrokes go
 * into the Y.Text and the relay persists it; readers make none. The debounced
 * `PUT` this file used to run *was* issue #66, and against a CRDT it would
 * clobber merged text with one client's snapshot.
 *
 * `useCodeMirrorEditor` never calls this when a `ytext` is bound; it exists
 * because the option is required.
 */
const NO_SAVE = () => {}

export function NoteView() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const path = useParams()['*']
  const vault = useOutletContext<Vault | undefined>()
  const note = useNote(vaultId!, path!)

  const breadcrumbItems =
    vaultId && path
      ? [
          { label: 'Vaults', to: '/vaults' },
          { label: vault?.name ?? 'Vault', to: `/vaults/${vaultId}` },
          { label: path },
        ]
      : [{ label: 'Vaults', to: '/vaults' }]

  useShellBreadcrumb(breadcrumbItems)

  // Conservative default: unknown access (vault undefined) => reader.
  // `canEdit(vault.access)` is what picks the transport, and that is the
  // audit's presence rule, not a performance choice: readers never join the
  // Yjs document, so they have no awareness and no identity in it at all.
  const editable = canEdit(vault?.access)

  /**
   * Which transport this note is open on. Decided from `editable` once per
   * vault and then held — deliberately not re-read every render.
   *
   * `useVaults` refetches on window focus, so a revocation arrives here as a
   * prop change mid-session. Acting on it by swapping the path (or by keying
   * the child on `editable`, which this file used to do) unmounts
   * `CollabNote`, `useCollabDoc`'s cleanup destroys the `Y.Doc`, and every
   * character typed since the last sync is gone — repainted over by the stale
   * REST body, with no warning and nothing to copy out. Losing unsaved work is
   * the one thing this must never do, so an access change downgrades the
   * session in place instead: locked editor plus the revoked notice, which is
   * exactly what the relay's kick already does without destroying the
   * document.
   *
   * *Gaining* access is safe to act on immediately — a reader has nothing
   * unsent.
   *
   * The decision is held per NOTE, not per vault. What it protects is an open
   * document with unsent characters in it; navigating to a different note
   * leaves nothing to protect, so that note decides afresh from current
   * access. Holding it per vault instead made the downgrade sticky: after one
   * revocation, every *other* note in that vault also opened on the collab
   * path, where the relay refuses the connection and the reader gets a blank
   * body under an "access removed" notice.
   */
  const noteKey = `${vaultId}/${path}`
  const [session, setSession] = useState({ noteKey, editing: editable })
  if (session.noteKey !== noteKey) setSession({ noteKey, editing: editable })
  else if (editable && !session.editing) setSession({ noteKey, editing: true })

  if (note.isPending) return null
  if (note.isError) return <div className="p-8 text-muted-foreground">Note not found.</div>

  // Remount key is the full note identity (vault + path), and nothing else:
  // keying on path alone would reuse a stale editor across a cross-vault
  // switch to the same path, and keying on access would destroy a live
  // document the moment access changed. See `session` above.
  const key = noteKey

  return session.editing ? (
    <CollabNote
      key={key}
      vaultId={vaultId!}
      path={path!}
      accessRevoked={!editable}
      initialBody={note.data!.body}
      access={vault?.access ?? 'read'}
    />
  ) : (
    <LiveNote
      key={key}
      vaultId={vaultId!}
      path={path!}
      initialFrontmatter={note.data!.frontmatter}
      initialBody={note.data!.body}
    />
  )
}

interface NoteFrameProps {
  /** The 40px note bar over the editor: path, status, presence, actions. */
  bar: ReactNode
  /** Sits between the note bar and the editor, in the flow — never over
   *  the document, which is where the unsent text is. */
  notice?: ReactNode
  editorRef: RefObject<HTMLDivElement | null>
  /** The inspector tabs for this note (Properties · History · Sharing). */
  inspector: ReactNode
  view?: EditorView | null
  readOnly?: boolean
  direction?: NoteDirection
  onDirectionChange?: (direction: NoteDirection) => void
  vaultId?: string
  path?: string
  properties?: ReactNode
  backlinks?: ReactNode
  graph?: ReactNode
  history?: ReactNode
  sharing?: ReactNode
}

function NoteFrame({
  bar,
  notice,
  editorRef,
  inspector,
  view = null,
  readOnly = false,
  direction = 'ltr',
  onDirectionChange,
  vaultId,
  path,
  properties,
  backlinks,
  graph,
  history,
  sharing,
}: NoteFrameProps) {
  const [width, setWidth] = useNoteWidth()
  const navigate = useNavigate()

  // Dynamic bottom drawer state (Drawing 3 & Drawing 4)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState<'properties' | 'backlinks' | 'graph' | 'history' | 'sharing'>('properties')

  // Rename & Delete dialogs
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const noteName = path ? (path.split('/').pop() ?? path) : ''
  const [newName, setNewName] = useState(noteName)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameSubmitted, setRenameSubmitted] = useState(false)

  const renameNote = useRenameNote(vaultId ?? '')
  const deleteNote = useDeleteNote(vaultId ?? '')

  function handleOpenRename() {
    setNewName(noteName)
    setRenameError(null)
    setRenameSubmitted(false)
    setRenameOpen(true)
  }

  function handleTabClick(tab: typeof drawerTab) {
    if (drawerOpen && drawerTab === tab) {
      setDrawerOpen(false)
    } else {
      setDrawerTab(tab)
      setDrawerOpen(true)
    }
  }

  function handleRenameSubmit(e: React.FormEvent) {
    e.preventDefault()
    setRenameSubmitted(true)
    if (!SLUG.test(newName)) {
      setRenameError('Name must be lowercase letters, numbers, and hyphens.')
      return
    }
    setRenameError(null)
    if (!vaultId || !path) return
    renameNote.mutate(
      { from: path, to: newName },
      {
        onSuccess: (renamed) => {
          setRenameOpen(false)
          toast.success('Note renamed', `${noteName} renamed to ${renamed.name || newName}.`)
          navigate(`/vaults/${vaultId}/notes/${renamed.path}`)
        },
        onError: (err) => {
          const msg = err.message || 'Could not rename the note.'
          toast.error('Failed to rename note', msg)
          setRenameError(msg)
        },
      },
    )
  }

  function handleDeleteConfirm() {
    if (!vaultId || !path) return
    deleteNote.mutate(path, {
      onSuccess: () => {
        setDeleteOpen(false)
        toast.success('Note deleted', `${noteName} moved to trash.`)
        navigate(`/vaults/${vaultId}`)
      },
      onError: (err) => {
        const msg = err.message || 'Could not delete the note.'
        toast.error('Failed to delete note', msg)
      },
    })
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/* Note bar: padded left to clear the CH logo and right to clear TopBar search */}
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-1 border-b border-border px-3 sm:px-4 sm:pr-16 py-1.5 sm:py-1">
          {bar}
          <button
            type="button"
            aria-label="Note drawer"
            title="Note drawer"
            onClick={() => handleTabClick('properties')}
            className={cn(
              'md:hidden flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0 touch-manipulation ml-auto',
              drawerOpen && 'bg-primary/10 text-primary font-semibold',
            )}
          >
            <SlidersHorizontal className="size-4" />
          </button>
        </div>
        {notice}
        <div className="px-2 sm:px-4">
          <NoteRichToolbar
            view={view}
            readOnly={readOnly}
            width={width}
            onWidthChange={setWidth}
            direction={direction}
            onDirectionChange={onDirectionChange}
            vaultId={vaultId}
          />
        </div>
        <NoteFloatingSelectionToolbar view={view} readOnly={readOnly} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 sm:p-4 pb-24 sm:pb-16">
          <div
            ref={editorRef}
            dir={direction}
            className={cn(
              'mx-auto h-full min-h-0 w-full transition-all duration-150',
              NOTE_WIDTH_CLASSES[width],
              direction === 'rtl' ? 'direction-rtl' : 'direction-ltr',
            )}
          />
        </div>
      </div>

      {/* Floating Action Toolbar on right (Drawing 3) */}
      <TooltipProvider delayDuration={300}>
        <nav
          aria-label="Note quick actions"
          className="hidden md:flex fixed right-3.5 top-1/2 -translate-y-1/2 z-20 flex-col items-center gap-1.5 rounded-xl border border-border bg-card/90 p-1.5 shadow-lg backdrop-blur-md opacity-20 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Properties"
                onClick={() => handleTabClick('properties')}
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                  drawerOpen && drawerTab === 'properties' && 'bg-primary/10 text-primary font-semibold',
                )}
              >
                <SlidersHorizontal className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Properties</TooltipContent>
          </Tooltip>

          {backlinks != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Backlinks"
                  onClick={() => handleTabClick('backlinks')}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                    drawerOpen && drawerTab === 'backlinks' && 'bg-primary/10 text-primary font-semibold',
                  )}
                >
                  <Link2 className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Backlinks</TooltipContent>
            </Tooltip>
          )}

          {graph != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Graph"
                  onClick={() => handleTabClick('graph')}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                    drawerOpen && drawerTab === 'graph' && 'bg-primary/10 text-primary font-semibold',
                  )}
                >
                  <Network className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Graph</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="History"
                onClick={() => handleTabClick('history')}
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                  drawerOpen && drawerTab === 'history' && 'bg-primary/10 text-primary font-semibold',
                )}
              >
                <History className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">History</TooltipContent>
          </Tooltip>

          {sharing != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Sharing"
                  onClick={() => handleTabClick('sharing')}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                    drawerOpen && drawerTab === 'sharing' && 'bg-primary/10 text-primary font-semibold',
                  )}
                >
                  <Share2 className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Sharing</TooltipContent>
            </Tooltip>
          )}

          {!readOnly && Boolean(vaultId && path) && (
            <>
              <div className="my-1 h-px w-5 bg-border/60" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Rename ${noteName}`}
                    onClick={handleOpenRename}
                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    <Edit2 className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Rename</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Delete ${noteName}`}
                    onClick={() => setDeleteOpen(true)}
                    className="flex size-8 items-center justify-center rounded-lg text-destructive/80 hover:bg-destructive/15 hover:text-destructive transition-colors"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Delete</TooltipContent>
              </Tooltip>
            </>
          )}
        </nav>
      </TooltipProvider>

      {/* Mobile Drawer Backdrop Overlay */}
      {drawerOpen && (
        <div
          role="presentation"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-35 bg-background/60 backdrop-blur-xs md:hidden animate-in fade-in duration-150"
        />
      )}

      {/* Dynamic Bottom Drawer (Drawing 4) */}
      {drawerOpen && (
        <aside
          aria-label="Note drawer"
          className="fixed bottom-0 inset-x-0 md:inset-x-8 md:bottom-2 z-40 max-w-5xl mx-auto flex flex-col rounded-t-2xl md:rounded-xl border border-border bg-card shadow-2xl backdrop-blur max-h-[75vh] md:max-h-[60vh] min-h-[200px] pb-safe animate-in slide-in-from-bottom duration-200"
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-2.5 pb-1 shrink-0">
            <div className="h-1.5 w-12 rounded-full bg-muted-foreground/30" />
          </div>

          {/* Drawer Header with Tab Navigation and Close Button */}
          <div className="flex items-center justify-between border-b border-border/60 px-3 sm:px-4 py-1.5 shrink-0 gap-2">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar scroll-smooth flex-nowrap min-w-0">
              <button
                type="button"
                onClick={() => setDrawerTab('properties')}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors shrink-0 touch-manipulation',
                  drawerTab === 'properties'
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Properties
              </button>
              {backlinks != null && (
                <button
                  type="button"
                  onClick={() => setDrawerTab('backlinks')}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors shrink-0 touch-manipulation',
                    drawerTab === 'backlinks'
                      ? 'bg-primary/10 text-primary font-semibold'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Backlinks
                </button>
              )}
              {graph != null && (
                <button
                  type="button"
                  onClick={() => setDrawerTab('graph')}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors shrink-0 touch-manipulation',
                    drawerTab === 'graph'
                      ? 'bg-primary/10 text-primary font-semibold'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Graph
                </button>
              )}
              <button
                type="button"
                onClick={() => setDrawerTab('history')}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors shrink-0 touch-manipulation',
                  drawerTab === 'history'
                    ? 'bg-primary/10 text-primary font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                History
              </button>
              {sharing != null && (
                <button
                  type="button"
                  onClick={() => setDrawerTab('sharing')}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors shrink-0 touch-manipulation',
                    drawerTab === 'sharing'
                      ? 'bg-primary/10 text-primary font-semibold'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Sharing
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close drawer"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0 touch-manipulation"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Drawer Content */}
          <div className="flex-1 overflow-y-auto p-3 sm:p-4 min-h-0">
            {drawerTab === 'properties' && properties}
            {drawerTab === 'backlinks' && backlinks}
            {drawerTab === 'graph' && graph}
            {drawerTab === 'history' && history}
            {drawerTab === 'sharing' && sharing}
          </div>
        </aside>
      )}

      {/* Rename Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-md mx-auto">
          <DialogHeader>
            <DialogTitle>Rename Note</DialogTitle>
            <DialogDescription>
              Enter a new URL-safe slug for this note.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRenameSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rename-slug-input">Name</Label>
              <Input
                id="rename-slug-input"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value)
                  if (renameError && SLUG.test(e.target.value)) setRenameError(null)
                }}
                className={cn(
                  'font-mono text-base sm:text-xs',
                  newName.length > 0 &&
                    (SLUG.test(newName)
                      ? 'border-emerald-500 focus-visible:ring-emerald-500'
                      : 'border-red-500 focus-visible:ring-red-500'),
                  (renameError || (renameSubmitted && !SLUG.test(newName))) &&
                    'border-red-500 focus-visible:ring-red-500',
                )}
              />
              <SlugRequirements value={newName} />
              <FormError message={renameError} />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" className="min-h-[38px] sm:min-h-0 touch-manipulation" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="min-h-[38px] sm:min-h-0 touch-manipulation" disabled={renameNote.isPending}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-md mx-auto">
          <DialogHeader>
            <DialogTitle>Delete Note</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{noteName}&rdquo;? It will be moved to trash.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" className="min-h-[38px] sm:min-h-0 touch-manipulation" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-[38px] sm:min-h-0 touch-manipulation"
              onClick={handleDeleteConfirm}
              disabled={deleteNote.isPending}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Inspector label="Note" className="min-h-0">
        {inspector}
      </Inspector>
    </>
  )
}

interface NoteInspectorProps {
  properties: ReactNode
  backlinks?: ReactNode
  graph?: ReactNode
  history: ReactNode
  /** Owner-only: shares are the owner's to grant, so nobody else gets the tab. */
  sharing?: ReactNode
}

/** The note's detail, as inspector tabs — the property panel, backlinks, local graph,
 *  the revision history and (for the owner) sharing all fold in here. */
function NoteInspector({ properties, backlinks, graph, history, sharing }: NoteInspectorProps) {
  const [tab, setTab] = useState<'properties' | 'backlinks' | 'graph' | 'history' | 'sharing'>('properties')
  const panel = usePanel()

  if (panel && !panel.open) {
    return (
      <PanelRailNav label="Note inspector tabs">
        <PanelRailButton
          icon={SlidersHorizontal}
          label="Properties"
          active={tab === 'properties'}
          onClick={() => setTab('properties')}
        />
        {backlinks != null && (
          <PanelRailButton
            icon={Link2}
            label="Backlinks"
            active={tab === 'backlinks'}
            onClick={() => setTab('backlinks')}
          />
        )}
        {graph != null && (
          <PanelRailButton
            icon={Network}
            label="Graph"
            active={tab === 'graph'}
            onClick={() => setTab('graph')}
          />
        )}
        <PanelRailButton
          icon={History}
          label="History"
          active={tab === 'history'}
          onClick={() => setTab('history')}
        />
        {sharing != null && (
          <PanelRailButton
            icon={Share2}
            label="Sharing"
            active={tab === 'sharing'}
            onClick={() => setTab('sharing')}
          />
        )}
      </PanelRailNav>
    )
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex min-h-0 flex-1 flex-col">
      <TabsList>
        <TabsTrigger value="properties">Properties</TabsTrigger>
        {backlinks != null && <TabsTrigger value="backlinks">Backlinks</TabsTrigger>}
        {graph != null && <TabsTrigger value="graph">Graph</TabsTrigger>}
        <TabsTrigger value="history">History</TabsTrigger>
        {sharing != null && <TabsTrigger value="sharing">Sharing</TabsTrigger>}
      </TabsList>
      <TabsContent value="properties" className="flex-1 overflow-y-auto p-3">
        {properties}
      </TabsContent>
      {backlinks != null && (
        <TabsContent value="backlinks" className="flex-1 overflow-y-auto p-3">
          {backlinks}
        </TabsContent>
      )}
      {graph != null && (
        <TabsContent value="graph" className="flex-1 overflow-y-auto p-3">
          {graph}
        </TabsContent>
      )}
      <TabsContent value="history" className="flex-1 overflow-y-auto p-3">
        {history}
      </TabsContent>
      {sharing != null && (
        <TabsContent value="sharing" className="flex-1 overflow-y-auto p-3">
          {sharing}
        </TabsContent>
      )}
    </Tabs>
  )
}

/** Shared by both paths: the wikilink target list and what a click on one does. */
function useWikilinks(vaultId: string, canCreate: boolean) {
  const navigate = useNavigate()
  const createNote = useCreateNote(vaultId)
  const tree = useVaultTree(vaultId)
  const repos = useRepositories()
  const targets = tree.data ? Object.values(tree.data).flat().map((n) => n.path) : []

  return {
    targets,
    onClick: (target: string) =>
      handleWikilinkClick(
        target,
        vaultId,
        targets,
        canCreate,
        (to) => navigate(to),
        (input, onSettled) => createNote.mutate(input, { onSettled }),
        repos.data,
      ),
  }
}

interface NoteIdentity {
  vaultId: string
  path: string
}

interface CollabNoteProps extends NoteIdentity {
  /** The REST view of this vault says the edit access is gone. Same news the
   *  relay's kick carries, arriving over a different wire — a window-focus
   *  refetch can beat a dropped socket's next reconnect — and either one is
   *  enough to lock the session. Never a reason to unmount it. */
  accessRevoked: boolean
  /** Only ever rendered when the relay could not be reached at all — see
   *  `strandedOffline`. Never seeded into the shared document. */
  initialBody: string
  /** Drives the History tab (revision purge is owner-only) and the Sharing
   *  tab (owner-only outright). */
  access: VaultAccess
}

/**
 * The editor path: one Yjs document, shared with everyone else holding `edit`.
 * No `PUT`, no local copy of the body — the `Y.Text` is the document.
 */
function CollabNote({ vaultId, path, accessRevoked, initialBody, access }: CollabNoteProps) {
  const session = useSession()
  // isError before .data, as everywhere.
  const me = session.isPending || session.isError ? null : session.data

  const collab = useCollabDoc({
    vaultId,
    path,
    // Until unit 4 gives users a display name, the presence label is the local
    // part of the address (unit 6 plan, gap 7) — never the full email, which
    // would show every co-editor's address to everyone in the note.
    user: { id: me?.id ?? '', name: me ? (me.email.split('@')[0] ?? me.email) : '' },
    // No identity, no connection: awareness is broadcast at connect time, so
    // joining before the session resolves would label this person as nobody.
    enabled: me !== null,
  })

  const revoked = accessRevoked || collab.status === 'revoked'
  // `writable` — not `status === 'revoked'`. Enumerating statuses at the call
  // site is how 'offline' got missed once already, and the failure mode is a
  // person typing into a document that is not syncing anywhere.
  const locked = revoked || !collab.writable
  const wikilinks = useWikilinks(vaultId, !locked)
  const ytext = collab.ydoc.getText('body')

  // Never connected, and not because access was taken away: the relay or the
  // ticket endpoint is down. The Y.Text is empty, so the collab editor would
  // show a BLANK note over a note that has content — worse than useless on the
  // screen someone opened to read it.
  //
  // The REST body is shown instead, read-only. It is not seeded into the
  // Y.Text: doing that would merge a local copy into the shared document on
  // eventual connect and duplicate the whole note. `writable` is already false
  // while offline, so nothing can be typed into this and lost on the swap.
  const strandedOffline = collab.status === 'offline' && !collab.synced

  const [direction, setDirection] = useNoteDirection(vaultId, path, initialBody)
  const [editorView, setEditorView] = useState<EditorView | null>(null)

  const editorRef = useCodeMirrorEditor({
    // Ignored under collab (the hook seeds from the Y.Text): a REST body would
    // be inserted a second time when the document loads.
    doc: strandedOffline ? initialBody : '',
    onChange: NO_SAVE,
    readOnly: locked,
    wikilinkTargets: wikilinks.targets,
    onWikilinkClick: wikilinks.onClick,
    collab: strandedOffline ? undefined : { ytext, awareness: collab.awareness },
    direction,
    onView: setEditorView,
    vaultId,
  })

  // "Synced 10:04" needs the moment `synced` last became true. Tracked with
  // React's adjust-state-during-render pattern (the same one `useCollabDoc`
  // uses for the document swap): setting it from an effect is a cascading
  // render, and the time it would stamp is the render's, not the event's.
  const [mark, setMark] = useState<{ synced: boolean; at: Date | null }>({ synced: false, at: null })
  if (mark.synced !== collab.synced) {
    setMark({ synced: collab.synced, at: collab.synced ? new Date() : mark.at })
  }

  // The note bar's pill, mirrored into the shell's top bar — same mapping,
  // so the two can never disagree (spec: shell shows the page's live status).
  useShellStatus(collabShellStatus(collab.status, collab.synced))

  const rawType = collab.ydoc.getMap('frontmatter').get('type')
  const noteType =
    (typeof rawType === 'string' && rawType.trim().length > 0 ? rawType.trim() : path.split('/')[0]) || ''

  const propertiesNode = <CollabPropertyPanel frontmatter={collab.ydoc.getMap('frontmatter')} readOnly={locked} />
  const backlinksNode = <BacklinksPanel vaultId={vaultId} path={path} />
  const graphNode = <LocalGraphPanel vaultId={vaultId} path={path} />
  const historyNode = <RevisionHistory vaultId={vaultId} path={path} access={access} />
  const sharingNode = access === 'owner' ? <SharingPanel vaultId={vaultId} /> : undefined

  return (
    <NoteFrame
      editorRef={editorRef}
      view={editorView}
      readOnly={locked}
      direction={direction}
      onDirectionChange={setDirection}
      vaultId={vaultId}
      path={path}
      properties={propertiesNode}
      backlinks={backlinksNode}
      graph={graphNode}
      history={historyNode}
      sharing={sharingNode}
      bar={
        <>
          {noteType && (
            <Pill
              tone="neutral"
              className="font-mono text-xs uppercase tracking-wider"
            >
              {noteType}
            </Pill>
          )}
          <CollabStatusLine status={collab.status} synced={collab.synced} syncedAt={mark.at} />
          {/* Presence lives in this bar and nowhere else — never a global
              "who's online", which leaks who is working on what. */}
          <CollaboratorAvatars peers={collab.peers} />
          {/* Rename/delete need edit server-side, and `locked` covers offline
              too — a rename that cannot reach the API is a door to an error. */}
          {!locked && (
            <div className="ml-auto">
              <NoteActions vaultId={vaultId} note={{ path, name: path.split('/').pop() ?? path }} />
            </div>
          )}
        </>
      }
      notice={revoked ? <RevokedNotice /> : null}
      inspector={
        <NoteInspector
          properties={propertiesNode}
          backlinks={backlinksNode}
          graph={graphNode}
          // RevisionHistory explains itself to a downgraded (now read) viewer
          // instead of firing a request that can only 403.
          history={historyNode}
          sharing={sharingNode}
        />
      }
    />
  )
}

const LIVE_WHISPER: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live — updates as others type',
  reconnecting: 'Reconnecting…',
  ended: 'Live updates stopped — your access to this note may have changed',
}

/** The reader path's mirror of LIVE_WHISPER for the shell's top-bar pill:
 *  same states, shortened to pill length. */
const LIVE_SHELL: Record<LiveStatus, ShellStatus> = {
  connecting: { tone: 'idle', label: 'Connecting…' },
  live: { tone: 'live', label: 'Live' },
  reconnecting: { tone: 'idle', label: 'Reconnecting' },
  ended: { tone: 'error', label: 'Live ended' },
}

interface LiveNoteProps extends NoteIdentity {
  initialFrontmatter: Record<string, unknown>
  initialBody: string
}

/**
 * The reader path: the SSE live view, which sends whole note states and no
 * presence data of any kind. Locked, but never stale.
 */
function LiveNote({ vaultId, path, initialFrontmatter, initialBody }: LiveNoteProps) {
  const live = useLiveNote({ vaultId, path, enabled: true })
  useShellStatus(LIVE_SHELL[live.status])
  // The REST fetch is what is on screen until the first frame arrives.
  const state = live.state ?? { frontmatter: initialFrontmatter, body: initialBody }
  const wikilinks = useWikilinks(vaultId, false)

  const [direction, setDirection] = useNoteDirection(vaultId, path, state.body)
  const [editorView, setEditorView] = useState<EditorView | null>(null)

  const editorRef = useCodeMirrorEditor({
    doc: state.body,
    onChange: NO_SAVE,
    readOnly: true,
    wikilinkTargets: wikilinks.targets,
    onWikilinkClick: wikilinks.onClick,
    direction,
    onView: setEditorView,
    vaultId,
  })

  // The editor is built once, around the first body it is given. Later frames
  // are dispatched into it rather than remounting it, so a reader's scroll
  // position survives other people typing. `readOnly` blocks user input, not
  // an explicit transaction.
  useEffect(() => {
    const view = editorRef.current && EditorView.findFromDOM(editorRef.current)
    if (!view || view.state.doc.toString() === state.body) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: state.body } })
  }, [editorRef, state.body])

  const noteType =
    (typeof state.frontmatter?.type === 'string' && state.frontmatter.type.trim().length > 0
      ? state.frontmatter.type.trim()
      : path.split('/')[0]) || ''

  const propertiesNode = <LivePropertyPanel frontmatter={state.frontmatter} />
  const backlinksNode = <BacklinksPanel vaultId={vaultId} path={path} />
  const graphNode = <LocalGraphPanel vaultId={vaultId} path={path} />
  const historyNode = <RevisionHistory vaultId={vaultId} path={path} access="read" />

  return (
    <NoteFrame
      editorRef={editorRef}
      view={editorView}
      readOnly={true}
      direction={direction}
      onDirectionChange={setDirection}
      vaultId={vaultId}
      path={path}
      properties={propertiesNode}
      backlinks={backlinksNode}
      graph={graphNode}
      history={historyNode}
      bar={
        <>
          {noteType && (
            <Pill
              tone="neutral"
              className="font-mono text-xs uppercase tracking-wider"
            >
              {noteType}
            </Pill>
          )}
          <Pill>Read-only</Pill>
          <span role="status" className="truncate text-xs text-muted-foreground">
            {LIVE_WHISPER[live.status]}
          </span>
        </>
      }
      inspector={
        <NoteInspector
          properties={propertiesNode}
          backlinks={backlinksNode}
          graph={graphNode}
          // Same layout as an editor's, locked: RevisionHistory says why a
          // read-only viewer gets no list instead of rendering a 403.
          history={historyNode}
        />
      }
    />
  )
}
