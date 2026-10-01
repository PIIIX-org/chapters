import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  noteLinks,
  notes,
  repositories,
  repositoryFiles,
  repositoryFileSymbols,
} from '../db/schema.js'
import { notify } from '../notifications/notify.js'
import type { OkfV2Frontmatter, SourceDescriptor } from './okf/types.js'

export interface StalenessDrift {
  noteId: string
  notePath: string
  vaultId: string
  resource: string
  expectedHash?: string
  currentHash?: string | null
  kind: 'hash_mismatch' | 'deleted_file' | 'missing_symbol'
  detail: string
}

/**
 * Checks for code drift / staleness between ingested repository files and:
 * 1. Note provenance sources (frontmatter.sources referencing repo:<repoId>/... or repo:<name>/...)
 * 2. Note wikilinks ([[repo:name/file.ts#symbol]], [[code:...]])
 *
 * Emits an in-app and optional email notification to the repository owner if drift is detected.
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

  const symbols = await db
    .select({
      name: repositoryFileSymbols.name,
      filePath: repositoryFiles.path,
    })
    .from(repositoryFileSymbols)
    .innerJoin(repositoryFiles, eq(repositoryFiles.id, repositoryFileSymbols.fileId))
    .where(eq(repositoryFiles.repositoryId, repositoryId))

  const fileSymbolsMap = new Map<string, Set<string>>()
  for (const s of symbols) {
    let set = fileSymbolsMap.get(s.filePath)
    if (!set) {
      set = new Set<string>()
      fileSymbolsMap.set(s.filePath, set)
    }
    set.add(s.name)
  }

  // ponytail: query note_links and frontmatter sources matching repo to avoid loading entire database into RAM (GRAPH-08).
  const matchingLinks = await db
    .select({ sourceNoteId: noteLinks.sourceNoteId })
    .from(noteLinks)
    .where(
      sql`${noteLinks.targetPath} ILIKE ${'repo:' + repositoryId + '%'}
       OR ${noteLinks.targetPath} ILIKE ${'repo:' + repo.name + '%'}
       OR ${noteLinks.targetPath} ILIKE ${'code:' + repositoryId + '%'}
       OR ${noteLinks.targetPath} ILIKE ${'code:' + repo.name + '%'}`,
    )

  const matchingFm = await db.execute(sql`
    SELECT id FROM notes
    WHERE deleted_at IS NULL
      AND (
        frontmatter::text ILIKE ${'%"repo:' + repositoryId + '/%'}
        OR frontmatter::text ILIKE ${'%"repo:' + repo.name + '/%'}
      )
  `)

  const candidateIds = new Set<string>()
  for (const r of matchingLinks) candidateIds.add(r.sourceNoteId)
  for (const r of matchingFm as unknown as Array<{ id: string }>) candidateIds.add(r.id)

  if (candidateIds.size === 0) return []

  const candidateIdArray = [...candidateIds]
  const liveNotes = await db
    .select({
      id: notes.id,
      path: notes.path,
      vaultId: notes.vaultId,
      frontmatter: notes.frontmatter,
      body: notes.body,
    })
    .from(notes)
    .where(and(isNull(notes.deletedAt), inArray(notes.id, candidateIdArray)))

  const drifts: StalenessDrift[] = []
  const prefixId = `repo:${repositoryId}/`
  const prefixName = repo.name ? `repo:${repo.name}/` : null

  for (const note of liveNotes) {
    // 1. Check OKF v0.2 frontmatter sources
    const fm = note.frontmatter as OkfV2Frontmatter | null
    if (fm) {
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

        filePath = filePath.split('#')[0] ?? ''
        if (!filePath) continue

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

        const currentHash = fileHashMap.get(filePath) ?? null

        if (currentHash === null) {
          drifts.push({
            noteId: note.id,
            notePath: note.path,
            vaultId: note.vaultId,
            resource: source.resource,
            expectedHash,
            currentHash: null,
            kind: 'deleted_file',
            detail: `Referenced file "${filePath}" does not exist in repository.`,
          })
        } else if (expectedHash && currentHash !== expectedHash) {
          drifts.push({
            noteId: note.id,
            notePath: note.path,
            vaultId: note.vaultId,
            resource: source.resource,
            expectedHash,
            currentHash,
            kind: 'hash_mismatch',
            detail: `File content hash changed from ${expectedHash.slice(0, 8)} to ${currentHash.slice(0, 8)}.`,
          })
        }
      }
    }

    // 2. Check note body wikilinks for repo/code targets
    if (note.body) {
      for (const match of note.body.matchAll(/\[\[((?:repo:|code:)[^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
        const rawTarget = match[1]!.trim()
        const withoutPrefix = rawTarget.startsWith('repo:')
          ? rawTarget.slice('repo:'.length)
          : rawTarget.slice('code:'.length)

        const [fileAndRepo = '', anchor] = withoutPrefix.split('#')
        let repoKey = ''
        let filePath = ''

        const colonIdx = fileAndRepo.indexOf(':')
        if (colonIdx !== -1) {
          repoKey = fileAndRepo.slice(0, colonIdx)
          filePath = fileAndRepo.slice(colonIdx + 1)
        } else {
          const slashIdx = fileAndRepo.indexOf('/')
          if (slashIdx !== -1) {
            repoKey = fileAndRepo.slice(0, slashIdx)
            filePath = fileAndRepo.slice(slashIdx + 1)
          } else {
            repoKey = fileAndRepo
            filePath = ''
          }
        }

        if (
          repoKey !== repositoryId &&
          repoKey.toLowerCase() !== repo.name.toLowerCase()
        ) {
          continue
        }

        if (!fileHashMap.has(filePath)) {
          drifts.push({
            noteId: note.id,
            notePath: note.path,
            vaultId: note.vaultId,
            resource: rawTarget,
            currentHash: null,
            kind: 'deleted_file',
            detail: `Referenced code file "${filePath}" was removed or does not exist.`,
          })
          continue
        }

        if (anchor && !/^L?\d+$/i.test(anchor)) {
          const knownSymbols = fileSymbolsMap.get(filePath)
          if (!knownSymbols || !knownSymbols.has(anchor)) {
            drifts.push({
              noteId: note.id,
              notePath: note.path,
              vaultId: note.vaultId,
              resource: rawTarget,
              currentHash: fileHashMap.get(filePath) ?? null,
              kind: 'missing_symbol',
              detail: `Referenced symbol "#${anchor}" not found in "${filePath}".`,
            })
          }
        }
      }
    }
  }

  // Deduplicate by noteId + resource + kind
  const uniqueDrifts: StalenessDrift[] = []
  const seenDrift = new Set<string>()
  for (const d of drifts) {
    const key = `${d.noteId}:${d.resource}:${d.kind}`
    if (!seenDrift.has(key)) {
      seenDrift.add(key)
      uniqueDrifts.push(d)
    }
  }

  if (uniqueDrifts.length > 0 && repo.ownerId) {
    const driftSummary = uniqueDrifts
      .slice(0, 5)
      .map((d) => `${d.notePath} -> ${d.resource} (${d.kind})`)
      .join(', ')
    await notify({
      recipientId: repo.ownerId,
      type: 'code_drift_detected',
      entityType: 'repository',
      entityId: repositoryId,
      message: `Code drift detected across ${uniqueDrifts.length} note reference(s) for repository "${repo.name}".`,
      emailSubject: 'Code Drift Detected',
      emailText: `Code drift was detected in repository "${repo.name}" across ${uniqueDrifts.length} note reference(s):\n${driftSummary}`,
    }).catch((err) => {
      console.error('[CodeStaleness] Failed to send notification:', err)
    })
  }

  return uniqueDrifts
}
