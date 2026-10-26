import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'
import type { SkipSummary } from '../repositories/fs-scan.js'

export const userStatus = pgEnum('user_status', [
  'pending_approval',
  'active',
  'deactivated',
])
export const USER_ROLES = [
  'owner',
  'superadmin',
  'admin',
  'moderator',
  'manager',
  'editor',
  'contributor',
  'member',
  'viewer',
  'guest',
] as const
export type UserRole = (typeof USER_ROLES)[number]
export const userRole = pgEnum('user_role', USER_ROLES)
export const teamRole = pgEnum('team_role', ['owner', 'member'])
export const granteeType = pgEnum('grantee_type', ['user', 'team'])
export const permission = pgEnum('permission', ['read', 'edit'])
export const mcpScope = pgEnum('mcp_scope', ['account', 'vault', 'repository'])
/** What an MCP token may do, ordered: read < write < admin (#548, #549). */
export const mcpAccess = pgEnum('mcp_access', ['read', 'write', 'admin'])
/** The tools an MCP token lists and may call, nested: reader < writer < admin (every tool) (#428). */
export const mcpProfile = pgEnum('mcp_profile', ['reader', 'writer', 'admin'])
export const emailTokenPurpose = pgEnum('email_token_purpose', [
  'verify_email',
  'password_reset',
])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  status: userStatus('status').notNull().default('pending_approval'),
  role: userRole('role').notNull().default('member'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  totpSecret: text('totp_secret'),
  mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
  // Account-level switch for notification *emails* only; the in-app row is
  // always written — it is the activity feed (notifications spec).
  emailNotifications: boolean('email_notifications').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/** One-time MFA backup codes, hashed, single-use (MFA spec). */
export const mfaBackupCodes = pgTable(
  'mfa_backup_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('mfa_backup_codes_user_idx').on(t.userId)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const teamMemberships = pgTable(
  'team_memberships',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: teamRole('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_memberships_user_idx').on(t.userId),
  ],
)

export const vaults = pgTable(
  'vaults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    mergeable: boolean('mergeable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('vaults_owner_idx').on(t.ownerId)],
)

export const vaultShares = pgTable(
  'vault_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    granteeType: granteeType('grantee_type').notNull(),
    granteeId: uuid('grantee_id').notNull(),
    permission: permission('permission').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('vault_shares_unique').on(t.vaultId, t.granteeType, t.granteeId),
    index('vault_shares_grantee_idx').on(t.granteeType, t.granteeId),
  ],
)

export const vaultGraphPreferences = pgTable(
  'vault_graph_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    include: boolean('include').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.vaultId] })],
)

export const userVaultPreferences = pgTable('user_vault_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  storageMode: text('storage_mode').notNull().default('online'),
  folders: jsonb('folders').$type<Record<string, string>>().notNull().default({}),
  folderColors: jsonb('folder_colors').$type<Record<string, string>>().notNull().default({}),
  vaultColors: jsonb('vault_colors').$type<Record<string, string>>().notNull().default({}),
  favorites: jsonb('favorites').$type<Record<string, boolean>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const graphPerspectives = pgTable(
  'graph_perspectives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id').references(() => vaults.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    filters: jsonb('filters')
      .$type<{
        types?: string[]
        tags?: string[]
        since?: string
        until?: string
        colorMode?: string
      }>()
      .notNull()
      .default({}),
    isShared: boolean('is_shared').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('graph_perspectives_vault_idx').on(t.vaultId),
    index('graph_perspectives_user_idx').on(t.userId),
  ],
)

export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    scope: mcpScope('scope').notNull(),
    vaultId: uuid('vault_id').references(() => vaults.id, {
      onDelete: 'cascade',
    }),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'cascade',
    }),
    tokenHash: text('token_hash').notNull().unique(),
    // Set at mint time only. Each MCP tool declares the level it needs. No
    // database default: the mint route and the restore name the level (#641).
    access: mcpAccess('access').notNull(),
    // null = every tool `access` permits; otherwise only these tool names.
    allowedTools: text('allowed_tools').array(),
    // Set at mint time only (#428, migration 0032). Narrows what `access`,
    // `allowedTools` and the scope allow; 'admin' (every tool) is the default
    // for tokens minted before it and for API mints that name none.
    profile: mcpProfile('profile').notNull().default('admin'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('mcp_connections_user_idx').on(t.userId)],
)

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: emailTokenPurpose('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('email_tokens_user_idx').on(t.userId, t.purpose)],
)

