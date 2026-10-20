import type { FastifyInstance } from 'fastify'
import AdmZip from 'adm-zip'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { exportLinks, teamMemberships, teams, users, vaults, vaultShares } from '../db/schema.js'
import { generateToken, hashToken } from '../auth/tokens.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { notify } from '../notifications/notify.js'
import { resolveAccess, atLeast } from '../vaults/permissions.js'
import { readNote } from '../notes/store.js'
import { resolveNotePath } from '../notes/okf/paths.js'
import { serializeNote } from '../notes/okf.js'
import {
  addVaultToZip,
  buildInstanceBackup,
  buildVaultZip,
  type VaultManifest,
} from './archive.js'
import { executeBackup, getBackupStatus } from './backup-service.js'
import { importVaultContent } from './vault-history.js'

const LINK_TTL_MS = Number(process.env.EXPORT_LINK_TTL_HOURS ?? 24) * 60 * 60 * 1000

/** Export requires edit/owner (spec 7): a copy outlives later revocation. */
async function guardExport(userId: string, vaultId: string): Promise<boolean> {
  return atLeast(await resolveAccess(userId, vaultId), 'edit')
}

/** Why an import did not grant a share listed in the archive manifest (#621). */
type ShareSkipReason =
  | 'not_requested'
  | 'invalid_entry'
  | 'invalid_permission'
  | 'no_active_user'
  | 'importer'
  | 'no_team'
  | 'ambiguous_team'
  | 'duplicate'

/** One manifest share and what the import did with it. */
interface ShareOutcome {
  granteeType: string
  /** The user's email or the team's name. */
  grantee: string
  permission: string
  reason?: ShareSkipReason
}

