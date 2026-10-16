import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Button } from '../ui/button.js'
import { Label } from '../ui/label.js'
import { Panel, PanelBody, PanelHeader } from '../ui/panel.js'
import { SecretReveal } from '../ui/SecretReveal.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js'
import { FormError } from '../FormError.js'
import {
  useCreateMcpConnection,
  useMcpConnections,
  useMcpTools,
  useRevokeMcpConnection,
} from '../../hooks/useMcpConnections.js'
import type { McpAccess, McpConnection, McpTarget, McpToolInfo } from '../../api/mcp.js'
import type { VaultAccess } from '../../api/vaults.js'

// Native <select>, same as the sharing panels — no shadcn select is installed.
const selectClassName =
  'h-9 sm:h-8 rounded-lg border border-input bg-transparent px-2 text-sm sm:text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

const ACCESS_RANK: Record<McpAccess, number> = { read: 0, write: 1, admin: 2 }
const ACCESS_LEVELS: McpAccess[] = ['read', 'write', 'admin']
// The API refuses a vault token above its minter's permission on the vault (#649).
const MAX_ACCESS_FOR_VAULT: Record<VaultAccess, McpAccess> = { owner: 'admin', edit: 'write', read: 'read' }
const ACCESS_LABEL: Record<McpAccess, string> = {
  read: 'Read only',
  write: 'Read and write',
  admin: 'Admin: also share, change settings, delete, purge',
}
// Days until the token stops working; 0 = never.
const EXPIRY_PRESETS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 0, label: 'Never' },
] as const

/** The expiry instant for a preset, read from the clock when the form is submitted. */
function expiresAtAfter(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

// Tools a vault-pinned token can reach at all; account-only tools would always be refused.
const VAULT_TOOL_SCOPES: Partial<Record<McpToolInfo['scope'], true>> = { vault: true, 'vault-or-account': true, 'vault-or-repo': true }

/**
 * Copy differs by scope because the blast radius does: a vault-scoped token
 * reaches one vault, an account-scoped token reaches everything the account
 * can reach. The revoke confirmation has to say which.
 */
const COPY = {
  vault: {
    blurb:
      'A connection lets an MCP client (Claude, or any other agent) reach this vault with its own token, scoped to this vault only.',
    empty: 'No MCP connections for this vault yet.',
    loadError: "Could not load this vault's MCP connections. Try again.",
    createError: 'Could not create a connection for this vault.',
    reach: 'loses access to this vault on its next request',
    // The token is pinned to this vault: admin lets it act on the vault itself.
    adminWarning:
      'Admin lets this token share this vault, revoke its shares, change its settings, move it to the trash, purge notes and erase history. Only you, the owner, can grant it, and only now. Grant it only to an agent you trust with all of that.',
    defaultAccess: 'write' as McpAccess,
  },
  account: {
    blurb:
      'A connection lets an MCP client (Claude, or any other agent) reach this account with its own token — every vault and repository the account can reach, not one vault.',
    empty: 'No account-wide MCP connections yet.',
    loadError: 'Could not load your account-wide MCP connections. Try again.',
    createError: 'Could not create an account-wide connection.',
    reach: 'loses access to every vault and repository this account can reach, on its next request',
    adminWarning: null,
    // The form always sends a level; the API's admin default for an omitted one is not used here.
    defaultAccess: 'write' as McpAccess,
  },
} as const

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString()
}

function expiryText(expiresAt: string | null): string {
  if (!expiresAt) return 'Never'
  return new Date(expiresAt) <= new Date() ? `Expired ${formatTimestamp(expiresAt)}` : formatTimestamp(expiresAt)
}

