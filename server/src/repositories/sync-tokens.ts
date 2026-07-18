import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositorySyncTokens } from '../db/schema.js'
import { generateToken, hashToken } from '../auth/tokens.js'

export async function createSyncToken(repositoryId: string): Promise<string> {
  const token = generateToken()
  await db.insert(repositorySyncTokens).values({ repositoryId, tokenHash: hashToken(token) })
  return token
}

/** Live resolution — revoked tokens never resolve, same posture as MCP tokens. */
export async function resolveSyncToken(
  token: string,
): Promise<{ repositoryId: string; tokenId: string } | null> {
  const rows = await db
    .select()
    .from(repositorySyncTokens)
    .where(and(eq(repositorySyncTokens.tokenHash, hashToken(token)), isNull(repositorySyncTokens.revokedAt)))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  await db
    .update(repositorySyncTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(repositorySyncTokens.id, row.id))
  return { repositoryId: row.repositoryId, tokenId: row.id }
}

export async function revokeSyncToken(repositoryId: string, tokenId: string): Promise<boolean> {
  const updated = await db
    .update(repositorySyncTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(repositorySyncTokens.id, tokenId),
        eq(repositorySyncTokens.repositoryId, repositoryId),
        isNull(repositorySyncTokens.revokedAt),
      ),
    )
    .returning({ id: repositorySyncTokens.id })
  return updated.length > 0
}

export async function listSyncTokens(repositoryId: string) {
  return db
    .select({
      id: repositorySyncTokens.id,
      createdAt: repositorySyncTokens.createdAt,
      lastUsedAt: repositorySyncTokens.lastUsedAt,
      revokedAt: repositorySyncTokens.revokedAt,
    })
    .from(repositorySyncTokens)
    .where(eq(repositorySyncTokens.repositoryId, repositoryId))
}
