import { createHash } from 'node:crypto'
import type { repositories } from '../db/schema.js'

export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Names one registered source of a repository (owner, creation, method, location): a replaced or recreated source is another identity. Never carries the credential. */
export function sourceIdentity(repo: typeof repositories.$inferSelect): string {
  return contentHash(`${repo.ownerId}\0${repo.createdAt.toISOString()}\0${repo.ingestionMethod}\0${repo.gitUrl ?? ''}\0${repo.localPath ?? ''}`)
}
