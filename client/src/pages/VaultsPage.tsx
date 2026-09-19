import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  ArrowUpDown,
  Folder,
  LayoutGrid,
  List,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { Button } from '../components/ui/button.js'
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
import { useVaultFolders } from '../components/vault/useVaultFolders.js'
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
 * with folder organization and search/sort filtering.
 */
export function VaultsPage() {
  const vaults = useVaults()
  const navigate = useNavigate()
  const { allFolders, getVaultFolder, setVaultFolder } = useVaultFolders()

  const [creating, setCreating] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem('chapters_vaults_view') as ViewMode) || 'card'
    } catch {
      return 'card'
    }
  })
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
      // Ignore storage errors
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
  }, [vaults.data, search, selectedFolder, accessFilter, sortBy, getVaultFolder])

  const hasActiveFilters = search.trim() !== '' || selectedFolder !== 'all' || accessFilter !== 'all'

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-5">
        <Panel>
          <PanelHeader
            title={
              vaults.data && vaults.data.length > 0 && filteredVaults.length !== vaults.data.length
                ? `Vaults (${filteredVaults.length} of ${vaults.data.length})`
                : 'Vaults'
            }
            actions={
              <div className="flex items-center gap-2">
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
                >
                  <Plus aria-hidden="true" />
                  New vault
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
                    placeholder="Search vaults by name or folder..."
                    aria-label="Search vaults"
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

                {/* Access filter */}
                <select
                  value={accessFilter}
                  onChange={(e) => setAccessFilter(e.target.value)}
                  aria-label="Filter by access"
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="all">All access</option>
                  <option value="owner">Role: Owner</option>
                  <option value="edit">Role: Can edit</option>
                  <option value="read">Role: Read only</option>
                </select>

                {/* Sort */}
                <div className="flex items-center gap-1">
                  <ArrowUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as SortOption)}
                    aria-label="Sort vaults"
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="name-asc">Name (A–Z)</option>
                    <option value="name-desc">Name (Z–A)</option>
                    <option value="access">Access level</option>
                    <option value="merged">Merged view first</option>
                  </select>
                </div>
              </div>

              {/* Folder Filter Tabs / Chips */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-xs">
                <span className="text-muted-foreground font-medium text-[11px] uppercase tracking-wider shrink-0 mr-1">
                  Folders:
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedFolder('all')}
                  className={`px-2.5 py-1 rounded-full border transition-colors shrink-0 ${
                    selectedFolder === 'all'
                      ? 'border-primary bg-primary text-primary-foreground font-medium'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  All ({folderCounts.all})
                </button>

                {folderCounts.uncategorized > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedFolder('uncategorized')}
                    className={`px-2.5 py-1 rounded-full border transition-colors shrink-0 ${
                      selectedFolder === 'uncategorized'
                        ? 'border-primary bg-primary text-primary-foreground font-medium'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                  >
                    Uncategorized ({folderCounts.uncategorized})
                  </button>
                )}

                {allFolders.map((folder) => {
                  const count = folderCounts.byFolder[folder] || 0
                  return (
                    <button
                      key={folder}
                      type="button"
                      onClick={() => setSelectedFolder(folder)}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-full border transition-colors shrink-0 ${
                        selectedFolder === folder
                          ? 'border-primary bg-primary text-primary-foreground font-medium'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted'
                      }`}
                    >
                      <Folder className="size-3" aria-hidden="true" />
                      <span>{folder}</span>
                      <span className="text-[10px] opacity-80">({count})</span>
                    </button>
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
          ) : viewMode === 'card' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
              {filteredVaults.map((vault) => (
                <VaultCard
                  key={vault.id}
                  vault={vault}
                  folder={getVaultFolder(vault.id, vault.name)}
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
                {filteredVaults.map((vault) => {
                  const folder = getVaultFolder(vault.id, vault.name)
                  return (
                    <TableRow key={vault.id}>
                      <TableCell>
                        <Link
                          to={`/vaults/${vault.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {vault.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setFolderModalVault(vault)}
                          title={folder ? `Folder: ${folder}` : 'Assign folder'}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-mono bg-muted/40 hover:bg-muted px-2 py-0.5 rounded border border-border/60 transition-colors"
                        >
                          <Folder className="size-3 text-muted-foreground" aria-hidden="true" />
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
          allFolders={allFolders}
          onSave={setVaultFolder}
        />
      )}
    </div>
  )
}
