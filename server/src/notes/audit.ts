import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories, repositoryFiles } from '../db/schema.js'
import { resolveRepositoryAccess } from '../repositories/permissions.js'
import {
  extractWikilinks,
  isValidIsoDateTime,
  validateNote,
  type Frontmatter,
} from './okf.js'
import { resolveNotePath } from './okf/paths.js'
import { listNotes, readNote, vaultDir } from './store.js'

export interface ConformanceViolation {
  path: string
  message: string
  rule?: string
}

export interface BrokenWikilink {
  path: string
  link: string
  target: string
}

export interface BrokenRepoLink {
  path: string
  link: string
  repositoryId?: string
}

export interface ConformanceAuditResult {
  vaultId: string
  totalNotes: number
  conformingNotes: number
  conformanceScore: number
  violations: ConformanceViolation[]
  brokenWikilinks: BrokenWikilink[]
  brokenRepoLinks: BrokenRepoLink[]
  orphanNotes: string[]
  missingIndices: string[]
}

export interface AuditNoteInput {
  path: string
  name: string
  type: string
  frontmatter: Frontmatter
  body: string
}

export interface AuditHooks {
  getNotes?: (vaultId: string) => Promise<Array<{ path: string; name: string; type: string }>>
  readNoteContent?: (vaultId: string, path: string) => Promise<{ frontmatter: Frontmatter; body: string } | null>
  checkRepoFile?: (userId: string, repoIdOrName: string, filePath: string) => Promise<{ accessible: boolean; exists: boolean; resolvedRepoId?: string }>
  checkIndexExists?: (vaultId: string, dir: string) => Promise<boolean>
}

/**
 * Core OKF v0.2 conformance audit engine.
 */