/**
 * Migration 0027 (#858): `seq` is the order events were recorded in (a
 * sequence, not the clock: `created_at` can step back or tie); the admin
 * security-event log orders by it.
 */
export const securityEvents = pgTable(
  'security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    actorUserId: uuid('actor_user_id'),
    subjectUserId: uuid('subject_user_id'),
    mcpConnectionId: uuid('mcp_connection_id'),
    ip: text('ip'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (t) => [index('security_events_created_idx').on(t.createdAt), index('security_events_seq_idx').on(t.seq)],
)

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    message: text('message').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('notifications_recipient_idx').on(t.recipientId, t.readAt)],
)

/**
 * Single-row table tracking one-time instance setup. Migration 0021 also adds
 * the ADR-003 backfill markers `store_migrated_at` (S2a) and
 * `collab_migrated_at` (S2b); they stay out of this model until S2a reads them
 * (see `notes` below). Migration 0041 (#680) adds `permission_epoch bigint`,
 * bumped by triggers on every share, team, token or account change and read
 * by cache/key.ts with SQL; out of this model, so a backup does not carry it.
 */
export const instanceState = pgTable('instance_state', {
  id: text('id').primaryKey().default('singleton'),
  setupTokenHash: text('setup_token_hash'),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
  /** Admin-mandated MFA: users without TOTP must set it up to continue. */
  requireMfa: boolean('require_mfa').notNull().default(false),
})

/**
 * The index epoch of a vault or a repository (ADR-004 §2.9, #680, migration
 * 0041): bumped at commit by triggers on every change an answer about it
 * could show; no row is epoch 0. Cache keys carry it (cache/key.ts). Derived
 * state, so a backup leaves it out. Statement triggers queue the scopes a
 * transaction touched in the unlogged `index_epoch_pending` (out of this
 * model: only the triggers use it), and a deferred trigger bumps each once
 * at commit.
 */
export const indexEpochs = pgTable(
  'index_epochs',
  {
    /** 'vault' | 'repository' */
    scope: text('scope').notNull(),
    scopeId: uuid('scope_id').notNull(),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ name: 'index_epochs_pkey', columns: [t.scope, t.scopeId] })],
)

/**
 * The authoritative note store (ADR-003, S2a): every server write is one
 * transaction on this row (store-tx.ts); the OKF files on disk are a
 * projection of it (notes/projector.ts). Search and graph attach here.
 *
 * Migration 0021 (ADR-003 §4) also adds `seq bigint NOT NULL DEFAULT 1`
 * (bumped by the `notes_bump_seq` trigger on any change of body, frontmatter,
 * path or deleted_at) and `frontmatter_src json`; migration 0033 (#453) adds
 * `embedder_id text` (search/embeddings.ts `EMBEDDER_ID` of its blocks;
 * null before #453) and migration 0036 (#452) `chunk_version integer NOT
 * NULL DEFAULT 0` (search/embed-key.ts `CHUNK_VERSION` of its blocks; 0:
 * none yet). They are deliberately not
 * in this model: rows are returned whole by REST and MCP, so declaring them
 * would add fields to responses. The store reads them with SQL
 * (store-tx.ts `storedColumns`). A note's vectors are its `blocks`
 * (migration 0036 dropped `notes.embedding`).
 */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    frontmatter: jsonb('frontmatter').notNull(),
    body: text('body').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('notes_vault_path_live')
      .on(t.vaultId, t.path)
      .where(sql`deleted_at is null`),
    // browse_vault's pages in code-unit order (#425, migration 0030): a subtree, and one folder level by the note's folder.
    index('notes_vault_path_c_live')
      .on(t.vaultId, sql`${t.path} collate "C"`)
      .where(sql`deleted_at is null`),
    index('notes_vault_dir_c_live')
      .on(t.vaultId, sql`(coalesce(substring(${t.path} from '^(.*/)'), '')) collate "C"`, sql`${t.path} collate "C"`)
      .where(sql`deleted_at is null`),
    index('notes_vault_type_idx').on(t.vaultId, t.type),
    // Search's tag filter inside the note legs (#454, migration 0043): `frontmatter -> 'tags' ?| …`.
    index('notes_tags_idx').using('gin', sql`(${t.frontmatter} -> 'tags')`),
    // Trashed notes by path (migration 0051, #682): read_note's `if_rev` checks no other note held the path.
    index('notes_vault_path_trashed').on(t.vaultId, t.path).where(sql`deleted_at is not null`),
  ],
)