function McpConnectionRow({ connection, reach }: { connection: McpConnection; reach: string }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = useRevokeMcpConnection()

  function handleRevoke() {
    setError(null)
    revoke.mutate(connection.id, {
      onSuccess: () => setConfirming(false),
      onError: (err) => setError(err.message || 'Could not revoke this connection.'),
    })
  }

  return (
    <TableRow className="block sm:table-row p-3 sm:p-0 space-y-1.5 sm:space-y-0 align-top border-b border-border last:border-b-0">
      <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2.5 max-w-full sm:max-w-44 text-foreground font-medium sm:font-normal h-auto whitespace-normal break-all">
        {connection.name}
      </TableCell>
      <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2.5 font-mono text-xs text-muted-foreground h-auto">
        <span className="sm:hidden font-mono text-muted-foreground/70">Scope: </span>
        {connection.scope}
      </TableCell>
      <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2.5 font-mono text-xs text-muted-foreground h-auto whitespace-normal">
        <span className="sm:hidden font-mono text-muted-foreground/70">Access: </span>
        {connection.access}
        <span className="block break-words">
          {connection.allowedTools ? `only ${connection.allowedTools.join(', ')}` : 'all tools'}
        </span>
      </TableCell>
      <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2.5 font-mono text-xs text-muted-foreground h-auto">
        <span className="sm:hidden font-mono text-muted-foreground/70">Expires: </span>
        {expiryText(connection.expiresAt)}
      </TableCell>
      <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2.5 font-mono text-xs text-muted-foreground h-auto">
        <span className="sm:hidden font-mono text-muted-foreground/70">Created: </span>
        {formatTimestamp(connection.createdAt)}
      </TableCell>
      <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2.5 font-mono text-xs text-muted-foreground h-auto">
        <span className="sm:hidden font-mono text-muted-foreground/70">Last used: </span>
        {connection.lastUsedAt ? formatTimestamp(connection.lastUsedAt) : 'Never used'}
      </TableCell>
      <TableCell className="block sm:table-cell p-0 sm:px-3 sm:py-2 sm:text-right align-top w-full sm:w-24 shrink-0 h-auto pt-1 sm:pt-2">
        {confirming ? (
          // The consequence stays inside the row it is about — the design
          // system's inline confirmation, not a dialog.
          <div className="ml-auto flex w-full sm:w-60 flex-col gap-1 py-1 text-left whitespace-normal">
            <p className="text-xs text-muted-foreground">
              Revoke {connection.name}? Any agent using this token {reach}. This cannot be undone.
            </p>
            <div className="flex items-center gap-1">
              <Button type="button" size="xs" variant="destructive" className="min-h-[32px] sm:min-h-0 touch-manipulation" onClick={handleRevoke} disabled={revoke.isPending}>
                Revoke
              </Button>
              <Button type="button" size="xs" variant="ghost" className="min-h-[32px] sm:min-h-0 touch-manipulation" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
            <FormError message={error} />
          </div>
        ) : (
          <Button type="button" size="xs" variant="ghost" className="whitespace-nowrap min-h-[32px] sm:min-h-0 touch-manipulation" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

function CreateMcpConnectionForm({
  target,
  maxAccess,
  onCreated,
}: {
  target: McpTarget
  maxAccess: McpAccess
  onCreated: (token: string, name: string) => void
}) {
  const copy = COPY[target.scope]
  const [name, setName] = useState('')
  // Levels above what the API grants this user are not offered.
  const levels = ACCESS_LEVELS.filter((level) => ACCESS_RANK[level] <= ACCESS_RANK[maxAccess])
  const [access, setAccess] = useState<McpAccess>(
    ACCESS_RANK[copy.defaultAccess] <= ACCESS_RANK[maxAccess] ? copy.defaultAccess : maxAccess,
  )
  const [expiryDays, setExpiryDays] = useState(0)
  const [limitTools, setLimitTools] = useState(false)
  const [allowedTools, setAllowedTools] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const createConnection = useCreateMcpConnection(target)
  const toolsQuery = useMcpTools(limitTools)

  // Tools this token could call at all: within its access level and its scope.
  const offered = (toolsQuery.data ?? []).filter(
    (t) => ACCESS_RANK[t.capability] <= ACCESS_RANK[access] && (target.scope === 'account' || VAULT_TOOL_SCOPES[t.scope] === true),
  )

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const tools = limitTools ? allowedTools.filter((t) => offered.some((o) => o.name === t)) : []
    if (limitTools && tools.length === 0) {
      setError('Pick at least one tool, or stop limiting the tools.')
      return
    }
    setError(null)
    createConnection.mutate(
      {
        name: trimmed,
        access,
        ...(limitTools ? { allowedTools: tools } : {}),
        ...(expiryDays ? { expiresAt: expiresAtAfter(expiryDays) } : {}),
      },
      {
        onSuccess: (connection) => {
          onCreated(connection.token, connection.name)
          setName('')
          setAllowedTools([])
        },
        onError: (err) => setError(err.message || copy.createError),
      },
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex flex-1 flex-col gap-1">
        <Label htmlFor="mcp-connection-name">New connection</Label>
        <Input
          id="mcp-connection-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          placeholder="Claude"
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="mcp-connection-access">Access</Label>
          <select
            id="mcp-connection-access"
            className={selectClassName}
            value={access}
            onChange={(e) => setAccess(e.target.value as McpAccess)}
          >
            {levels.map((level) => (
              <option key={level} value={level}>
                {ACCESS_LABEL[level]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="mcp-connection-expiry">Expires after</Label>
          <select
            id="mcp-connection-expiry"
            className={selectClassName}
            value={expiryDays}
            onChange={(e) => setExpiryDays(Number(e.target.value))}
          >
            {EXPIRY_PRESETS.map((preset) => (
              <option key={preset.days} value={preset.days}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {access === 'admin' && copy.adminWarning && (
        <p role="alert" className="rounded-lg border border-destructive/40 p-2 text-xs text-destructive">
          {copy.adminWarning}
        </p>
      )}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-primary touch-manipulation"
          checked={limitTools}
          onChange={(e) => setLimitTools(e.target.checked)}
        />
        Limit this token to specific tools
      </label>
      {limitTools && (
        <fieldset className="flex flex-col gap-1 rounded-lg border border-border p-2">
          <legend className="px-1 text-xs text-muted-foreground">Allowed tools</legend>
          {toolsQuery.isError ? (
            <p role="alert" className="text-xs text-destructive">
              Could not load the tool list. Try again.
            </p>
          ) : toolsQuery.isPending ? (
            <p className="text-xs text-muted-foreground">Loading tools…</p>
          ) : (
            <div className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
              {offered.map((t) => (
                <label key={t.name} className="flex items-center gap-2 font-mono text-xs text-foreground">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary touch-manipulation"
                    checked={allowedTools.includes(t.name)}
                    onChange={(e) => {
                      const { checked } = e.target
                      setAllowedTools((current) => (checked ? [...current, t.name] : current.filter((n) => n !== t.name)))
                    }}
                  />
                  {t.name}
                  <span className="text-muted-foreground">({t.capability})</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <div>
        <Button type="submit" disabled={createConnection.isPending}>
          Create
        </Button>
      </div>
      <FormError message={error} />
    </form>
  )
}

/**
 * One list, two scopes. The account-wide settings list and the vault settings
 * list are literally this component — only the target and the copy differ.
 * `maxAccess`, the highest level offered, defaults to admin for the account
 * scope and write for a vault.
 */
export function McpPanel(props: McpTarget & { maxAccess?: McpAccess }) {
  // Only the target goes into the create request, never the panel's own props.
  const target: McpTarget = props.scope === 'vault' ? { scope: 'vault', vaultId: props.vaultId } : { scope: 'account' }
  const connectionsQuery = useMcpConnections()
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null)
  const copy = COPY[target.scope]

  const connections = (connectionsQuery.data ?? []).filter((c) =>
    c.revokedAt === null &&
    (target.scope === 'vault' ? c.scope === 'vault' && c.vaultId === target.vaultId : c.scope === 'account'),
  )

  return (
    <Panel>
      <PanelHeader title="MCP connections" titleAs="h3" />
      <PanelBody className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{copy.blurb}</p>

        {revealed && (
          <SecretReveal
            label={`Token for "${revealed.name}"`}
            secret={revealed.token}
            note="Paste it into the MCP client's config now."
            onDismiss={() => setRevealed(null)}
          />
        )}

        {connectionsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {copy.loadError}
          </p>
        ) : connectionsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading connections…</p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{copy.empty}</p>
        ) : (
          <Table>
            <TableHeader className="hidden sm:table-header-group">
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right w-24 shrink-0">
                  <span className="sr-only">Revoke</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="block sm:table-row-group divide-y divide-border sm:divide-y-0">
              {connections.map((connection) => (
                <McpConnectionRow key={connection.id} connection={connection} reach={copy.reach} />
              ))}
            </TableBody>
          </Table>
        )}

        <CreateMcpConnectionForm
          target={target}
          maxAccess={props.maxAccess ?? (target.scope === 'account' ? 'admin' : 'write')}
          onCreated={(token, name) => setRevealed({ token, name })}
        />
      </PanelBody>
    </Panel>
  )
}

/** The vault settings modal's call site: a token gets at most the user's own permission on the vault. */
export function VaultMcpPanel({ vaultId, access }: { vaultId: string; access: VaultAccess }) {
  return <McpPanel scope="vault" vaultId={vaultId} maxAccess={MAX_ACCESS_FOR_VAULT[access]} />
}
