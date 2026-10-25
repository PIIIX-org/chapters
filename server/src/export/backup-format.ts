import { createHash } from 'node:crypto'
import { getTableColumns, type Column, type SQL } from 'drizzle-orm'
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core'
import {
  graphPerspectives,
  instanceState,
  mcpConnections,
  mfaBackupCodes,
  noteRevisions,
  notes,
  notifications,
  repositories,
  repositoryGraphPreferences,
  repositoryShares,
  repositorySyncTokens,
  securityEvents,
  teamMemberships,
  teams,
  userVaultPreferences,
  users,
  vaultGraphPreferences,
  vaultShares,
  vaults,
} from '../db/schema.js'
import { revisionBody } from '../notes/store-tx.js'

/**
 * Instance backup archive format (#409).
 * 1: `account-dump.json` with eight account tables plus the live note files.
 * 2: `backup.json` + one `db/<table>.jsonl` per table below + note, trash and
 *    attachment files under `vaults/<id>/{notes,trash,assets}/`. Since #493
 *    `backup.json` also has `parts`: every other entry's SHA-256 and size,
 *    checked before a restore writes anything (an archive without it restores
 *    with a warning).
 */
export const BACKUP_FORMAT = 2
export const BACKUP_MANIFEST = 'backup.json'
export const LEGACY_DUMP = 'account-dump.json'

export type Row = Record<string, unknown>

/** One archive entry as `backup.json` records it (#493). */
export interface BackupPart {
  /** Hex SHA-256 of the entry's uncompressed bytes. */
  sha256: string
  size: number
}

export const partOf = (data: Buffer): BackupPart => ({ sha256: createHash('sha256').update(data).digest('hex'), size: data.length })

export interface BackupTable {
  /** SQL table name; the rows are `db/<name>.jsonl`. */
  name: string
  table: PgTable
  /** Derived columns left out of the archive and rebuilt after a restore. */
  omit?: string[]
  /** Unique keys besides the primary key, checked against existing rows before a restore. `liveOnly`: only rows not in the trash. */
  unique?: Array<{ columns: string[]; liveOnly?: true }>
  /** Key of this table in a format-1 `account-dump.json`. */
  legacyKey?: string
  /** Applied to each row before it is inserted. */
  onRestore?: (row: Row) => Row
  /** Columns the archive holds as these expressions of the stored row (a value rebuilt from columns kept out of the model). */
  dumped?: Record<string, SQL>
  /**
   * JS key of a column numbered from a sequence in the order rows were
   * recorded (#825, #858). A restore keeps the archive's numbers, numbers rows
   * of an archive from before the column in (created_at, id) order, and
   * advances the sequence past them.
   */
  sequence?: string
}

/**
 * Every table an instance backup carries, parents before children (the
 * insert order). Left out on purpose: `sessions` and `email_tokens`
 * (short-lived credentials: people sign in again), `export_links` (expiring
 * download links), `note_links` (rebuilt from note bodies), `semantic_edges`
 * and every embedding (rebuilt on boot), `repository_files`, `_imports` and
 * `blocks` (an index of the repository's source: the next sync rebuilds it;
 * a note's blocks are its embeddings: boot catch-up re-embeds every restored
 * note, #452),
 * `write_idempotency` (MCP write answers kept 24 h for retries, #477),
 * `note_reads` (each MCP connection's last read of a note, kept 24 h, #408).
 */