/** Expiring, revocable download links for vault exports (spec 7). */
export const exportLinks = pgTable(
  'export_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vaultId: uuid('vault_id')
      .notNull()
      .references(() => vaults.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('export_links_vault_idx').on(t.vaultId)],
)

export const actorType = pgEnum('actor_type', ['user', 'mcp', 'collab'])

/**
 * Audit trail (spec 6): every write records its actor and the resulting
 * state — enough to attribute and to revert. Rows are only removed by
 * explicit hard purge. Migration 0021 also adds `seq`, `idempotency_key` and
 * `actor_detail` (unused until S2a, kept out of this model like `notes.seq`).
 * Migration 0023 (#479): `sourceRevisionId` is the revision a `revert` row
 * brought back, or the base revision a `proposal` row was made from (#475);
 * `fromPath` / `toPath` the paths of a `rename` row. Null on every other row.
 * Migration 0024 (#825, #811): `ord` is the order revisions were recorded in
 * (a sequence, not the clock: `created_at` can step back or tie); every list
 * of a note's revisions orders by it. Migration 0026 (#501) adds
 * `body_delta`, `delta_base_id` and `body_bytes` (a compacted revision, kept
 * out of this model like `seq`): read a body with store-tx.ts `revisionBody`.
 */
export const noteRevisions = pgTable(
  'note_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    frontmatter: jsonb('frontmatter').notNull(),
    body: text('body').notNull(),
    sourceRevisionId: uuid('source_revision_id'),
    fromPath: text('from_path'),
    toPath: text('to_path'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ord: bigserial('ord', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('note_revisions_note_idx').on(t.noteId, t.createdAt),
    index('note_revisions_note_ord').on(t.noteId, t.ord),
    // Revisions that moved a note away from a path (migration 0051, #682): read_note's `if_rev` checks no other note left it.
    index('note_revisions_from_path').on(t.fromPath).where(sql`from_path is not null`),
  ],
)

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
})

/** A Postgres `tsvector`: written as SQL (`array_to_tsvector`, search/block-rows.ts `keywordVector`), matched in SQL, never read by the app. */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

// ADR-003 §4 (migration 0021): the store's CRDT, update-log, projection and
// job tables. Nothing reads or writes them before S2a/S2b. 0021 is hand-written
// SQL, so primary, unique and foreign keys carry Postgres's default names
// (`<table>_pkey`, `<table>_<col>_key`, `<table>_<col>_fkey`); the model names
// them the same way so `drizzle-kit generate` finds nothing to change.

