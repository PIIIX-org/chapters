import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  FolderTree,
  HardDrive,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  Search,
  Star,
  X,
} from 'lucide-react'
import { Button } from '../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js'
import { PanelState } from '../components/ui/empty-state.js'
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel.js'
import { Pill } from '../components/ui/pill.js'
import { Input } from '../components/ui/input.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js'
import { NewVaultForm } from '../components/vault/NewVaultForm.js'
import { VaultCard } from '../components/vault/VaultCard.js'
import { VaultFolderDialog } from '../components/vault/VaultFolderDialog.js'
import {
  getColorDef,
  useVaultFolders,
  type VaultColor,
} from '../components/vault/useVaultFolders.js'
import {
  VaultRowActions,
  VaultTrashSection,
} from '../components/shell/VaultActions.js'
import { useShellBreadcrumb } from '../components/shell/shell-context.js'
import { useVaults } from '../hooks/useVaults.js'
import type { Vault, VaultAccess } from '../api/vaults.js'

const ACCESS_LABEL: Record<VaultAccess, string> = {
  owner: 'Owner',
  edit: 'Can edit',
  read: 'Read only',
}

type ViewMode = 'card' | 'list'
type SortOption = 'name-asc' | 'name-desc' | 'access' | 'merged'

/**
 * `/vaults` — every vault this person can reach, in Card or List view,
 * with folder organization, visual folder styling, color coding, and favorites.
 */
