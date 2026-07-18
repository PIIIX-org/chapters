import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { decryptCredential } from './credentials.js'
import { syncGitRepository } from './git-sync.js'
import { logSecurityEvent } from '../auth/security-events.js'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

function verifySignature(rawBody: Buffer, secret: string, header: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  const expectedBuf = Buffer.from(expected)
  const headerBuf = Buffer.from(header)
  return expectedBuf.length === headerBuf.length && timingSafeEqual(expectedBuf, headerBuf)
}

/**
 * GitHub/GitLab push-event receiver (spec 8): genuinely real-time
 * freshness for reachable self-hosted instances. Scoped to its own
 * plugin context so the raw-body content-type parser doesn't affect
 * JSON parsing anywhere else in the app.
 */
export function repositoryWebhookRoutes(app: FastifyInstance) {
  app.register(async (instance) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req: FastifyRequest, body: Buffer, done) => {
        req.rawBody = body
        try {
          done(null, body.length ? JSON.parse(body.toString('utf8')) : {})
        } catch (err) {
          done(err as Error, undefined)
        }
      },
    )

    instance.post<{ Params: { id: string } }>('/repositories/:id/webhook', async (req, reply) => {
      const repo = (
        await db.select().from(repositories).where(eq(repositories.id, req.params.id))
      )[0]
      if (!repo || !repo.webhookSecretEncrypted) {
        return reply.code(404).send({ error: 'not found' })
      }
      const signature = req.headers['x-hub-signature-256']
      if (typeof signature !== 'string' || !req.rawBody) {
        await logSecurityEvent({ type: 'webhook_rejected', ip: req.ip, detail: { repositoryId: repo.id } })
        return reply.code(401).send({ error: 'missing signature' })
      }
      const secret = decryptCredential(repo.webhookSecretEncrypted)
      if (!verifySignature(req.rawBody, secret, signature)) {
        await logSecurityEvent({ type: 'webhook_rejected', ip: req.ip, detail: { repositoryId: repo.id } })
        return reply.code(401).send({ error: 'invalid signature' })
      }

      await db
        .update(repositories)
        .set({ lastWebhookAt: new Date() })
        .where(eq(repositories.id, repo.id))

      // Fire-and-forget: the webhook response returns immediately, sync runs async.
      void syncGitRepository(repo.id).catch((err) => {
        console.error(`webhook-triggered sync failed for repository ${repo.id}:`, err)
      })
      return { status: 'accepted' }
    })
  })
}