/** Yjs state per note, keyed by note id (replaces `.crdt/<path>.bin` in S2b). */
export const noteCrdt = pgTable(
  'note_crdt',
  {
    noteId: uuid('note_id').primaryKey(),
    snapshot: bytea('snapshot').notNull(),
    snapshotThrough: bigint('snapshot_through', { mode: 'number' }).notNull().default(0),
    foldedThrough: bigint('folded_through', { mode: 'number' }).notNull().default(0),
    foldedSeq: bigint('folded_seq', { mode: 'number' }).notNull(),
    foldError: text('fold_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'note_crdt_note_id_fkey', columns: [t.noteId], foreignColumns: [notes.id] }).onDelete('cascade'),
  ],
)

/** Yjs update log tail (collab journal + server updates), compacted into `note_crdt.snapshot`. */
export const noteUpdates = pgTable(
  'note_updates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    noteId: uuid('note_id').notNull(),
    update: bytea('update').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    actorDetail: jsonb('actor_detail'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectReason: text('reject_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'note_updates_note_id_fkey', columns: [t.noteId], foreignColumns: [notes.id] }).onDelete('cascade'),
    index('note_updates_note_idx').on(t.noteId, t.id),
  ],
)

/** Projection state per note ('file' | 'dir_index' | 'embedding'); the projector's work queue. */
export const noteProjections = pgTable(
  'note_projections',
  {
    noteId: uuid('note_id').notNull(),
    projection: text('projection').notNull(),
    targetSeq: bigint('target_seq', { mode: 'number' }).notNull(),
    appliedSeq: bigint('applied_seq', { mode: 'number' }).notNull().default(0),
    indexVersion: integer('index_version').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'note_projections_pkey', columns: [t.noteId, t.projection] }),
    foreignKey({ name: 'note_projections_note_id_fkey', columns: [t.noteId], foreignColumns: [notes.id] }).onDelete(
      'cascade',
    ),
    index('note_projections_pending')
      .on(t.projection, t.updatedAt)
      .where(sql`applied_seq < target_seq`),
  ],
)

/** What the projector last wrote at each vault-relative path (path ownership + hash). */
export const projectedFiles = pgTable(
  'projected_files',
  {
    vaultId: uuid('vault_id').notNull(),
    path: text('path').notNull(),
    ownerKind: text('owner_kind').notNull(),
    ownerId: uuid('owner_id'),
    appliedHash: text('applied_hash').notNull(),
    appliedSeq: bigint('applied_seq', { mode: 'number' }),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'projected_files_pkey', columns: [t.vaultId, t.path] }),
    foreignKey({ name: 'projected_files_vault_id_fkey', columns: [t.vaultId], foreignColumns: [vaults.id] }).onDelete(
      'cascade',
    ),
    index('projected_files_owner_idx').on(t.ownerId),
  ],
)

/** Outbox for work that outlives a note row or spans notes (rename refactor, file removal, #494). */
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    idempotencyKey: text('idempotency_key').unique('jobs_idempotency_key_key'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
    /** jobs/durable.ts `JOB_PRIORITY` (#453, migration 0033): 0 a write's job, 1 catch-up; claims take the lowest first. */
    priority: smallint('priority').notNull().default(0),
  },
  (t) => [
    index('jobs_pending').on(t.kind, t.createdAt).where(sql`done_at is null`),
    // claimJob's order: the next claimable job is the first index entry that passes the lease and attempts checks.
    index('jobs_claim').on(t.kind, t.priority, t.id).where(sql`done_at is null`),
  ],
)

/** The first result of an MCP write sent with an `idempotency_key` (#477, migration 0025), per connection and key. */
export const writeIdempotency = pgTable(
  'write_idempotency',
  {
    connectionId: uuid('connection_id').notNull(),
    key: text('key').notNull(),
    tool: text('tool').notNull(),
    argsHash: text('args_hash').notNull(),
    noteId: uuid('note_id'),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'write_idempotency_pkey', columns: [t.connectionId, t.key] }),
    foreignKey({ name: 'write_idempotency_connection_id_fkey', columns: [t.connectionId], foreignColumns: [mcpConnections.id] }).onDelete(
      'cascade',
    ),
    foreignKey({ name: 'write_idempotency_note_id_fkey', columns: [t.noteId], foreignColumns: [notes.id] }).onDelete('cascade'),
    index('write_idempotency_created_at').on(t.createdAt),
    index('write_idempotency_note_id').on(t.noteId),
  ],
)

