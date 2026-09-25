import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderTree,
  LayoutGrid,
  List,
  Plus,
  Search,
  Star,
  X,
} from 'lucide-react'
import { Panel, PanelHeader } from '../../components/ui/panel.js'
import { PanelState } from '../../components/ui/empty-state.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { Pill } from '../../components/ui/pill.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js'
import { useVaults } from '../../hooks/useVaults.js'
import { useVaultTree } from '../../hooks/useVaultTree.js'
import { canEdit } from '../../api/vaults.js'
import { getColorDef, type VaultColor } from '../../components/vault/useVaultFolders.js'
import { useNoteFolders } from '../../components/vault/useNoteFolders.js'
import { NoteCard } from '../../components/vault/NoteCard.js'
import { NoteFolderDialog } from '../../components/vault/NoteFolderDialog.js'
import { NoteActions } from '../../components/vault/NoteActions.js'
import { NewNoteForm } from '../../components/vault/NewNoteForm.js'
import type { NoteSummary } from '../../api/notes.js'

type ViewMode = 'card' | 'list'
type SortOption = 'name-asc' | 'name-desc' | 'updated' | 'type'

export function VaultNotesPage() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const navigate = useNavigate()
  const vaults = useVaults()
  const tree = useVaultTree(vaultId!)
  const vault = vaults.data?.find((v) => v.id === vaultId)
  const editable = canEdit(vault?.access)

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('chapters_notes_view_mode') as ViewMode) || 'card'
  })
  const [groupByFolder, setGroupByFolder] = useState<boolean>(() => {
    return localStorage.getItem('chapters_notes_group_by_folder') === 'true'
  })
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [selectedFolder, setSelectedFolder] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<SortOption>('updated')
  const [creating, setCreating] = useState(false)
  const [folderModalNote, setFolderModalNote] = useState<NoteSummary | null>(null)

  const {
    getNoteFolder,
    getFolderColor,
    getNoteColor,
    setNoteFolder,
    isFavorite,
    toggleFavorite,
    allFolders: customFolders,
  } = useNoteFolders(vaultId!)

  // Flatten all notes from tree
  const allNotes = useMemo(() => {
    if (!tree.data) return []
    return Object.values(tree.data).flat()
  }, [tree.data])

  const allFolders = useMemo(() => {
    const set = new Set(customFolders)
    for (const n of allNotes) {
      const f = getNoteFolder(n.id, n.path, n.type)
      if (f) set.add(f)
    }
    return Array.from(set)
  }, [customFolders, allNotes, getNoteFolder])

  const existingTypes = useMemo(() => {
    return Object.keys(tree.data ?? {})
  }, [tree.data])

  function handleViewModeChange(mode: ViewMode) {
    setViewMode(mode)
    localStorage.setItem('chapters_notes_view_mode', mode)
  }

  function handleToggleGroupByFolder() {
    setGroupByFolder((prev) => {
      const next = !prev
      localStorage.setItem('chapters_notes_group_by_folder', String(next))
      return next
    })
  }

  function toggleFolderCollapse(folder: string) {
    setCollapsedFolders((prev) => ({
      ...prev,
      [folder]: !prev[folder],
    }))
  }

  function handleSaveFolder(
    noteId: string,
    folder: string,
    noteColor?: VaultColor,
    folderColor?: VaultColor,
  ) {
    setNoteFolder(noteId, folder, noteColor, folderColor)
  }

  // Folder Counts
  const folderCounts = useMemo(() => {
    let uncategorized = 0
    const byFolder: Record<string, number> = {}

    for (const n of allNotes) {
      const f = getNoteFolder(n.id, n.path, n.type)
      if (!f) {
        uncategorized++
      } else {
        byFolder[f] = (byFolder[f] || 0) + 1
      }
    }

    return {
      all: allNotes.length,
      uncategorized,
      byFolder,
    }
  }, [allNotes, getNoteFolder])

  // Filter & Sort
  const filteredNotes = useMemo(() => {
    return allNotes
      .filter((n) => {
        // Search filter
        if (search.trim()) {
          const q = search.toLowerCase()
          const folder = getNoteFolder(n.id, n.path, n.type).toLowerCase()
          if (
            !n.name.toLowerCase().includes(q) &&
            !n.path.toLowerCase().includes(q) &&
            !folder.includes(q)
          ) {
            return false
          }
        }

        // Folder filter
        const nFolder = getNoteFolder(n.id, n.path, n.type)
        if (selectedFolder === 'uncategorized') {
          if (nFolder) return false
        } else if (selectedFolder !== 'all') {
          if (nFolder.toLowerCase() !== selectedFolder.toLowerCase()) return false
        }

        // Type filter
        if (typeFilter !== 'all' && n.type !== typeFilter) {
          return false
        }

        return true
      })
      .sort((a, b) => {
        // Pinned notes come first
        const aFav = isFavorite(a.id) ? 1 : 0
        const bFav = isFavorite(b.id) ? 1 : 0
        if (aFav !== bFav) return bFav - aFav

        if (sortBy === 'name-asc') return a.name.localeCompare(b.name)
        if (sortBy === 'name-desc') return b.name.localeCompare(a.name)
        if (sortBy === 'updated') {
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        }
        if (sortBy === 'type') {
          return (a.type || '').localeCompare(b.type || '')
        }
        return 0
      })
  }, [allNotes, search, selectedFolder, typeFilter, sortBy, getNoteFolder, isFavorite])

  // Grouped by folder data
  const groupedNotes = useMemo(() => {
    if (!groupByFolder) return null
    const groups: { folder: string; color?: VaultColor; notes: NoteSummary[] }[] = []

    const folderMap: Record<string, NoteSummary[]> = {}
    const uncategorized: NoteSummary[] = []

    for (const n of filteredNotes) {
      const f = getNoteFolder(n.id, n.path, n.type)
      if (f) {
        if (!folderMap[f]) folderMap[f] = []
        folderMap[f].push(n)
      } else {
        uncategorized.push(n)
      }
    }

    for (const f of allFolders) {
      if (folderMap[f] && folderMap[f].length > 0) {
        groups.push({
          folder: f,
          color: getFolderColor(f),
          notes: folderMap[f],
        })
      }
    }

    if (uncategorized.length > 0) {
      groups.push({
        folder: 'Uncategorized',
        notes: uncategorized,
      })
    }

    return groups
  }, [groupByFolder, filteredNotes, allFolders, getNoteFolder, getFolderColor])

  const hasActiveFilters =
    search.trim() !== '' || selectedFolder !== 'all' || typeFilter !== 'all'

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[80%] flex-col gap-4 px-4 pt-5 pb-16">
        <Panel>
          <PanelHeader
            title={
              allNotes.length > 0 && filteredNotes.length !== allNotes.length
                ? `Notes (${filteredNotes.length} of ${allNotes.length})`
                : 'Notes'
            }
            actions={
              <div className="flex items-center gap-2">
                {/* Group by folder toggle */}
                <Button
                  type="button"
                  size="xs"
                  variant={groupByFolder ? 'secondary' : 'ghost'}
                  onClick={handleToggleGroupByFolder}
                  title={groupByFolder ? 'Ungroup folders' : 'Group by folder'}
                  aria-label="Group by folder"
                  className="h-7 px-2 gap-1 text-xs"
                >
                  <FolderTree className="size-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Group</span>
                </Button>

                {/* View toggle */}
                <div
                  role="group"
                  aria-label="View mode"
                  className="flex items-center rounded-md border border-border bg-muted/40 p-0.5"
                >
                  <Button
                    type="button"
                    size="xs"
                    variant={viewMode === 'card' ? 'secondary' : 'ghost'}
                    onClick={() => handleViewModeChange('card')}
                    aria-label="Card view"
                    className="h-7 px-2"
                  >
                    <LayoutGrid className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                    onClick={() => handleViewModeChange('list')}
                    aria-label="List view"
                    className="h-7 px-2"
                  >
                    <List className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>

                {editable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setCreating((c) => !c)}
                    aria-expanded={creating}
                  >
                    <Plus aria-hidden="true" />
                    New note
                  </Button>
                )}
              </div>
            }
          />

          {editable && creating && (
            <div className="border-b border-border p-3">
              <NewNoteForm
                vaultId={vaultId!}
                existingTypes={existingTypes}
                onCreated={(note) => {
                  setCreating(false)
                  navigate(`/vaults/${vaultId}/notes/${note.path}`)
                }}
              />
            </div>
          )}

          {/* Search, Filter, and Sort Toolbar */}
          {allNotes.length > 0 && (
            <div className="border-b border-border p-3 flex flex-col gap-3 bg-muted/10">
              <div className="flex flex-wrap items-center gap-2">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px]">
                  <Search
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none"
                    aria-hidden="true"
                  />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search notes by name, path, or folder..."
                    aria-label="Search notes"
                    className="pl-8 h-8 text-xs"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      aria-label="Clear search"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>

                {/* Type filter */}
                {existingTypes.length > 0 && (
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                    aria-label="Filter by type"
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="all">All types</option>
                    {existingTypes.map((t) => (
                      <option key={t} value={t}>
                        Type: {t}
                      </option>
                    ))}
                  </select>
                )}

                {/* Sort */}
                <div className="flex items-center gap-1">
                  <ArrowUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortOption)}
                    aria-label="Sort notes"
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="updated">Recently updated</option>
                    <option value="name-asc">Name (A–Z)</option>
                    <option value="name-desc">Name (Z–A)</option>
                    <option value="type">Type</option>
                  </select>
                </div>
              </div>

              {/* Visual Folder Tabs / Shelf */}
              <div className="flex items-end gap-2 overflow-x-auto pt-2 pb-1 text-xs">
                <span className="text-muted-foreground font-medium text-[11px] uppercase tracking-wider shrink-0 mb-1.5 mr-1">
                  Folders:
                </span>

                {/* "All" Folder Tab */}
                <div className="relative inline-flex flex-col items-start shrink-0">
                  <div
                    className={`h-1.5 w-6 rounded-t-sm border-t border-x transition-colors ${
                      selectedFolder === 'all'
                        ? 'bg-primary border-primary'
                        : 'bg-muted/60 border-border'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedFolder('all')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-b-md rounded-tr-md border transition-colors ${
                      selectedFolder === 'all'
                        ? 'border-primary bg-primary text-primary-foreground font-medium'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                  >
                    <span>All</span>
                    <span className="text-[10px] opacity-80">({folderCounts.all})</span>
                  </button>
                </div>

                {/* "Uncategorized" Folder Tab */}
                {folderCounts.uncategorized > 0 && (
                  <div className="relative inline-flex flex-col items-start shrink-0">
                    <div
                      className={`h-1.5 w-6 rounded-t-sm border-t border-x transition-colors ${
                        selectedFolder === 'uncategorized'
                          ? 'bg-primary border-primary'
                          : 'bg-muted/60 border-border'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setSelectedFolder('uncategorized')}
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-b-md rounded-tr-md border transition-colors ${
                        selectedFolder === 'uncategorized'
                          ? 'border-primary bg-primary text-primary-foreground font-medium'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
                      }`}
                    >
                      <span>Uncategorized</span>
                      <span className="text-[10px] opacity-80">({folderCounts.uncategorized})</span>
                    </button>
                  </div>
                )}

                {/* User Named Folder Tabs */}
                {allFolders.map((folder) => {
                  const count = folderCounts.byFolder[folder] || 0
                  const colorDef = getColorDef(getFolderColor(folder))
                  const isSelected = selectedFolder === folder

                  return (
                    <div key={folder} className="relative inline-flex flex-col items-start shrink-0">
                      {/* Top folder tab ear */}
                      <div
                        className={`h-1.5 w-7 rounded-t-sm border-t border-x transition-colors ${
                          isSelected
                            ? colorDef
                              ? colorDef.cardTopBar
                              : 'bg-primary border-primary'
                            : colorDef
                              ? colorDef.accent + ' opacity-40'
                              : 'bg-muted/60 border-border'
                        }`}
                        style={
                          isSelected
                            ? colorDef?.style?.cardTopBar
                            : colorDef?.style?.accent
                              ? { ...colorDef.style.accent, opacity: 0.4 }
                              : undefined
                        }
                      />
                      {/* Folder tab body */}
                      <button
                        type="button"
                        onClick={() => setSelectedFolder(folder)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-b-md rounded-tr-md border transition-colors ${
                          isSelected
                            ? colorDef
                              ? `${colorDef.badge} border-current font-medium shadow-sm`
                              : 'border-primary bg-primary text-primary-foreground font-medium'
                            : colorDef
                              ? `${colorDef.badge} border-border hover:border-current`
                              : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
                        }`}
                        style={colorDef?.style?.badge}
                      >
                        <Folder
                          className={`size-3.5 ${colorDef ? colorDef.folderIcon : ''}`}
                          style={colorDef?.style?.folderIcon}
                          aria-hidden="true"
                        />
                        <span>{folder}</span>
                        <span className="text-[10px] opacity-80">({count})</span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {tree.isError ? (
            <PanelState
              status="error"
              title="We couldn’t load notes."
              message={tree.error.message}
              onRetry={() => tree.refetch()}
            />
          ) : tree.isPending ? (
            <PanelState status="loading" />
          ) : allNotes.length === 0 ? (
            <PanelState
              status="empty"
              title="No notes yet"
              message="Create a note to start writing and connecting ideas."
            />
          ) : filteredNotes.length === 0 ? (
            <div className="p-8 text-center flex flex-col items-center gap-2">
              <p className="text-sm text-muted-foreground">No notes match the current filter.</p>
              {hasActiveFilters && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch('')
                    setSelectedFolder('all')
                    setTypeFilter('all')
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : groupByFolder && groupedNotes ? (
            /* Grouped by Folder View */
            <div className="flex flex-col gap-6 p-4">
              {groupedNotes.map((group) => {
                const colorDef = getColorDef(group.color)
                const isCollapsed = Boolean(collapsedFolders[group.folder])

                return (
                  <div key={group.folder} className="flex flex-col">
                    {/* Visual Folder Tab Protrusion */}
                    <div className="flex items-end">
                      <div
                        className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-t-lg border-t border-x text-xs font-medium transition-colors ${
                          colorDef
                            ? colorDef.folderTab
                            : 'bg-muted/80 border-border text-foreground'
                        }`}
                        style={colorDef?.style?.folderTab}
                      >
                        <button
                          type="button"
                          onClick={() => toggleFolderCollapse(group.folder)}
                          className="flex items-center gap-1.5 hover:underline"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="size-3.5" aria-hidden="true" />
                          ) : (
                            <ChevronDown className="size-3.5" aria-hidden="true" />
                          )}
                          <Folder
                            className={`size-3.5 ${colorDef ? colorDef.folderIcon : ''}`}
                            style={colorDef?.style?.folderIcon}
                            aria-hidden="true"
                          />
                          <span>{group.folder}</span>
                          <span className="text-[10px] opacity-75">
                            ({group.notes.length})
                          </span>
                        </button>
                      </div>
                    </div>

                    {/* Folder Body */}
                    <div
                      className={`rounded-b-lg rounded-tr-lg border border-border p-4 transition-colors ${
                        colorDef ? colorDef.folderBg : 'bg-muted/10'
                      } ${isCollapsed ? 'hidden' : ''}`}
                      style={colorDef?.style?.folderBg}
                    >
                      {viewMode === 'card' ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          {group.notes.map((note) => (
                            <NoteCard
                              key={note.id}
                              note={note}
                              vaultId={vaultId!}
                              folder={getNoteFolder(note.id, note.path, note.type)}
                              noteColor={getNoteColor(note.id)}
                              folderColor={getFolderColor(
                                getNoteFolder(note.id, note.path, note.type),
                              )}
                              isFavorite={isFavorite(note.id)}
                              onToggleFavorite={toggleFavorite}
                              onOrganizeFolder={setFolderModalNote}
                              canEdit={editable}
                            />
                          ))}
                        </div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Name</TableHead>
                              <TableHead>Folder</TableHead>
                              <TableHead>Type</TableHead>
                              <TableHead>Updated</TableHead>
                              <TableHead className="w-0">
                                <span className="sr-only">Actions</span>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.notes.map((note) => {
                              const folder = getNoteFolder(note.id, note.path, note.type)
                              const nColor = getColorDef(getNoteColor(note.id))
                              const fColor = getColorDef(getFolderColor(folder))
                              const isFav = isFavorite(note.id)

                              return (
                                <TableRow key={note.id}>
                                  <TableCell>
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => toggleFavorite(note.id)}
                                        aria-label={
                                          isFav
                                            ? `Unfavorite ${note.name}`
                                            : `Favorite ${note.name}`
                                        }
                                        className={`p-0.5 rounded transition-colors ${
                                          isFav
                                            ? 'text-amber-500'
                                            : 'text-muted-foreground/30 hover:text-amber-500'
                                        }`}
                                      >
                                        <Star
                                          className={`size-3.5 ${isFav ? 'fill-amber-500 text-amber-500' : ''}`}
                                          aria-hidden="true"
                                        />
                                      </button>
                                      {nColor && (
                                        <span
                                          className={`size-2 rounded-full shrink-0 ${nColor.accent}`}
                                          style={nColor.style?.accent}
                                          title={`Color: ${nColor.label}`}
                                        />
                                      )}
                                      <Link
                                        to={`/vaults/${vaultId}/notes/${note.path}`}
                                        className="font-medium text-foreground hover:underline"
                                      >
                                        {note.name}
                                      </Link>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <button
                                      type="button"
                                      onClick={() => setFolderModalNote(note)}
                                      title={folder ? `Folder: ${folder}` : 'Assign folder'}
                                      aria-label={
                                        folder
                                          ? `Folder: ${folder} for ${note.name}`
                                          : `Assign folder for ${note.name}`
                                      }
                                      className={`flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded border transition-colors ${
                                        fColor
                                          ? fColor.badge
                                          : 'text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted border-border/60'
                                      }`}
                                      style={fColor?.style?.badge}
                                    >
                                      <Folder
                                        className={`size-3 ${fColor ? fColor.folderIcon : 'text-muted-foreground'}`}
                                        style={fColor?.style?.folderIcon}
                                        aria-hidden="true"
                                      />
                                      <span>{folder || 'Add folder'}</span>
                                    </button>
                                  </TableCell>
                                  <TableCell>
                                    {note.type && <Pill tone="neutral">{note.type}</Pill>}
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    {note.updatedAt
                                      ? new Date(note.updatedAt).toLocaleDateString()
                                      : '—'}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {editable && (
                                      <NoteActions vaultId={vaultId!} note={note} />
                                    )}
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : viewMode === 'card' ? (
            /* Flat Card View */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-4">
              {filteredNotes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  vaultId={vaultId!}
                  folder={getNoteFolder(note.id, note.path, note.type)}
                  noteColor={getNoteColor(note.id)}
                  folderColor={getFolderColor(
                    getNoteFolder(note.id, note.path, note.type),
                  )}
                  isFavorite={isFavorite(note.id)}
                  onToggleFavorite={toggleFavorite}
                  onOrganizeFolder={setFolderModalNote}
                  canEdit={editable}
                />
              ))}
            </div>
          ) : (
            /* Flat Table View */
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Folder</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredNotes.map((note) => {
                  const folder = getNoteFolder(note.id, note.path, note.type)
                  const nColor = getColorDef(getNoteColor(note.id))
                  const fColor = getColorDef(getFolderColor(folder))
                  const isFav = isFavorite(note.id)

                  return (
                    <TableRow key={note.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleFavorite(note.id)}
                            aria-label={
                              isFav
                                ? `Unfavorite ${note.name}`
                                : `Favorite ${note.name}`
                            }
                            className={`p-0.5 rounded transition-colors ${
                              isFav
                                ? 'text-amber-500'
                                : 'text-muted-foreground/30 hover:text-amber-500'
                            }`}
                          >
                            <Star
                              className={`size-3.5 ${isFav ? 'fill-amber-500 text-amber-500' : ''}`}
                              aria-hidden="true"
                            />
                          </button>
                          {nColor && (
                            <span
                              className={`size-2 rounded-full shrink-0 ${nColor.accent}`}
                              style={nColor.style?.accent}
                              title={`Color: ${nColor.label}`}
                            />
                          )}
                          <Link
                            to={`/vaults/${vaultId}/notes/${note.path}`}
                            className="font-medium text-foreground hover:underline flex items-center gap-1.5"
                          >
                            <FileText className="size-3.5 text-muted-foreground" aria-hidden="true" />
                            <span>{note.name}</span>
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setFolderModalNote(note)}
                          title={folder ? `Folder: ${folder}` : 'Assign folder'}
                          aria-label={
                            folder
                              ? `Folder: ${folder} for ${note.name}`
                              : `Assign folder for ${note.name}`
                          }
                          className={`flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded border transition-colors ${
                            fColor
                              ? fColor.badge
                              : 'text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted border-border/60'
                          }`}
                          style={fColor?.style?.badge}
                        >
                          <Folder
                            className={`size-3 ${fColor ? fColor.folderIcon : 'text-muted-foreground'}`}
                            style={fColor?.style?.folderIcon}
                            aria-hidden="true"
                          />
                          <span>{folder || 'Add folder'}</span>
                        </button>
                      </TableCell>
                      <TableCell>
                        {note.type && <Pill tone="neutral">{note.type}</Pill>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {note.updatedAt
                          ? new Date(note.updatedAt).toLocaleDateString()
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {editable && <NoteActions vaultId={vaultId!} note={note} />}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>

      {folderModalNote && (
        <NoteFolderDialog
          open={Boolean(folderModalNote)}
          onOpenChange={(open) => !open && setFolderModalNote(null)}
          note={folderModalNote}
          currentFolder={getNoteFolder(
            folderModalNote.id,
            folderModalNote.path,
            folderModalNote.type,
          )}
          currentFolderColor={getFolderColor(
            getNoteFolder(
              folderModalNote.id,
              folderModalNote.path,
              folderModalNote.type,
            ),
          )}
          currentNoteColor={getNoteColor(folderModalNote.id)}
          allFolders={allFolders}
          onSave={handleSaveFolder}
        />
      )}
    </div>
  )
}