export function VaultsPage() {
  const vaults = useVaults()
  const navigate = useNavigate()
  const {
    allFolders,
    getVaultFolder,
    setVaultFolder,
    getFolderColor,
    setFolderColor,
    getVaultColor,
    setVaultColor,
    toggleFavorite,
    isFavorite,
    storageMode,
    setStorageMode,
    syncStatus,
    syncNow,
  } = useVaultFolders()

  const [storageDialogOpen, setStorageDialogOpen] = useState(false)

  const [creating, setCreating] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem('chapters_vaults_view') as ViewMode) || 'card'
    } catch {
      return 'card'
    }
  })
  const [groupByFolder, setGroupByFolder] = useState<boolean>(() => {
    try {
      return localStorage.getItem('chapters_vaults_group_by_folder') === 'true'
    } catch {
      return false
    }
  })
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const [selectedFolder, setSelectedFolder] = useState<string>('all')
  const [accessFilter, setAccessFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<SortOption>('name-asc')
  const [folderModalVault, setFolderModalVault] = useState<Vault | null>(null)

  useShellBreadcrumb([{ label: 'Vaults' }])

  function handleViewModeChange(mode: ViewMode) {
    setViewMode(mode)
    try {
      localStorage.setItem('chapters_vaults_view', mode)
    } catch {
      // Ignore
    }
  }

  function handleToggleGroupByFolder() {
    const next = !groupByFolder
    setGroupByFolder(next)
    try {
      localStorage.setItem('chapters_vaults_group_by_folder', String(next))
    } catch {
      // Ignore
    }
  }

  function toggleFolderCollapse(folder: string) {
    setCollapsedFolders((prev) => ({
      ...prev,
      [folder]: !prev[folder],
    }))
  }

  function handleSaveFolder(
    vaultId: string,
    folder: string,
    vaultColor?: VaultColor,
    folderColor?: VaultColor,
  ) {
    setVaultFolder(vaultId, folder)
    setVaultColor(vaultId, vaultColor)
    if (folder) {
      setFolderColor(folder, folderColor)
    }
  }

  // Folder counts computation
  const folderCounts = useMemo(() => {
    if (!vaults.data) return { all: 0, uncategorized: 0, byFolder: {} as Record<string, number> }
    let uncategorized = 0
    const byFolder: Record<string, number> = {}

    for (const v of vaults.data) {
      const f = getVaultFolder(v.id, v.name)
      if (!f) {
        uncategorized++
      } else {
        byFolder[f] = (byFolder[f] || 0) + 1
      }
    }

    return {
      all: vaults.data.length,
      uncategorized,
      byFolder,
    }
  }, [vaults.data, getVaultFolder])

  // Filter & Sort
  const filteredVaults = useMemo(() => {
    if (!vaults.data) return []

    return vaults.data
      .filter((v) => {
        // Search filter
        if (search.trim()) {
          const q = search.toLowerCase()
          const folder = getVaultFolder(v.id, v.name).toLowerCase()
          if (!v.name.toLowerCase().includes(q) && !folder.includes(q)) {
            return false
          }
        }

        // Folder filter
        const vFolder = getVaultFolder(v.id, v.name)
        if (selectedFolder === 'uncategorized') {
          if (vFolder) return false
        } else if (selectedFolder !== 'all') {
          if (vFolder.toLowerCase() !== selectedFolder.toLowerCase()) return false
        }

        // Access filter
        if (accessFilter !== 'all' && v.access !== accessFilter) {
          return false
        }

        return true
      })
      .sort((a, b) => {
        // Pinned vaults come first if not sorting by a specific property
        const aFav = isFavorite(a.id) ? 1 : 0
        const bFav = isFavorite(b.id) ? 1 : 0
        if (aFav !== bFav) return bFav - aFav

        if (sortBy === 'name-asc') return a.name.localeCompare(b.name)
        if (sortBy === 'name-desc') return b.name.localeCompare(a.name)
        if (sortBy === 'access') {
          const priority: Record<VaultAccess, number> = { owner: 1, edit: 2, read: 3 }
          return (priority[a.access] || 99) - (priority[b.access] || 99)
        }
        if (sortBy === 'merged') {
          return (b.mergeable ? 1 : 0) - (a.mergeable ? 1 : 0)
        }
        return 0
      })
  }, [vaults.data, search, selectedFolder, accessFilter, sortBy, getVaultFolder, isFavorite])

  // Grouped by folder data
  const groupedVaults = useMemo(() => {
    if (!groupByFolder) return null
    const groups: { folder: string; color?: VaultColor; vaults: Vault[] }[] = []

    // Group matching vaults by their folder
    const folderMap: Record<string, Vault[]> = {}
    const uncategorized: Vault[] = []

    for (const v of filteredVaults) {
      const f = getVaultFolder(v.id, v.name)
      if (f) {
        if (!folderMap[f]) folderMap[f] = []
        folderMap[f].push(v)
      } else {
        uncategorized.push(v)
      }
    }

    for (const f of allFolders) {
      if (folderMap[f] && folderMap[f].length > 0) {
        groups.push({
          folder: f,
          color: getFolderColor(f),
          vaults: folderMap[f],
        })
      }
    }

    if (uncategorized.length > 0) {
      groups.push({
        folder: 'Uncategorized',
        vaults: uncategorized,
      })
    }

    return groups
  }, [groupByFolder, filteredVaults, allFolders, getVaultFolder, getFolderColor])

  const hasActiveFilters =
    search.trim() !== '' || selectedFolder !== 'all' || accessFilter !== 'all'

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-full sm:max-w-[94%] md:max-w-[88%] lg:max-w-[80%] flex-col gap-3 sm:gap-4 px-2.5 sm:px-4 py-3 sm:py-5">
        <Panel>
          <PanelHeader
            className="min-h-9 h-auto py-2 sm:h-9 sm:py-0 flex-wrap sm:flex-nowrap gap-y-2"
            title={
              vaults.data && vaults.data.length > 0 && filteredVaults.length !== vaults.data.length
                ? `Vaults (${filteredVaults.length} of ${vaults.data.length})`
                : 'Vaults'
            }
            actions={
              <div className="flex items-center flex-wrap gap-1.5 sm:gap-2">
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

                {/* Storage mode toggle / settings */}
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setStorageDialogOpen(true)}
                  title={
                    storageMode === 'online'
                      ? 'Folders sync across devices (Online). Click to configure.'
                      : 'Folders stored in this browser only (Local). Click to configure.'
                  }
                  aria-label="Vault folders storage settings"
                  className="h-7 px-2 gap-1 text-xs"
                >
                  {storageMode === 'online' ? (
                    <Cloud className="size-3.5 text-primary" aria-hidden="true" />
                  ) : (
                    <HardDrive className="size-3.5 text-amber-500" aria-hidden="true" />
                  )}
                  <span className="hidden md:inline">
                    {storageMode === 'online' ? 'Cloud' : 'Local'}
                  </span>
                  {syncStatus === 'syncing' && (
                    <RefreshCw className="size-3 animate-spin text-muted-foreground ml-0.5" aria-hidden="true" />
                  )}
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

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCreating((c) => !c)}
                  aria-expanded={creating}
                  className="h-7 sm:h-8 px-2 sm:px-3 text-xs gap-1"
                >
                  <Plus aria-hidden="true" className="size-3.5" />
                  <span>New vault</span>
                </Button>
              </div>
            }
          />

          {creating && (
            <div className="border-b border-border p-3">
              <NewVaultForm
                onCreated={(vault: Vault) => {
                  setCreating(false)
                  navigate(`/vaults/${vault.id}`)
                }}
              />
            </div>
          )}

          {/* Search, Filter, and Sort Toolbar */}
          {vaults.data && vaults.data.length > 0 && (
            <div className="border-b border-border p-2.5 sm:p-3 flex flex-col gap-2.5 sm:gap-3 bg-muted/10">
              <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
                {/* Search */}
                <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
                  <Search
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none"
                    aria-hidden="true"
                  />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search vaults by name or folder..."
                    aria-label="Search vaults"
                    className="pl-8 pr-8 h-8 text-xs w-full"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      aria-label="Clear search"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>

                {/* Filters row on mobile, inline on desktop */}
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  {/* Access filter */}
                  <select
                    value={accessFilter}
                    onChange={(e) => setAccessFilter(e.target.value)}
                    aria-label="Filter by access"
                    className="h-8 flex-1 sm:flex-none rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="all">All access</option>
                    <option value="owner">Role: Owner</option>
                    <option value="edit">Role: Can edit</option>
                    <option value="read">Role: Read only</option>
                  </select>

                  {/* Sort */}
                  <div className="flex items-center gap-1 flex-1 sm:flex-none">
                    <ArrowUpDown className="size-3.5 text-muted-foreground shrink-0 hidden sm:inline-block" aria-hidden="true" />
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as SortOption)}
                      aria-label="Sort vaults"
                      className="h-8 w-full sm:w-auto rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="name-asc">Name (A–Z)</option>
                      <option value="name-desc">Name (Z–A)</option>
                      <option value="access">Access level</option>
                      <option value="merged">Merged view first</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Visual Folder Tabs / Shelf */}
              <div className="flex items-end gap-2 overflow-x-auto pt-2 pb-1.5 text-xs -mx-2.5 px-2.5 sm:mx-0 sm:px-0 scroll-smooth">
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

          {vaults.isError ? (
            <PanelState
              status="error"
              title="We couldn’t load your vaults."
              message={vaults.error.message}
              onRetry={() => vaults.refetch()}
            />
          ) : vaults.isPending ? (
            <PanelState status="loading" />
          ) : vaults.data.length === 0 ? (
            <PanelState
              status="empty"
              title="No vaults yet"
              message="A vault holds your notes, and the graph draws the links between them."
            />
          ) : filteredVaults.length === 0 ? (
            <div className="p-8 text-center flex flex-col items-center gap-2">
              <p className="text-sm text-muted-foreground">No vaults match the current filter.</p>
              {hasActiveFilters && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch('')
                    setSelectedFolder('all')
                    setAccessFilter('all')
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : groupByFolder && groupedVaults ? (
            /* Grouped by Folder View */
            <div className="flex flex-col gap-4 sm:gap-6 p-2.5 sm:p-4">
              {groupedVaults.map((group) => {
                const colorDef = getColorDef(group.color)
                const isCollapsed = Boolean(collapsedFolders[group.folder])

                return (
                  <div key={group.folder} className="flex flex-col">
                    {/* Visual Folder Tab Protrusion */}
                    <div className="flex items-end">
                      <div
                        className={`inline-flex items-center gap-2 px-3 sm:px-3.5 py-1.5 rounded-t-lg border-t border-x text-xs font-medium transition-colors ${
                          colorDef
                            ? colorDef.folderTab
                            : 'bg-muted/80 border-border text-foreground'
                        }`}
                        style={colorDef?.style?.folderTab}
                      >
                        <button
                          type="button"
                          onClick={() => toggleFolderCollapse(group.folder)}
                          className="flex items-center gap-1.5 hover:underline touch-manipulation"
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
                            ({group.vaults.length})
                          </span>
                        </button>
                      </div>
                    </div>

                    {/* Folder Body */}
                    <div
                      className={`rounded-b-lg rounded-tr-lg border border-border p-3 sm:p-4 transition-colors ${
                        colorDef ? colorDef.folderBg : 'bg-muted/10'
                      } ${isCollapsed ? 'hidden' : ''}`}
                      style={colorDef?.style?.folderBg}
                    >
                      {viewMode === 'card' ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
                          {group.vaults.map((vault) => (
                            <VaultCard
                              key={vault.id}
                              vault={vault}
                              folder={getVaultFolder(vault.id, vault.name)}
                              vaultColor={getVaultColor(vault.id)}
                              folderColor={getFolderColor(getVaultFolder(vault.id, vault.name))}
                              isFavorite={isFavorite(vault.id)}
                              onToggleFavorite={toggleFavorite}
                              onOrganizeFolder={setFolderModalVault}
                            />
                          ))}
                        </div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Name</TableHead>
                              <TableHead>Folder</TableHead>
                              <TableHead>Access</TableHead>
                              <TableHead>Merged view</TableHead>
                              <TableHead className="w-0">
                                <span className="sr-only">Actions</span>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.vaults.map((vault) => {
                              const folder = getVaultFolder(vault.id, vault.name)
                              const vColor = getColorDef(getVaultColor(vault.id))
                              const fColor = getColorDef(getFolderColor(folder))
                              const isFav = isFavorite(vault.id)

                              return (
                                <TableRow key={vault.id}>
                                  <TableCell>
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => toggleFavorite(vault.id)}
                                        aria-label={isFav ? `Unfavorite ${vault.name}` : `Favorite ${vault.name}`}
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
                                      {vColor && (
                                        <span
                                          className={`size-2 rounded-full shrink-0 ${vColor.accent}`}
                                          style={vColor.style?.accent}
                                          title={`Color: ${vColor.label}`}
                                        />
                                      )}
                                      <Link
                                        to={`/vaults/${vault.id}`}
                                        className="font-medium text-foreground hover:underline"
                                      >
                                        {vault.name}
                                      </Link>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <button
                                      type="button"
                                      onClick={() => setFolderModalVault(vault)}
                                      title={folder ? `Folder: ${folder}` : 'Assign folder'}
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
                                    <Pill tone={vault.access === 'owner' ? 'human' : 'neutral'}>
                                      {ACCESS_LABEL[vault.access]}
                                    </Pill>
                                  </TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {vault.mergeable ? 'Included' : 'Excluded'}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {vault.access === 'owner' && <VaultRowActions vault={vault} />}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4 p-2.5 sm:p-4">
              {filteredVaults.map((vault) => (
                <VaultCard
                  key={vault.id}
                  vault={vault}
                  folder={getVaultFolder(vault.id, vault.name)}
                  vaultColor={getVaultColor(vault.id)}
                  folderColor={getFolderColor(getVaultFolder(vault.id, vault.name))}
                  isFavorite={isFavorite(vault.id)}
                  onToggleFavorite={toggleFavorite}
                  onOrganizeFolder={setFolderModalVault}
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
                  <TableHead>Access</TableHead>
                  <TableHead>Merged view</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredVaults.map((vault) => {
                  const folder = getVaultFolder(vault.id, vault.name)
                  const vColor = getColorDef(getVaultColor(vault.id))
                  const fColor = getColorDef(getFolderColor(folder))
                  const isFav = isFavorite(vault.id)

                  return (
                    <TableRow key={vault.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleFavorite(vault.id)}
                            aria-label={isFav ? `Unfavorite ${vault.name}` : `Favorite ${vault.name}`}
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
                          {vColor && (
                            <span
                              className={`size-2 rounded-full shrink-0 ${vColor.accent}`}
                              style={vColor.style?.accent}
                              title={`Color: ${vColor.label}`}
                            />
                          )}
                          <Link
                            to={`/vaults/${vault.id}`}
                            className="font-medium text-foreground hover:underline"
                          >
                            {vault.name}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setFolderModalVault(vault)}
                          title={folder ? `Folder: ${folder}` : 'Assign folder'}
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
                        <Pill tone={vault.access === 'owner' ? 'human' : 'neutral'}>
                          {ACCESS_LABEL[vault.access]}
                        </Pill>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {vault.mergeable ? 'Included' : 'Excluded'}
                      </TableCell>
                      <TableCell className="text-right">
                        {vault.access === 'owner' && <VaultRowActions vault={vault} />}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Trash" />
          <PanelBody dense>
            <VaultTrashSection heading={false} />
          </PanelBody>
        </Panel>
      </div>

      {folderModalVault && (
        <VaultFolderDialog
          key={folderModalVault.id}
          open={Boolean(folderModalVault)}
          onOpenChange={(open) => !open && setFolderModalVault(null)}
          vault={folderModalVault}
          currentFolder={getVaultFolder(folderModalVault.id, folderModalVault.name)}
          currentFolderColor={getFolderColor(
            getVaultFolder(folderModalVault.id, folderModalVault.name),
          )}
          currentVaultColor={getVaultColor(folderModalVault.id)}
          allFolders={allFolders}
          storageMode={storageMode}
          onSave={handleSaveFolder}
        />
      )}

      <Dialog open={storageDialogOpen} onOpenChange={setStorageDialogOpen}>
        <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-md max-h-[90vh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Vault Folders &amp; Group Storage</DialogTitle>
            <DialogDescription>
              Choose whether your vault folders, groups, and color coding are stored on the server or kept only in this browser.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <button
              type="button"
              onClick={() => setStorageMode('online')}
              className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all touch-manipulation ${
                storageMode === 'online'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:bg-muted/40'
              }`}
            >
              <Cloud
                className={`size-5 mt-0.5 shrink-0 ${
                  storageMode === 'online' ? 'text-primary' : 'text-muted-foreground'
                }`}
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground flex items-center gap-2">
                  Online (Cloud Synced)
                  {storageMode === 'online' && (
                    <span className="text-[10px] font-semibold uppercase px-1.5 py-0.2 rounded bg-primary/10 text-primary border border-primary/20">
                      Active
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  Folders, groups, and colors are saved to your Chapters account and automatically stay in sync across your Mac, Windows laptop, and all browsers.
                </span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setStorageMode('local')}
              className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all touch-manipulation ${
                storageMode === 'local'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border hover:bg-muted/40'
              }`}
            >
              <HardDrive
                className={`size-5 mt-0.5 shrink-0 ${
                  storageMode === 'local' ? 'text-amber-500' : 'text-muted-foreground'
                }`}
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground flex items-center gap-2">
                  Local (This Browser Only)
                  {storageMode === 'local' && (
                    <span className="text-[10px] font-semibold uppercase px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                      Active
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  Folders and colors remain strictly in this browser&rsquo;s local storage and are never uploaded or synced to the server.
                </span>
              </div>
            </button>
          </div>

          <div className="flex items-center justify-between pt-2">
            {storageMode === 'online' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => syncNow()}
                disabled={syncStatus === 'syncing'}
                className="gap-1.5 text-xs h-9 sm:h-8"
              >
                <RefreshCw className={`size-3.5 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
                {syncStatus === 'syncing' ? 'Syncing...' : 'Sync Now'}
              </Button>
            ) : (
              <div />
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => setStorageDialogOpen(false)}
              className="h-9 sm:h-8 px-4"
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