/** The `rev` an MCP connection last read of a note (#408, #476, migration 0028): the base of a whole edit_note `body` sent without `base_rev`. */
export const noteReads = pgTable(
  'note_reads',
  {
    connectionId: uuid('connection_id').notNull(),
    noteId: uuid('note_id').notNull(),
    rev: bigint('rev', { mode: 'number' }).notNull(),
    /** The body the connection last sent, when its write was merged; null when the revision at `rev` is what it has. */
    body: text('body'),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'note_reads_pkey', columns: [t.connectionId, t.noteId] }),
    foreignKey({ name: 'note_reads_connection_id_fkey', columns: [t.connectionId], foreignColumns: [mcpConnections.id] }).onDelete('cascade'),
    foreignKey({ name: 'note_reads_note_id_fkey', columns: [t.noteId], foreignColumns: [notes.id] }).onDelete('cascade'),
    index('note_reads_read_at').on(t.readAt),
    index('note_reads_note_id').on(t.noteId),
  ],
)

/**
 * EXTRACTED edges: one row per wikilink of a note body, replaced on every
 * body save. `start_line`/`end_line` are body-relative (ADR-004 §2.2: a
 * frontmatter edit leaves them valid; answers add the body's first file
 * line). A note may link one target on several lines (#472); of two links
 * to one target starting on one line, the row is the first. `context` is
 * the link's paragraph or line, at most 200 code points (#472, `okf.ts`
 * `extractWikilinkLocations`). Null context means "not filled yet": rows
 * written before 0039 (and, with `start_line` 0, before 0031), or by older
 * code after a rollback; the boot catch-up (`notes/link-catch-up.ts`)
 * rewrites them.
 */
export const noteLinks = pgTable(
  'note_links',
  {
    sourceNoteId: uuid('source_note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    targetPath: text('target_path').notNull(),
    startLine: integer('start_line').notNull().default(0),
    endLine: integer('end_line').notNull().default(0),
    context: text('context'),
  },
  (t) => [
    primaryKey({ name: 'note_links_source_note_id_target_path_start_line_pk', columns: [t.sourceNoteId, t.targetPath, t.startLine] }),
    index('note_links_target_idx').on(t.targetPath),
    index('note_links_unfilled_idx').on(t.sourceNoteId).where(sql`context IS NULL`),
  ],
)

export const semanticNodeType = pgEnum('semantic_node_type', ['note', 'code'])

/**
 * Semantic kNN edges, stored **directed**: one row means "source holds target
 * in its top-k", and the row is owned by its source. kNN is asymmetric, so the
 * reverse row may or may not exist — `recomputeSemanticEdges()` only ever
 * deletes rows it owns, and `buildGraph()` merges both directions into one
 * undirected edge with the higher similarity (#558).
 *
 * Treating these as undirected in storage is the bug fixed in #91: deleting by
 * either side wipes edges another node owns, and nothing restores them.
 *
 * Both ends are in one scope (D10, #461): two notes of one vault, two files of
 * one repository, or a note and a file whose vault and repository have one
 * owner. Migration 0038 deleted the rows from before; a vault transfer deletes
 * its notes' note↔code rows (`transferVaultSemanticEdges`).
 *
 * The SQL columns are still named `node_a_*` / `node_b_*` from when the table
 * was modelled as an undirected pair — renaming them would buy nothing but a
 * migration. `node_a` is the source, `node_b` is the target.
 *
 * The rows are the true top-k of the content whatever the order it was
 * embedded in (#1007, search/semantic-edges.ts), and after a delete, those of
 * the content without the node (#1015: `removeSemanticNodes`; a note in the
 * trash, or in a vault in the trash, has none, #1025). `similarity` holds
 * the double the search computed (migration 0050; `real` before), so an
 * embed compares its own similarity with a list's last row exactly.
 */
export const semanticEdges = pgTable(
  'semantic_edges',
  {
    sourceType: semanticNodeType('node_a_type').notNull(),
    sourceId: uuid('node_a_id').notNull(),
    targetType: semanticNodeType('node_b_type').notNull(),
    targetId: uuid('node_b_id').notNull(),
    similarity: doublePrecision('similarity').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceType, t.sourceId, t.targetType, t.targetId] }),
    index('semantic_edges_b_idx').on(t.targetType, t.targetId),
    index('semantic_edges_node_a_id_idx').on(t.sourceId),
    index('semantic_edges_node_b_id_idx').on(t.targetId),
  ],
)

