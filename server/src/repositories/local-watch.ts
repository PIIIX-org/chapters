import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import chokidar from 'chokidar'
import { syncRepositoryFiles, type FileUpdate } from './store.js'

// ponytail: hardcoded ignore list, not full .gitignore parsing — covers
// the overwhelming common case (vendored deps, git internals) cheaply.
const IGNORED = /(^|\/)(\.git|node_modules)(\/|$)/

const DEBOUNCE_MS = 300

async function listCurrentPaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .filter((p) => !IGNORED.test(p))
}

/** Real-time local-path ingestion (spec 8). Returns a stop() to close the watcher. */
export function startWatching(repositoryId: string, localPath: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null

  // ponytail: rescans + rereads every file on any change (syncRepositoryFiles's
  // hash check filters out the no-ops); switch to chokidar's per-event paths
  // if profiling shows this matters for very large local trees.
  const runSync = () => {
    void (async () => {
      const currentPaths = await listCurrentPaths(localPath)
      const files: FileUpdate[] = []
      for (const path of currentPaths) {
        try {
          files.push({ path, content: await readFile(join(localPath, path), 'utf8') })
        } catch {
          // File vanished between listing and reading (rename/delete race) — skip it,
          // the next sync's manifest will reflect reality.
        }
      }
      await syncRepositoryFiles(repositoryId, files, currentPaths)
    })()
  }

  const watcher = chokidar.watch(localPath, {
    ignored: (path) => IGNORED.test(relative(localPath, path)),
    ignoreInitial: false,
  })
  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(runSync, DEBOUNCE_MS)
  })

  return () => {
    if (timer) clearTimeout(timer)
    void watcher.close()
  }
}
