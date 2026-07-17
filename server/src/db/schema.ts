import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const userStatus = pgEnum('user_status', [
  'pending_approval',
  'active',
  'deactivated',
])
export const userRole = pgEnum('user_role', ['member', 'admin'])
export const teamRole = pgEnum('team_role', ['owner', 'member'])
export const granteeType = pgEnum('grantee_type', ['user', 'team'])
export const permission = pgEnum('permission', ['read', 'edit'])
export const mcpScope = pgEnum('mcp_scope', ['account', 'vault'])
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
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

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
    tokenHash: text('token_hash').notNull().unique(),
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
  },
  (t) => [index('security_events_created_idx').on(t.createdAt)],
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

/** Single-row table tracking one-time instance setup. */
export const instanceState = pgTable('instance_state', {
  id: text('id').primaryKey().default('singleton'),
  setupTokenHash: text('setup_token_hash'),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
})

/**
 * Derived index of the OKF files on disk (canonical source is the file
 * tree). Rebuildable; search and graph attach to this table.
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
    index('notes_vault_type_idx').on(t.vaultId, t.type),
  ],
)