export const repositoryIngestionMethod = pgEnum('repository_ingestion_method', [
  'git',
  'local_path',
  'agent_push',
])
export const repositorySyncStatus = pgEnum('repository_sync_status', [
  'idle',
  'syncing',
  'error',
])

/**
 * A codebase connected to Elara (spec: repository ingestion &
 * permissions). Mirrors Vault's owner/share pattern but read-only —
 * no edit permission tier, since nothing here is ever written to.
 */
export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    ingestionMethod: repositoryIngestionMethod('ingestion_method').notNull(),
    gitUrl: text('git_url'),
    /** Encrypted (not hashed) — must be reusable for future pulls. */
    gitCredentialEncrypted: text('git_credential_encrypted'),
    /** Encrypted, generated at creation time for git-sourced repositories. */
    webhookSecretEncrypted: text('webhook_secret_encrypted'),
    localPath: text('local_path'),
    mergeable: boolean('mergeable').notNull().default(false),
    syncStatus: repositorySyncStatus('sync_status').notNull().default('idle'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    /**
     * The remote's HEAD branch name, read from the shallow clone on each git
     * sync — the ref GitHub deep links need. Null for local_path/agent_push
     * (no branch exists) and for a git repo whose first sync has not landed.
     */
    defaultBranch: text('default_branch'),
    /**
     * The commit the index was built from (#471, ADR-004 §2.9): HEAD of the
     * clone (git), HEAD of a clean git work tree (local_path), the commit a
     * push names (agent_push). Null when no commit describes the indexed
     * files: a folder outside git or with uncommitted changes, a push
     * without one.
     */
    lastSyncedCommit: text('last_synced_commit'),
    /**
     * The indexed files, whatever their source (#471): 16 hex characters of
     * sha256 over the sorted `path NUL content_hash LF` lines
     * (`computeTreeHash`). Written by every sync; null until one runs.
     */
    treeHash: text('tree_hash'),
    /** Staleness signal for the polling fallback scheduler. */
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
    /**
     * What the last git or local-path sync left out of the index: counts per
     * reason and a short sample of paths (#465). Null until a sync records it.
     */
    skippedFiles: jsonb('skipped_files').$type<SkipSummary>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('repositories_owner_idx').on(t.ownerId)],
)

export const repositoryShares = pgTable(
  'repository_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    granteeType: granteeType('grantee_type').notNull(),
    granteeId: uuid('grantee_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('repository_shares_unique').on(t.repositoryId, t.granteeType, t.granteeId),
    index('repository_shares_grantee_idx').on(t.granteeType, t.granteeId),
  ],
)

export const repositoryGraphPreferences = pgTable(
  'repository_graph_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    include: boolean('include').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repositoryId] })],
)

/**
 * The indexed content of a repository — derived from whatever the
 * ingestion method last synced, never authored in Elara. Hard
 * deleted on sync (no trash/audit): git remains the record of code
 * history, not Elara.
 */
export const repositoryFiles = pgTable(
  'repository_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    language: text('language'),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    size: integer('size').notNull(),
    sourceModifiedAt: timestamp('source_modified_at', { withTimezone: true }),
    /**
     * Why the last extraction embedded this file only partly (#496: the
     * per-file symbol budget); null when it embedded everything. The file's
     * vectors are its `blocks` (migration 0035).
     */
    embeddingNote: text('embedding_note'),
    /**
     * What produced this file's imports, blocks and vectors (#453, migration
     * 0033), written in one transaction with them: the `content_hash` they
     * were extracted from, extraction.ts `EXTRACTOR_VERSION` (0: before #453)
     * and embeddings.ts `EMBEDDER_ID` (null: before #453). Boot catch-up
     * re-extracts a file whose values differ from its content and the running code.
     */
    extractedHash: text('extracted_hash'),
    extractorVersion: integer('extractor_version').notNull().default(0),
    embedderId: text('embedder_id'),
    /** embed-key.ts `CHUNK_VERSION` of its blocks (migration 0035; 0: before #452a), checked by boot catch-up like the two above. */
    chunkVersion: integer('chunk_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('repository_files_repo_path').on(t.repositoryId, t.path),
    // browse_repository's keyset in code-unit order (#424, migration 0029).
    index('repository_files_repo_path_c').on(t.repositoryId, sql`${t.path} collate "C"`),
  ],
)

