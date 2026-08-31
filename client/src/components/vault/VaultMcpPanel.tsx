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
import { useCreateMcpConnection, useMcpConnections, useRevokeMcpConnection } from '../../hooks/useMcpConnections.js'
import type { McpConnection, McpTarget } from '../../api/mcp.js'

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
  },
  account: {
    blurb:
      'A connection lets an MCP client (Claude, or any other agent) reach this account with its own token — every vault and repository the account can reach, not one vault.',
    empty: 'No account-wide MCP connections yet.',
    loadError: 'Could not load your account-wide MCP connections. Try again.',
    createError: 'Could not create an account-wide connection.',
    reach: 'loses access to every vault and repository this account can reach, on its next request',
  },
} as const

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString()
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
    <TableRow>
      <TableCell className="max-w-44 truncate text-foreground">{connection.name}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{connection.scope}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {formatTimestamp(connection.createdAt)}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {connection.lastUsedAt ? formatTimestamp(connection.lastUsedAt) : 'Never used'}
      </TableCell>
      <TableCell className="text-right align-top">
        {confirming ? (
          // The consequence stays inside the row it is about — the design
          // system's inline confirmation, not a dialog.
          <div className="ml-auto flex w-60 flex-col gap-1 py-1 text-left whitespace-normal">
            <p className="text-xs text-muted-foreground">
              Revoke {connection.name}? Any agent using this token {reach}. This cannot be undone.
            </p>
            <div className="flex items-center gap-1">
              <Button type="button" size="xs" variant="destructive" onClick={handleRevoke} disabled={revoke.isPending}>
                Revoke
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
            <FormError message={error} />
          </div>
        ) : (
          <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

function CreateMcpConnectionForm({ target, onCreated }: { target: McpTarget; onCreated: (token: string, name: string) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createConnection = useCreateMcpConnection(target)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setError(null)
    createConnection.mutate(trimmed, {
      onSuccess: (connection) => {
        onCreated(connection.token, connection.name)
        setName('')
      },
      onError: (err) => setError(err.message || COPY[target.scope].createError),
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
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
 */
export function McpPanel(target: McpTarget) {
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
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Revoke</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.map((connection) => (
                <McpConnectionRow key={connection.id} connection={connection} reach={copy.reach} />
              ))}
            </TableBody>
          </Table>
        )}

        <CreateMcpConnectionForm target={target} onCreated={(token, name) => setRevealed({ token, name })} />
      </PanelBody>
    </Panel>
  )
}

/** The vault settings modal's existing call site, unchanged. */
export function VaultMcpPanel({ vaultId }: { vaultId: string }) {
  return <McpPanel scope="vault" vaultId={vaultId} />
}
