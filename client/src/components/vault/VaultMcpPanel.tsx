import { useState } from 'react'
import type { FormEvent } from 'react'
import { Input } from '../ui/input.js'
import { Button } from '../ui/button.js'
import { Label } from '../ui/label.js'
import { SecretReveal } from '../ui/SecretReveal.js'
import { FormError } from '../FormError.js'
import { useCreateVaultMcpConnection, useMcpConnections, useRevokeMcpConnection } from '../../hooks/useMcpConnections.js'
import type { McpConnection } from '../../api/mcp.js'

interface VaultMcpPanelProps {
  vaultId: string
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString()
}

function McpConnectionRow({ connection }: { connection: McpConnection }) {
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
    <li className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-foreground">{connection.name}</div>
          <div className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
            <span>Created {formatTimestamp(connection.createdAt)}</span>
            <span>{connection.lastUsedAt ? `Last used ${formatTimestamp(connection.lastUsedAt)}` : 'Never used'}</span>
          </div>
        </div>
        {!confirming && (
          <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            Revoke {connection.name}? Any agent using this token loses access to this vault on its next request. This
            cannot be undone.
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
      )}
    </li>
  )
}

function CreateMcpConnectionForm({ vaultId, onCreated }: { vaultId: string; onCreated: (token: string, name: string) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const createConnection = useCreateVaultMcpConnection(vaultId)

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
      onError: (err) => setError(err.message || 'Could not create a connection for this vault.'),
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

export function VaultMcpPanel({ vaultId }: VaultMcpPanelProps) {
  const connectionsQuery = useMcpConnections()
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null)

  const connections = (connectionsQuery.data ?? []).filter(
    (c) => c.scope === 'vault' && c.vaultId === vaultId && c.revokedAt === null,
  )

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-display text-base text-foreground">MCP connections</h3>
      <p className="text-xs text-muted-foreground">
        A connection lets an MCP client (Claude, or any other agent) reach this vault with its own token, scoped to
        this vault only.
      </p>

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
          Could not load this vault's MCP connections. Try again.
        </p>
      ) : connectionsQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      ) : connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No MCP connections for this vault yet.</p>
      ) : (
        <ul>
          {connections.map((connection) => (
            <McpConnectionRow key={connection.id} connection={connection} />
          ))}
        </ul>
      )}

      <CreateMcpConnectionForm vaultId={vaultId} onCreated={(token, name) => setRevealed({ token, name })} />
    </section>
  )
}