/** EXTRACTED edges for code: raw import targets, resolved against the same repository's files. */
export const repositoryFileImports = pgTable(
  'repository_file_imports',
  {
    sourceFileId: uuid('source_file_id')
      .notNull()
      .references(() => repositoryFiles.id, { onDelete: 'cascade' }),
    targetPath: text('target_path').notNull(),
    resolvedTargetFileId: uuid('resolved_target_file_id').references(() => repositoryFiles.id, {
      onDelete: 'cascade',
    }),
    /** The line of the import's specifier (1-based); null for rows extracted before 0031 (#453 re-extracts them). */
    line: integer('line'),
  },
  (t) => [
    primaryKey({ columns: [t.sourceFileId, t.targetPath] }),
    index('repository_file_imports_resolved_idx').on(t.resolvedTargetFileId),
  ],
)

/**
 * Blocks (ADR-004 §2.2, §2.5; #413, #452, migrations 0035, 0036): the
 * addressable spans of a note or a repository file, which are also its
 * embedding chunks. For code (repositories/code-blocks.ts) a file's
 * `symbol`, `skeleton` and `file` blocks; for a note (notes/note-blocks.ts)
 * its `preamble` and `section` blocks, with body-relative lines. `block_id`
 * is stable across line shifts (text/blocks.ts `blockId`); lines follow
 * text/lines.ts. `owner_id` has no foreign key (it names a note or a file):
 * triggers delete a repository file's or a note's blocks with its row.
 * `owner_version` is what the set was derived from (a file's
 * `content_hash`, a note's `seq`), replaced whole in one transaction (#460).
 * `embed_key` is embed-key.ts `embedKey(text)` of the vector, null when
 * the block is not embedded (over the per-file symbol budget); on the file
 * vectors migration 0035 carried over it is computed from the embedder and
 * text that made them (so the first re-extraction reuses them), `legacy` on
 * the carried-over symbol and note vectors (their text no block has now).
 */
export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerType: semanticNodeType('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    /** vault_id | repository_id: the scope filter inside each leg (#454). */
    containerId: uuid('container_id').notNull(),
    blockId: text('block_id').notNull(),
    /** text/blocks.ts `BlockKind`. */
    kind: text('kind').notNull(),
    innerPath: text('inner_path').notNull(),
    /** extraction.ts `SymbolKind` for kind = 'symbol'. */
    symbolKind: text('symbol_kind'),
    /**
     * A symbol's `parent` (#450: a method's class, a namespace member's
     * namespace), null at module level: `inner_path` is `parent.name`, and a
     * name may itself hold a `.` (`namespace A.B`), so the split is kept.
     */
    symbolParent: text('symbol_parent'),
    /** A symbol block's snippet (code-blocks.ts): the keyword legs match it and hits show it, as `repository_file_symbols.snippet` was. */
    snippet: text('snippet'),
    /**
     * A symbol block's identifier lexemes (#455, migration 0052;
     * search/identifiers.ts `symbolKeywords`: its `inner_path` only, split,
     * unstemmed), which the symbol keyword leg matches beside
     * `inner_path` and `snippet`. Null on other blocks and on a symbol not
     * extracted since 0052 (`EXTRACTOR_VERSION` 6 extracts it again).
     */
    keywords: tsvector('keywords'),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    contentHash: text('content_hash').notNull(),
    ownerVersion: text('owner_version').notNull(),
    embedKey: text('embed_key'),
    embedding: vector('embedding', { dimensions: 384 }),
  },
  (t) => [
    unique('blocks_owner_block').on(t.ownerType, t.ownerId, t.blockId),
    // The unique index also serves (owner_type, owner_id) lookups.
    index('blocks_container_idx').on(t.containerId),
  ],
)

/** Auth for the agent/CLI push ingestion method — same lifecycle as an MCP token. */
export const repositorySyncTokens = pgTable(
  'repository_sync_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('repository_sync_tokens_repo_idx').on(t.repositoryId)],
)