interface ImportedShares {
  appliedShares: ShareOutcome[]
  skippedShares: ShareOutcome[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The manifest is whatever the uploader wrote, so it never grants access on
 * its own (#621): without `apply` nothing is looked up or granted and every
 * entry comes back as `not_requested`. With it, an entry is granted only to an
 * existing active user (not the importer) or exactly one team of that name, at
 * `read` or `edit`: the importer owns the new vault, so neither exceeds their
 * own access, and ownership never moves. Everything else is reported.
 */
async function importManifestShares(
  vault: { id: string; name: string },
  shares: unknown,
  importerId: string,
  apply: boolean,
): Promise<ImportedShares> {
  const appliedShares: ShareOutcome[] = []
  const skippedShares: ShareOutcome[] = []
  const granted = new Set<string>()
  for (const raw of Array.isArray(shares) ? shares : []) {
    const fields = new Map<string, unknown>(
      typeof raw === 'object' && raw !== null ? Object.entries(raw) : [],
    )
    const granteeType = text(fields.get('granteeType'))
    const grantee = text(fields.get(granteeType === 'team' ? 'teamName' : 'email'))
    const permission = text(fields.get('permission'))
    const skip = (reason: ShareSkipReason) =>
      skippedShares.push({ granteeType, grantee, permission, reason })

    if (!apply) {
      skip('not_requested')
      continue
    }
    if ((granteeType !== 'user' && granteeType !== 'team') || !grantee) {
      skip('invalid_entry')
      continue
    }
    if (permission !== 'read' && permission !== 'edit') {
      skip('invalid_permission')
      continue
    }
    let granteeId: string
    let label = grantee
    if (granteeType === 'user') {
      const user = (
        await db
          .select({ id: users.id, email: users.email, status: users.status })
          .from(users)
          .where(eq(users.email, grantee.toLowerCase()))
      )[0]
      if (!user || user.status !== 'active') {
        skip('no_active_user')
        continue
      }
      if (user.id === importerId) {
        skip('importer')
        continue
      }
      granteeId = user.id
      label = user.email
    } else {
      const matches = await db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.name, grantee))
        .limit(2)
      if (matches.length !== 1) {
        skip(matches.length === 0 ? 'no_team' : 'ambiguous_team')
        continue
      }
      granteeId = matches[0]!.id
    }
    const key = `${granteeType}:${granteeId}`
    if (granted.has(key)) {
      skip('duplicate')
      continue
    }
    granted.add(key)

    await db.insert(vaultShares).values({ vaultId: vault.id, granteeType, granteeId, permission })
    // Same notice and audit trail as a share made from the share dialog.
    const recipients =
      granteeType === 'user'
        ? [granteeId]
        : (
            await db
              .select({ userId: teamMemberships.userId })
              .from(teamMemberships)
              .where(eq(teamMemberships.teamId, granteeId))
          ).map((m) => m.userId)
    for (const recipientId of recipients) {
      if (recipientId === importerId) continue
      await notify({
        recipientId,
        type: 'vault_shared',
        entityType: 'vault',
        entityId: vault.id,
        message: `Vault "${vault.name}" was shared with you (${permission}).`,
      })
    }
    await logSecurityEvent({
      type: 'vault_share_created',
      actorUserId: importerId,
      detail: { vaultId: vault.id, granteeType, granteeId, permission, source: 'import' },
    })
    appliedShares.push({ granteeType, grantee: label, permission })
  }
  return { appliedShares, skippedShares }
}

export function exportRoutes(app: FastifyInstance) {
  // Sessionless by design: anyone with a valid link inside its window.
  app.get<{ Params: { token: string } }>('/export-links/:token', async (req, reply) => {
    const link = (
      await db
        .select()
        .from(exportLinks)
        .where(
          and(
            eq(exportLinks.tokenHash, hashToken(req.params.token)),
            isNull(exportLinks.revokedAt),
            gt(exportLinks.expiresAt, new Date()),
          ),
        )
    )[0]
    if (!link) return reply.code(404).send({ error: 'not found' })
    const zip = await buildVaultZip(link.vaultId)
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', 'attachment; filename="vault-export.zip"')
      .send(zip)
  })

  app.register(async (authed) => {
    authed.addHook('preHandler', authed.requireAuth)

    authed.get<{ Params: { id: string; '*': string } }>(
      '/vaults/:id/export/note/*',
      async (req, reply) => {
        if (!(await guardExport(req.user!.id, req.params.id))) {
          return reply.code(404).send({ error: 'not found' })
        }
        const resolved = resolveNotePath(req.params['*'])
        const note = await readNote(req.params.id, resolved.fullPath)
        if (!note) return reply.code(404).send({ error: 'note not found' })
        // Exactly as stored: frontmatter + body, no transformation.
        return reply
          .header('content-type', 'text/markdown')
          .header(
            'content-disposition',
            `attachment; filename="${resolved.baseName}.md"`,
          )
          .send(serializeNote({ frontmatter: note.frontmatter, body: note.body }))
      },
    )

    authed.get<{ Params: { id: string } }>('/vaults/:id/export', async (req, reply) => {
      if (!(await guardExport(req.user!.id, req.params.id))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const zip = await buildVaultZip(req.params.id)
      await logSecurityEvent({
        type: 'vault_exported',
        actorUserId: req.user!.id,
        detail: { vaultId: req.params.id },
      })
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', 'attachment; filename="vault-export.zip"')
        .send(zip)
    })

    authed.post<{ Params: { id: string } }>('/vaults/:id/export-links', async (req, reply) => {
      if (!(await guardExport(req.user!.id, req.params.id))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const token = generateToken()
      const [link] = await db
        .insert(exportLinks)
        .values({
          vaultId: req.params.id,
          createdBy: req.user!.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + LINK_TTL_MS),
        })
        .returning()
      // Raw token returned once; only its hash is stored.
      return { id: link!.id, token, expiresAt: link!.expiresAt }
    })

    authed.delete<{ Params: { id: string; linkId: string } }>(
      '/vaults/:id/export-links/:linkId',
      async (req, reply) => {
        if (!(await guardExport(req.user!.id, req.params.id))) {
          return reply.code(404).send({ error: 'not found' })
        }
        const [revoked] = await db
          .update(exportLinks)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(exportLinks.id, req.params.linkId), eq(exportLinks.vaultId, req.params.id)),
          )
          .returning()
        if (!revoked) return reply.code(404).send({ error: 'link not found' })
        return { status: 'revoked' }
      },
    )

    authed.post<{ Querystring: { applyShares: boolean } }>(
      '/import',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: { applyShares: { type: 'boolean', default: false } },
          },
        },
      },
      async (req, reply) => {
        const file = await req.file()
        if (!file) return reply.code(400).send({ error: 'archive file required' })
        const buffer = await file.toBuffer()
        let zip: AdmZip
        try {
          zip = new AdmZip(buffer)
        } catch {
          return reply.code(400).send({ error: 'not a valid zip archive' })
        }
        const manifestEntry = zip.getEntry('manifest.json')
        if (!manifestEntry) return reply.code(400).send({ error: 'manifest.json missing' })
        const manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as VaultManifest

        const [vault] = await db
          .insert(vaults)
          .values({
            name: manifest.name ?? 'Imported vault',
            ownerId: req.user!.id,
            mergeable: Boolean(manifest.mergeable),
          })
          .returning()

        // Assets, trash, live notes and their history (#499).
        const content = await importVaultContent(
          zip,
          vault!.id,
          typeof manifest.vaultId === 'string' ? manifest.vaultId : undefined,
          { id: req.user!.id, email: req.user!.email },
        )

        const shares = await importManifestShares(
          { id: vault!.id, name: vault!.name },
          manifest.shares,
          req.user!.id,
          req.query.applyShares,
        )
        return { vaultId: vault!.id, ...content, ...shares }
      },
    )

    // Everything the caller *owns*. Vaults merely shared with them belong to
    // someone else's account and are that owner's to export.
    authed.get('/me/export', async (req, reply) => {
      const owned = await db
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(eq(vaults.ownerId, req.user!.id), isNull(vaults.deletedAt)))
      const zip = new AdmZip()
      for (const vault of owned) {
        await addVaultToZip(zip, vault.id, `vaults/${vault.id}/`)
      }
      await logSecurityEvent({ type: 'account_exported', actorUserId: req.user!.id })
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', 'attachment; filename="elara-account-export.zip"')
        .send(zip.toBuffer())
    })

    const isAdminRole = (role: string) => ['admin', 'owner', 'superadmin'].includes(role)

    authed.get('/admin/backup', async (req, reply) => {
      if (!isAdminRole(req.user!.role)) return reply.code(403).send({ error: 'admin required' })
      const zip = await buildInstanceBackup()
      await logSecurityEvent({ type: 'instance_backup_created', actorUserId: req.user!.id })
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', 'attachment; filename="elara-backup.zip"')
        // Password and token hashes, TOTP secrets: never kept by a browser or proxy cache (#493).
        .header('cache-control', 'no-store')
        .send(zip)
    })

    authed.get('/admin/backup/status', async (req, reply) => {
      if (!isAdminRole(req.user!.role)) return reply.code(403).send({ error: 'admin required' })
      return reply.send(getBackupStatus())
    })

    authed.post('/admin/backup/run', async (req, reply) => {
      if (!isAdminRole(req.user!.role)) return reply.code(403).send({ error: 'admin required' })
      try {
        const result = await executeBackup({ actorUserId: req.user!.id })
        return reply.send({ success: true, result })
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : 'Backup execution failed',
        })
      }
    })
  })
}

