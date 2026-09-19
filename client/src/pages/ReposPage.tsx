import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderTree,
  GitBranch,
  LayoutGrid,
  List,
  Plus,
  Search,
  Star,
  X,
} from 'lucide-react'
import { ConnectRepositoryDialog } from '../components/repositories/ConnectRepositoryDialog.js'
import { RepoCard } from '../components/repositories/RepoCard.js'
import { RepoFolderDialog } from '../components/repositories/RepoFolderDialog.js'
import { useRepoFolders } from '../components/repositories/useRepoFolders.js'
import { getColorDef, type VaultColor } from '../components/vault/useVaultFolders.js'
import { Button } from '../components/ui/button.js'
import { PanelState } from '../components/ui/empty-state.js'
import { Panel, PanelHeader } from '../components/ui/panel.js'
import { Pill, type PillTone } from '../components/ui/pill.js'
import { Input } from '../components/ui/input.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js'
import { useShellBreadcrumb } from '../components/shell/shell-context.js'
import { useRepositories } from '../hooks/useRepositories.js'
import {
  syncHealth,
  type AccessibleRepository,
  type IngestionMethod,
  type Repository,
  type SyncHealth,
} from '../api/repositories.js'

const METHOD_LABEL: Record<IngestionMethod, string> = {
  git: 'Git',
  local_path: 'Local folder',
  agent_push: 'Agent push',
}

const HEALTH: Record<SyncHealth, { tone: PillTone; label: string }> = {
  syncing: { tone: 'idle', label: 'Syncing' },
  error: { tone: 'error', label: 'Sync error' },
  'never-synced': { tone: 'neutral', label: 'Never synced' },
  'synced-empty': { tone: 'neutral', label: 'Synced · empty' },
  synced: { tone: 'live', label: 'Synced' },
}

const syncedFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

type ViewMode = 'card' | 'list'
type SortOption = 'synced' | 'name-asc' | 'name-desc' | 'source'