export const BACKUP_TABLES: BackupTable[] = [
  { name: 'users', table: users, unique: [{ columns: ['email'] }], legacyKey: 'users' },
  { name: 'mfa_backup_codes', table: mfaBackupCodes, unique: [{ columns: ['codeHash'] }] },
  { name: 'teams', table: teams, legacyKey: 'teams' },
  { name: 'team_memberships', table: teamMemberships, legacyKey: 'teamMemberships' },
  { name: 'vaults', table: vaults, legacyKey: 'vaults' },
  {
    name: 'vault_shares',
    table: vaultShares,
    unique: [{ columns: ['vaultId', 'granteeType', 'granteeId'] }],
    legacyKey: 'vaultShares',
  },
  { name: 'vault_graph_preferences', table: vaultGraphPreferences },
  { name: 'user_vault_preferences', table: userVaultPreferences },
  { name: 'graph_perspectives', table: graphPerspectives },
  {
    name: 'repositories',
    table: repositories,
    // The file index is not in the archive. Without a last sync the next
    // git sync can't skip an unchanged remote commit, and without a webhook
    // time the poller picks the repository up at once (shouldPoll). The
    // indexed version goes with the index (#471).
    onRestore: (row) => ({
      ...row,
      syncStatus: 'idle',
      lastSyncedAt: null,
      lastSyncedCommit: null,
      treeHash: null,
      lastSyncError: null,
      lastWebhookAt: null,
    }),
  },
  {
    name: 'repository_shares',
    table: repositoryShares,
    unique: [{ columns: ['repositoryId', 'granteeType', 'granteeId'] }],
  },
  { name: 'repository_graph_preferences', table: repositoryGraphPreferences },
  { name: 'repository_sync_tokens', table: repositorySyncTokens, unique: [{ columns: ['tokenHash'] }] },
  { name: 'mcp_connections', table: mcpConnections, unique: [{ columns: ['tokenHash'] }], legacyKey: 'mcpConnections' },
  { name: 'security_events', table: securityEvents, legacyKey: 'securityEvents', sequence: 'seq' },
  { name: 'notifications', table: notifications, legacyKey: 'notifications' },
  { name: 'notes', table: notes, unique: [{ columns: ['vaultId', 'path'], liveOnly: true }] },
  // Every body whole (#501): a compacted revision's delta is not in the archive, which any release restores.
  { name: 'note_revisions', table: noteRevisions, sequence: 'ord', dumped: { body: revisionBody } },
]

/** The setup/MFA-mandate row: restored by hand, never with the setup token. */
export const INSTANCE_STATE: BackupTable = { name: 'instance_state', table: instanceState, omit: ['setupTokenHash'] }

export const tableEntry = (name: string): string => `db/${name}.jsonl`
export const noteEntry = (vaultId: string, path: string): string => `vaults/${vaultId}/notes/${path}.md`
export const trashEntry = (vaultId: string, noteId: string): string => `vaults/${vaultId}/trash/${noteId}.md`
export const assetEntry = (vaultId: string, fileName: string): string => `vaults/${vaultId}/assets/${fileName}`

/** JS key -> column, minus the omitted ones. */
export function backupColumns(spec: BackupTable): Record<string, PgColumn> {
  // A PgTable's columns are PgColumns; the generic TableConfig only types them as Column.
  const columns = getTableColumns(spec.table) as Record<string, PgColumn>
  return Object.fromEntries(Object.entries(columns).filter(([key]) => !spec.omit?.includes(key)))
}

function keyOf(table: PgTable, column: Column): string {
  const entry = Object.entries(getTableColumns(table)).find(([, c]) => c.name === column.name)
  if (!entry) throw new Error(`column ${column.name} not found on ${getTableConfig(table).name}`)
  return entry[0]
}

/** JS keys of the primary key (single or composite). */
export function primaryKeyOf(table: PgTable): string[] {
  const single = Object.entries(getTableColumns(table))
    .filter(([, c]) => c.primary)
    .map(([key]) => key)
  if (single.length > 0) return single
  const composite = getTableConfig(table).primaryKeys[0]
  if (!composite) throw new Error(`${getTableConfig(table).name} has no primary key`)
  return composite.columns.map((c) => keyOf(table, c))
}

export interface ForeignKey {
  keys: string[]
  parent: PgTable
  parentKeys: string[]
}

export function foreignKeysOf(table: PgTable): ForeignKey[] {
  return getTableConfig(table).foreignKeys.map((fk) => {
    const ref = fk.reference()
    return {
      keys: ref.columns.map((c) => keyOf(table, c)),
      parent: ref.foreignTable,
      parentKeys: ref.foreignColumns.map((c) => keyOf(ref.foreignTable, c)),
    }
  })
}

export function timestampKeysOf(table: PgTable): string[] {
  return Object.entries(getTableColumns(table))
    .filter(([, c]) => c.columnType === 'PgTimestamp')
    .map(([key]) => key)
}
