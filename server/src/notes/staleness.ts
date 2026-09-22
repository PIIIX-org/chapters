import { eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, repositories, repositoryFiles } from '../db/schema.js'
import { notify } from '../notifications/notify.js'
import type { OkfV2Frontmatter, SourceDescriptor } from './okf/types.js'

export interface StalenessDrift {
  noteId: string
  notePath: string
  resource: string
  expectedHash: string
  currentHash: string | null
}

/**
 * Checks for code drift / staleness between ingested repository files and
 * note provenance sources referencing `repo:<repoId>/...` or `repo:<repoName>/...`.
 *
 * Emits a notification to the repository owner if drift is detected.
 */
export async function checkCodeStaleness(
  repositoryId: string,
): Promise<StalenessDrift[]> {
  const [repo] = await db
    .select({ id: repositories.id, name: repositories.name, ownerId: repositories.ownerId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1)

  if (!repo) return []

  const repoFiles = await db
    .select({ path: repositoryFiles.path, contentHash: repositoryFiles.contentHash })
    .from(repositoryFiles)
    .where(eq(repositoryFiles.repositoryId, repositoryId))

  const fileHashMap = new Map<string, string>(
    repoFiles.map((f) => [f.path, f.contentHash]),
  )

  const liveNotes = await db
    .select({
      id: notes.id,
      path: notes.path,
      frontmatter: notes.frontmatter,
    })
    .from(notes)
    .where(isNull(notes.deletedAt))

  const drifts: StalenessDrift[] = []
  const prefixId = `repo:${repositoryId}/`
  const prefixName = repo.name ? `repo:${repo.name}/` : null

  for (const note of liveNotes) {
    const fm = note.frontmatter as OkfV2Frontmatter | null
    if (!fm) continue

    const sources = Array.isArray(fm.sources) ? (fm.sources as SourceDescriptor[]) : []
    for (const source of sources) {
      if (!source || typeof source.resource !== 'string') continue

      let filePath: string | null = null
      if (source.resource.startsWith(prefixId)) {
        filePath = source.resource.slice(prefixId.length)
      } else if (prefixName && source.resource.startsWith(prefixName)) {
        filePath = source.resource.slice(prefixName.length)
      }

      if (filePath === null) continue

      filePath = filePath.split('#')[0]!

      const expectedHash =
        typeof source.hash === 'string'
          ? source.hash
          : typeof (source as Record<string, unknown>).content_hash === 'string'
            ? ((source as Record<string, unknown>).content_hash as string)
            : typeof (source as Record<string, unknown>).contentHash === 'string'
              ? ((source as Record<string, unknown>).contentHash as string)
              : typeof (source as Record<string, unknown>).expectedHash === 'string'
                ? ((source as Record<string, unknown>).expectedHash as string)
                : undefined

      if (!expectedHash) continue

      const currentHash = fileHashMap.has(filePath) ? fileHashMap.get(filePath)! : null

      if (currentHash !== expectedHash) {
        drifts.push({
          noteId: note.id,
          notePath: note.path,
          resource: source.resource,
          expectedHash,
          currentHash,
        })
      }
    }
  }

  if (drifts.length > 0 && repo.ownerId) {
    const driftSummary = drifts.map((d) => `${d.notePath} -> ${d.resource}`).join(', ')
    await notify({
      recipientId: repo.ownerId,
      type: 'code_drift_detected',
      entityType: 'repository',
      entityId: repositoryId,
      message: `Code drift detected across ${drifts.length} note source reference(s) for repository "${repo.name}".`,
      emailSubject: 'Code Drift Detected',
      emailText: `Code drift was detected in repository "${repo.name}" across ${drifts.length} note reference(s):\n${driftSummary}`,
    }).catch((err) => {
      console.error('[CodeStaleness] Failed to send notification:', err)
    })
  }

  return drifts
}