/** `/repos` — what the rail's Repositories item lands on; connect lives here too. */
export function ReposPage() {
  const repositories = useRepositories()
  const navigate = useNavigate()
  const [connecting, setConnecting] = useState(false)
  const [folderModalRepo, setFolderModalRepo] = useState<Repository | null>(null)

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('chapters_repos_view_mode') as ViewMode) || 'card'
  })
  const [groupByFolder, setGroupByFolder] = useState<boolean>(() => {
    return localStorage.getItem('chapters_repos_group_by_folder') === 'true'
  })
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [selectedFolder, setSelectedFolder] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<SortOption>('synced')

  const {
    getRepoFolder,
    getFolderColor,
    getRepoColor,
    setRepoFolder,
    isFavorite,
    toggleFavorite,
    allFolders,
  } = useRepoFolders()

  useShellBreadcrumb([{ label: 'Repositories' }])

  function handleViewModeChange(mode: ViewMode) {
    setViewMode(mode)
    localStorage.setItem('chapters_repos_view_mode', mode)
  }

  function handleToggleGroupByFolder() {
    setGroupByFolder((prev) => {
      const next = !prev
      localStorage.setItem('chapters_repos_group_by_folder', String(next))
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
    repoId: string,
    folder: string,
    repoColor?: VaultColor,
    folderColor?: VaultColor,
  ) {
    setRepoFolder(repoId, folder, repoColor, folderColor)
  }

  // Folder Counts
  const folderCounts = useMemo(() => {
    const list = repositories.data ?? []
    let uncategorized = 0
    const byFolder: Record<string, number> = {}

    for (const r of list) {
      const f = getRepoFolder(r.id)
      if (!f) {
        uncategorized++
      } else {
        byFolder[f] = (byFolder[f] || 0) + 1
      }
    }

    return {
      all: list.length,
      uncategorized,
      byFolder,
    }
  }, [repositories.data, getRepoFolder])

  // Filter & Sort
  const filteredRepos = useMemo(() => {
    if (!repositories.data) return []

    return repositories.data
      .filter((repo) => {
        // Folder shelf filter
        const folder = getRepoFolder(repo.id)
        if (selectedFolder === 'uncategorized' && folder) return false
        if (
          selectedFolder !== 'all' &&
          selectedFolder !== 'uncategorized' &&
          folder.toLowerCase() !== selectedFolder.toLowerCase()
        ) {
          return false
        }

        // Search filter
        if (search.trim()) {
          const q = search.toLowerCase()
          const matchName = repo.name.toLowerCase().includes(q)
          const matchFolder = folder.toLowerCase().includes(q)
          const matchSource = METHOD_LABEL[repo.ingestionMethod].toLowerCase().includes(q)
          if (!matchName && !matchFolder && !matchSource) return false
        }

        // Source filter
        if (sourceFilter !== 'all' && repo.ingestionMethod !== sourceFilter) {
          return false
        }

        return true
      })
      .sort((a, b) => {
        // Favorites first
        const favA = isFavorite(a.id)
        const favB = isFavorite(b.id)
        if (favA && !favB) return -1
        if (!favA && favB) return 1

        switch (sortBy) {
          case 'name-asc':
            return a.name.localeCompare(b.name)
          case 'name-desc':
            return b.name.localeCompare(a.name)
          case 'source':
            return a.ingestionMethod.localeCompare(b.ingestionMethod)
          case 'synced':
          default: {
            const timeA = a.lastSyncedAt ? new Date(a.lastSyncedAt).getTime() : 0
            const timeB = b.lastSyncedAt ? new Date(b.lastSyncedAt).getTime() : 0
            return timeB - timeA
          }
        }
      })
  }, [
    repositories.data,
    getRepoFolder,
    selectedFolder,
    search,
    sourceFilter,
    sortBy,
    isFavorite,
  ])

  // Grouped by Folder
  const groupedRepos = useMemo(() => {
    if (!groupByFolder) return []

    const groups: { folder: string; repos: AccessibleRepository[] }[] = []
    const folderMap = new Map<string, AccessibleRepository[]>()
    const uncategorized: AccessibleRepository[] = []

    for (const repo of filteredRepos) {
      const folder = getRepoFolder(repo.id)
      if (!folder) {
        uncategorized.push(repo)
      } else {
        if (!folderMap.has(folder)) {
          folderMap.set(folder, [])
        }
        folderMap.get(folder)!.push(repo)
      }
    }

    const sortedFolders = Array.from(folderMap.keys()).sort((a, b) =>
      a.localeCompare(b),
    )
    for (const f of sortedFolders) {
      groups.push({ folder: f, repos: folderMap.get(f)! })
    }

    if (uncategorized.length > 0) {
      groups.push({ folder: 'Uncategorized', repos: uncategorized })
    }

    return groups
  }, [groupByFolder, filteredRepos, getRepoFolder])

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[80%] flex-col gap-4 px-4 py-5">
        <Panel>
          <PanelHeader
            title={
              repositories.data && repositories.data.length > 0
                ? `Repositories (${filteredRepos.length} of ${repositories.data.length})`
                : 'Repositories'
            }
            actions={
              <div className="flex items-center gap-2">
                {/* Group by Folder Toggle */}
                {repositories.data && repositories.data.length > 0 && (
                  <Button
                    type="button"
                    size="xs"
                    variant={groupByFolder ? 'secondary' : 'ghost'}
                    onClick={handleToggleGroupByFolder}
                    title="Group by folder"
                    aria-label="Group by folder"
                    className="gap-1 text-xs"
                  >
                    <FolderTree className="size-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">Group</span>
                  </Button>
                )}

                {/* Card vs List View Toggle */}
                {repositories.data && repositories.data.length > 0 && (
                  <div
                    className="flex items-center rounded-md border border-border bg-muted/40 p-0.5"
                    role="group"
                    aria-label="View mode"
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
                )}

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConnecting(true)}
                >
                  <Plus aria-hidden="true" />
                  Connect a repository
                </Button>
              </div>
            }
          />

          {/* Search, Filter, and Sort Toolbar */}
          {repositories.data && repositories.data.length > 0 && (
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
                    placeholder="Search repositories by name, folder, or source..."
                    aria-label="Search repositories"
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

                {/* Source filter */}
                <select
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  aria-label="Filter by source"
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="all">All sources</option>
                  <option value="git">Git</option>
                  <option value="local_path">Local folder</option>
                  <option value="agent_push">Agent push</option>
                </select>

                {/* Sort */}
                <div className="flex items-center gap-1">
                  <ArrowUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortOption)}
                    aria-label="Sort repositories"
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="synced">Last synced</option>
                    <option value="name-asc">Name (A–Z)</option>
                    <option value="name-desc">Name (Z–A)</option>
                    <option value="source">Source</option>
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
                        className={`h-1.5 w-6 rounded-t-sm border-t border-x transition-colors ${
                          isSelected
                            ? 'bg-primary border-primary'
                            : colorDef
                              ? colorDef.folderTab
                              : 'bg-muted/60 border-border'
                        }`}
                        style={!isSelected ? colorDef?.style?.folderTab : undefined}
                      />
                      <button
                        type="button"
                        onClick={() => setSelectedFolder(folder)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-b-md rounded-tr-md border transition-colors ${
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground font-medium'
                            : colorDef
                              ? colorDef.folderTab
                              : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
                        }`}
                        style={!isSelected ? colorDef?.style?.folderTab : undefined}
                      >
                        <Folder
                          className={`size-3 ${
                            isSelected
                              ? 'text-primary-foreground'
                              : colorDef
                                ? colorDef.folderIcon
                                : 'text-muted-foreground'
                          }`}
                          style={!isSelected ? colorDef?.style?.folderIcon : undefined}
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

          {repositories.isError ? (
            <PanelState
              status="error"
              title="We couldn’t load your repositories."
              message={repositories.error.message}
              onRetry={() => repositories.refetch()}
            />
          ) : repositories.isPending ? (
            <PanelState status="loading" />
          ) : repositories.data.length === 0 ? (
            <PanelState
              status="empty"
              title="No repositories yet"
              message="Connect one and its files join the graph beside your notes. Chapters never writes code back — git stays the record of truth."
            />
          ) : filteredRepos.length === 0 ? (
            <PanelState
              status="empty"
              title="No matching repositories"
              message="Try adjusting your search query or folder filter."
            />
          ) : groupByFolder ? (
            /* Grouped View with Folder Ears and Styling */
            <div className="flex flex-col gap-6 p-4">
              {groupedRepos.map((group) => {
                const colorDef = getColorDef(getFolderColor(group.folder))
                const isCollapsed = Boolean(collapsedFolders[group.folder])

                return (
                  <div key={group.folder} className="flex flex-col">
                    {/* Folder Header with Tab Ear */}
                    <div className="flex items-end">
                      <div className="relative inline-flex flex-col items-start">
                        <div
                          className={`h-2 w-8 rounded-t-md border-t border-x transition-colors ${
                            colorDef ? colorDef.folderTab : 'bg-muted/80 border-border'
                          }`}
                          style={colorDef?.style?.folderTab}
                        />
                        <button
                          type="button"
                          onClick={() => toggleFolderCollapse(group.folder)}
                          aria-label={`Toggle folder ${group.folder}`}
                          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-b-md rounded-tr-md border text-xs font-medium transition-colors ${
                            colorDef
                              ? colorDef.folderTab
                              : 'border-border bg-muted/40 text-foreground hover:bg-muted'
                          }`}
                          style={colorDef?.style?.folderTab}
                        >
                          {isCollapsed ? (
                            <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                          ) : (
                            <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                          )}
                          <Folder
                            className={`size-3.5 shrink-0 ${
                              colorDef ? colorDef.folderIcon : 'text-muted-foreground'
                            }`}
                            style={colorDef?.style?.folderIcon}
                            aria-hidden="true"
                          />
                          <span>{group.folder}</span>
                          <span className="text-[10px] opacity-75">
                            ({group.repos.length})
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
                          {group.repos.map((repo) => (
                            <RepoCard
                              key={repo.id}
                              repo={repo}
                              folder={getRepoFolder(repo.id)}
                              repoColor={getRepoColor(repo.id)}
                              folderColor={getFolderColor(getRepoFolder(repo.id))}
                              isFavorite={isFavorite(repo.id)}
                              onToggleFavorite={toggleFavorite}
                              onOrganizeFolder={setFolderModalRepo}
                            />
                          ))}
                        </div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Name</TableHead>
                              <TableHead>Folder</TableHead>
                              <TableHead>Source</TableHead>
                              <TableHead>Sync</TableHead>
                              <TableHead>Last synced</TableHead>
                              <TableHead>Access</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.repos.map((repo) => {
                              const folder = getRepoFolder(repo.id)
                              const rColor = getColorDef(getRepoColor(repo.id))
                              const fColor = getColorDef(getFolderColor(folder))
                              const isFav = isFavorite(repo.id)
                              const health = HEALTH[syncHealth(repo)]

                              return (
                                <TableRow key={repo.id}>
                                  <TableCell>
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => toggleFavorite(repo.id)}
                                        aria-label={
                                          isFav
                                            ? `Unfavorite ${repo.name}`
                                            : `Favorite ${repo.name}`
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
                                      {rColor && (
                                        <span
                                          className={`size-2 rounded-full shrink-0 ${rColor.accent}`}
                                          style={rColor.style?.accent}
                                          title={`Color: ${rColor.label}`}
                                        />
                                      )}
                                      <Link
                                        to={`/repos/${repo.id}/files`}
                                        className="font-medium text-foreground hover:underline flex items-center gap-1.5"
                                      >
                                        <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
                                        <span>{repo.name}</span>
                                      </Link>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <button
                                      type="button"
                                      onClick={() => setFolderModalRepo(repo)}
                                      title={folder ? `Folder: ${folder}` : 'Assign folder'}
                                      aria-label={
                                        folder
                                          ? `Folder: ${folder} for ${repo.name}`
                                          : `Assign folder for ${repo.name}`
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
                                  <TableCell className="text-muted-foreground">
                                    {METHOD_LABEL[repo.ingestionMethod]}
                                  </TableCell>
                                  <TableCell>
                                    <Pill tone={health.tone} dot>
                                      {health.label}
                                    </Pill>
                                  </TableCell>
                                  <TableCell className="font-mono text-xs text-muted-foreground">
                                    {repo.lastSyncedAt
                                      ? syncedFormatter.format(new Date(repo.lastSyncedAt))
                                      : '—'}
                                  </TableCell>
                                  <TableCell>
                                    <Pill tone={repo.access === 'owner' ? 'human' : 'neutral'}>
                                      {repo.access === 'owner' ? 'Owner' : 'Viewer'}
                                    </Pill>
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
              {filteredRepos.map((repo) => (
                <RepoCard
                  key={repo.id}
                  repo={repo}
                  folder={getRepoFolder(repo.id)}
                  repoColor={getRepoColor(repo.id)}
                  folderColor={getFolderColor(getRepoFolder(repo.id))}
                  isFavorite={isFavorite(repo.id)}
                  onToggleFavorite={toggleFavorite}
                  onOrganizeFolder={setFolderModalRepo}
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
                  <TableHead>Source</TableHead>
                  <TableHead>Sync</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead>Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRepos.map((repo) => {
                  const folder = getRepoFolder(repo.id)
                  const rColor = getColorDef(getRepoColor(repo.id))
                  const fColor = getColorDef(getFolderColor(folder))
                  const isFav = isFavorite(repo.id)
                  const health = HEALTH[syncHealth(repo)]

                  return (
                    <TableRow key={repo.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleFavorite(repo.id)}
                            aria-label={
                              isFav
                                ? `Unfavorite ${repo.name}`
                                : `Favorite ${repo.name}`
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
                          {rColor && (
                            <span
                              className={`size-2 rounded-full shrink-0 ${rColor.accent}`}
                              style={rColor.style?.accent}
                              title={`Color: ${rColor.label}`}
                            />
                          )}
                          <Link
                            to={`/repos/${repo.id}/files`}
                            className="font-medium text-foreground hover:underline flex items-center gap-1.5"
                          >
                            <GitBranch className="size-3.5 text-muted-foreground" aria-hidden="true" />
                            <span>{repo.name}</span>
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setFolderModalRepo(repo)}
                          title={folder ? `Folder: ${folder}` : 'Assign folder'}
                          aria-label={
                            folder
                              ? `Folder: ${folder} for ${repo.name}`
                              : `Assign folder for ${repo.name}`
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
                      <TableCell className="text-muted-foreground">
                        {METHOD_LABEL[repo.ingestionMethod]}
                      </TableCell>
                      <TableCell>
                        <Pill tone={health.tone} dot>
                          {health.label}
                        </Pill>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {repo.lastSyncedAt
                          ? syncedFormatter.format(new Date(repo.lastSyncedAt))
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Pill tone={repo.access === 'owner' ? 'human' : 'neutral'}>
                          {repo.access === 'owner' ? 'Owner' : 'Viewer'}
                        </Pill>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>

      <RepoFolderDialog
        open={folderModalRepo !== null}
        onOpenChange={(open) => {
          if (!open) setFolderModalRepo(null)
        }}
        repo={folderModalRepo}
        currentFolder={folderModalRepo ? getRepoFolder(folderModalRepo.id) : ''}
        currentFolderColor={
          folderModalRepo
            ? getFolderColor(getRepoFolder(folderModalRepo.id))
            : undefined
        }
        currentRepoColor={
          folderModalRepo ? getRepoColor(folderModalRepo.id) : undefined
        }
        allFolders={allFolders}
        onSave={handleSaveFolder}
      />

      <ConnectRepositoryDialog
        open={connecting}
        onOpenChange={setConnecting}
        onConnected={(created) => navigate(`/repos/${created.id}/files`)}
      />
    </div>
  )
}
