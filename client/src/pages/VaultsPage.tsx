import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Plus } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { PanelState } from '../components/ui/empty-state.js'
import { Panel, PanelBody, PanelHeader } from '../components/ui/panel.js'
import { Pill } from '../components/ui/pill.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js'
import { NewVaultForm } from '../components/vault/NewVaultForm.js'
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

/**
 * `/vaults` — every vault this person can reach, as a table. A list, not a
 * dashboard: Home stays the graph (spec decision 1); this is where the rail's
 * Vaults item lands and where a vault gets created, renamed or trashed.
 */
export function VaultsPage() {
  const vaults = useVaults()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  useShellBreadcrumb([{ label: 'Vaults' }])

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
        <Panel>
          <PanelHeader
            title="Vaults"
            actions={
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
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Merged view</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vaults.data.map((vault) => (
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
                      <Pill
                        tone={vault.access === 'owner' ? 'human' : 'neutral'}
                      >
                        {ACCESS_LABEL[vault.access]}
                      </Pill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {vault.mergeable ? 'Included' : 'Excluded'}
                    </TableCell>
                    <TableCell className="text-right">
                      {vault.access === 'owner' && (
                        <VaultRowActions vault={vault} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
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
    </div>
  )
}