export async function auditVaultConformance(
  vaultId: string,
  userId: string,
  hooks?: AuditHooks,
): Promise<ConformanceAuditResult> {
  const allNotes = hooks?.getNotes
    ? await hooks.getNotes(vaultId)
    : await listNotes(vaultId)

  const liveNotePaths = new Set(allNotes.map((n) => n.path))
  const noteNames = new Set(allNotes.map((n) => n.name))

  const violations: ConformanceViolation[] = []
  const brokenWikilinks: BrokenWikilink[] = []
  const brokenRepoLinks: BrokenRepoLink[] = []
  const missingIndices: string[] = []
  const nonConformingNotePaths = new Set<string>()

  const incomingLinks = new Map<string, number>()
  const outgoingLinks = new Map<string, number>()

  for (const n of allNotes) {
    incomingLinks.set(n.path, 0)
    outgoingLinks.set(n.path, 0)
  }

  // Repository cache for database lookups
  const repoCache = new Map<string, { id: string } | null>()
  const repoFilesCache = new Map<string, Set<string>>()

  const defaultCheckRepoFile = async (
    uid: string,
    repoIdOrName: string,
    filePath: string,
  ): Promise<{ accessible: boolean; exists: boolean; resolvedRepoId?: string }> => {
    let repo = repoCache.get(repoIdOrName)
    if (repo === undefined) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        repoIdOrName,
      )
      const found = isUuid
        ? await db
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.id, repoIdOrName))
            .limit(1)
        : await db
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.name, repoIdOrName))
            .limit(1)

      if (found[0]) {
        const access = await resolveRepositoryAccess(uid, found[0].id)
        repo = access ? found[0] : null
      } else {
        repo = null
      }
      repoCache.set(repoIdOrName, repo)
    }

    if (!repo) {
      return { accessible: false, exists: false }
    }

    let files = repoFilesCache.get(repo.id)
    if (files === undefined) {
      const rows = await db
        .select({ path: repositoryFiles.path })
        .from(repositoryFiles)
        .where(eq(repositoryFiles.repositoryId, repo.id))
      files = new Set(rows.map((r) => r.path))
      repoFilesCache.set(repo.id, files)
    }

    return {
      accessible: true,
      exists: files.has(filePath),
      resolvedRepoId: repo.id,
    }
  }

  const checkRepoFile = hooks?.checkRepoFile ?? defaultCheckRepoFile

  const defaultCheckIndexExists = async (vId: string, dir: string): Promise<boolean> => {
    try {
      await access(join(vaultDir(vId), dir, 'index.md'))
      return true
    } catch {
      return false
    }
  }

  const checkIndexExists = hooks?.checkIndexExists ?? defaultCheckIndexExists

  for (const n of allNotes) {
    const noteData = hooks?.readNoteContent
      ? await hooks.readNoteContent(vaultId, n.path)
      : await readNote(vaultId, n.path)

    if (!noteData) {
      violations.push({ path: n.path, message: 'unable to read note content' })
      nonConformingNotePaths.add(n.path)
      continue
    }

    const { frontmatter, body } = noteData
    const resolved = resolveNotePath(n.path)
    let noteHasViolation = false

    // 1. Validation rules check
    try {
      validateNote(resolved.type, resolved.name, frontmatter, body)
    } catch (err) {
      noteHasViolation = true
      violations.push({
        path: n.path,
        message: err instanceof Error ? err.message : String(err),
      })
    }

    // 2. Strict datetime checks across all frontmatter fields
    if (frontmatter.timestamp !== undefined && !isValidIsoDateTime(frontmatter.timestamp)) {
      const msg = 'timestamp must be an ISO 8601 datetime with explicit UTC/offset'
      if (!violations.some((v) => v.path === n.path && v.message === msg)) {
        noteHasViolation = true
        violations.push({ path: n.path, message: msg })
      }
    }
    if (frontmatter.stale_after !== undefined && !isValidIsoDateTime(frontmatter.stale_after)) {
      const msg = 'stale_after must be an ISO 8601 datetime with explicit UTC/offset'
      if (!violations.some((v) => v.path === n.path && v.message === msg)) {
        noteHasViolation = true
        violations.push({ path: n.path, message: msg })
      }
    }
    if (frontmatter.generated?.at !== undefined && !isValidIsoDateTime(frontmatter.generated.at)) {
      const msg = 'generated.at must be an ISO 8601 datetime with explicit UTC/offset'
      if (!violations.some((v) => v.path === n.path && v.message === msg)) {
        noteHasViolation = true
        violations.push({ path: n.path, message: msg })
      }
    }
    if (Array.isArray(frontmatter.sources)) {
      for (const s of frontmatter.sources) {
        if (s && typeof s === 'object' && s.last_modified !== undefined && !isValidIsoDateTime(s.last_modified)) {
          const msg = 'sources item last_modified must be an ISO 8601 datetime with explicit UTC/offset'
          if (!violations.some((v) => v.path === n.path && v.message === msg)) {
            noteHasViolation = true
            violations.push({ path: n.path, message: msg })
          }
        }
      }
    }
    const verifiedList = Array.isArray(frontmatter.verified)
      ? frontmatter.verified
      : frontmatter.verified && typeof frontmatter.verified === 'object'
        ? [frontmatter.verified]
        : []
    for (const ver of verifiedList) {
      if (ver?.at !== undefined && !isValidIsoDateTime(ver.at)) {
        const msg = 'verified.at must be an ISO 8601 datetime with explicit UTC/offset'
        if (!violations.some((v) => v.path === n.path && v.message === msg)) {
          noteHasViolation = true
          violations.push({ path: n.path, message: msg })
        }
      }
    }
    if (frontmatter.usage_window?.from !== undefined && !isValidIsoDateTime(frontmatter.usage_window.from)) {
      const msg = 'usage_window.from must be an ISO 8601 datetime with explicit UTC/offset'
      if (!violations.some((v) => v.path === n.path && v.message === msg)) {
        noteHasViolation = true
        violations.push({ path: n.path, message: msg })
      }
    }
    if (frontmatter.usage_window?.to !== undefined && !isValidIsoDateTime(frontmatter.usage_window.to)) {
      const msg = 'usage_window.to must be an ISO 8601 datetime with explicit UTC/offset'
      if (!violations.some((v) => v.path === n.path && v.message === msg)) {
        noteHasViolation = true
        violations.push({ path: n.path, message: msg })
      }
    }

    if (noteHasViolation) {
      nonConformingNotePaths.add(n.path)
    }

    // 3. Extract wikilinks from body
    const wikilinks = extractWikilinks(body)
    outgoingLinks.set(n.path, wikilinks.length)

    for (const link of wikilinks) {
      if (link.startsWith('repo:')) {
        const repoPart = link.slice(5)
        const slashIdx = repoPart.indexOf('/')
        if (slashIdx === -1) {
          brokenRepoLinks.push({ path: n.path, link, repositoryId: repoPart })
          nonConformingNotePaths.add(n.path)
          continue
        }
        const repoIdOrName = repoPart.slice(0, slashIdx)
        const filePath = repoPart.slice(slashIdx + 1).split('#')[0]!

        const check = await checkRepoFile(userId, repoIdOrName, filePath)
        if (!check.accessible || !check.exists) {
          brokenRepoLinks.push({
            path: n.path,
            link,
            repositoryId: check.resolvedRepoId ?? repoIdOrName,
          })
          nonConformingNotePaths.add(n.path)
        }
      } else {
        let targetPath = link.split('#')[0]!.split('|')[0]!.trim()
        if (targetPath.endsWith('.md')) targetPath = targetPath.slice(0, -3)
        if (targetPath.startsWith('/')) targetPath = targetPath.slice(1)

        let resolvedTarget: string | null = null
        if (liveNotePaths.has(targetPath)) {
          resolvedTarget = targetPath
        } else if (noteNames.has(targetPath)) {
          const match = allNotes.find((other) => other.name === targetPath)
          if (match) resolvedTarget = match.path
        }

        if (resolvedTarget) {
          incomingLinks.set(resolvedTarget, (incomingLinks.get(resolvedTarget) ?? 0) + 1)
        } else {
          brokenWikilinks.push({ path: n.path, link, target: targetPath })
          nonConformingNotePaths.add(n.path)
        }
      }
    }

    // 4. Derive ancestor directories and verify index.md exists
    for (const dir of resolved.ancestorDirectories) {
      const exists = await checkIndexExists(vaultId, dir)
      if (!exists) {
        missingIndices.push(dir)
      }
    }
  }

  // 5. Find orphan notes (no incoming and no outgoing wikilinks, excluding root bundle files)
  const orphanNotes: string[] = []
  for (const n of allNotes) {
    const resolved = resolveNotePath(n.path)
    if (resolved.isRootBundleFile) continue

    const incoming = incomingLinks.get(n.path) ?? 0
    const outgoing = outgoingLinks.get(n.path) ?? 0
    if (incoming === 0 && outgoing === 0) {
      orphanNotes.push(n.path)
      nonConformingNotePaths.add(n.path)
    }
  }

  const totalNotes = allNotes.length
  const conformingCount = allNotes.filter((n) => !nonConformingNotePaths.has(n.path)).length
  const conformanceScore =
    totalNotes === 0 ? 100 : Math.round((conformingCount / totalNotes) * 100)

  return {
    vaultId,
    totalNotes,
    conformingNotes: conformingCount,
    conformanceScore,
    violations,
    brokenWikilinks,
    brokenRepoLinks,
    orphanNotes,
    missingIndices: [...new Set(missingIndices)],
  }
}
