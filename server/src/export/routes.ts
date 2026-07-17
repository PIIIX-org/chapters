import type { FastifyInstance } from 'fastify'
import AdmZip from 'adm-zip'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { exportLinks, users, vaults, vaultShares } from '../db/schema.js'
import { generateToken, hashToken } from '../auth/tokens.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { resolveAccess, atLeast } from '../vaults/permissions.js'
import { createNote, readNote, splitPath } from '../notes/store.js'
import { parseNote, serializeNote, OkfValidationError } from '../notes/okf.js'
import { buildInstanceBackup, buildVaultZip, type VaultManifest } from './archive.js'

const LINK_TTL_MS = Number(process.env.EXPORT_LINK_TTL_HOURS ?? 24) * 60 * 60 * 1000

/** Export requires edit/owner (spec 7): a copy outlives later revocation. */
async function guardExport(userId: string, vaultId: string): Promise<boolean> {
  return atLeast(await resolveAccess(userId, vaultId), 'edit')
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
        splitPath(req.params['*'])
        const note = await readNote(req.params.id, req.params['*'])
        if (!note) return reply.code(404).send({ error: 'note not found' })
        // Exactly as stored: frontmatter + body, no transformation.
        return reply
          .header('content-type', 'text/markdown')
          .header(
            'content-disposition',
            `attachment; filename="${req.params['*'].split('/')[1]}.md"`,
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

    authed.post('/import', async (req, reply) => {
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

      const skipped: string[] = []
      let imported = 0
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !entry.entryName.endsWith('.md')) continue
        const path = entry.entryName.replace(/\.md$/, '')
        try {
          const { type, name } = splitPath(path)
          const parsed = parseNote(entry.getData().toString('utf8'))
          // Same shared validation write path as every other write.
          await createNote(
            vault!.id,
            { type, name, frontmatter: parsed.frontmatter, body: parsed.body },
            { type: 'user', id: req.user!.id },
          )
          imported += 1
        } catch (err) {
          if (err instanceof OkfValidationError) skipped.push(`${path}: ${err.message}`)
          else throw err
        }
      }

      const unmatchedShares: string[] = []
      for (const share of manifest.shares ?? []) {
        if (share.granteeType === 'user' && share.email) {
          const grantee = (
            await db.select().from(users).where(eq(users.email, share.email.toLowerCase()))
          )[0]
          if (grantee && grantee.status === 'active' && grantee.id !== req.user!.id) {
            await db.insert(vaultShares).values({
              vaultId: vault!.id,
              granteeType: 'user',
              granteeId: grantee.id,
              permission: share.permission,
            })
            continue
          }
        }
        unmatchedShares.push(
          share.granteeType === 'user'
            ? (share.email ?? 'unknown user')
            : `team: ${share.teamName ?? 'unknown'}`,
        )
      }

      return { vaultId: vault!.id, imported, skipped, unmatchedShares }
    })

    authed.get('/admin/backup', async (req, reply) => {
      if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'admin required' })
      const zip = await buildInstanceBackup()
      await logSecurityEvent({ type: 'instance_backup_created', actorUserId: req.user!.id })
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', 'attachment; filename="chapters-backup.zip"')
        .send(zip)
    })
  })
}
