import type { RepositoryFile } from '../../api/repositories.js'

export interface FileTreeFile {
  kind: 'file'
  /** Last path segment — what the row shows. */
  name: string
  /** Full path — what the row links to and is named by. */
  path: string
  file: RepositoryFile
}

export interface FileTreeFolder {
  kind: 'folder'
  name: string
  /** Slash-joined path of this folder, no trailing slash. */
  path: string
  children: FileTreeNode[]
}

export type FileTreeNode = FileTreeFile | FileTreeFolder

/**
 * A directory tree from the flat, slash-separated paths the index serves.
 * Folders come first at every level, then files, each group sorted by name —
 * the order every editor's explorer uses, so the eye lands where it expects.
 *
 * Pure: the same input builds the same tree, which is what makes it worth
 * testing on its own rather than through the component that renders it.
 */
export function buildFileTree(files: readonly RepositoryFile[]): FileTreeNode[] {
  const root: FileTreeFolder = { kind: 'folder', name: '', path: '', children: [] }
  const folders = new Map<string, FileTreeFolder>([['', root]])

  function folderFor(path: string): FileTreeFolder {
    const existing = folders.get(path)
    if (existing) return existing
    const slash = path.lastIndexOf('/')
    const parent = folderFor(slash === -1 ? '' : path.slice(0, slash))
    const folder: FileTreeFolder = {
      kind: 'folder',
      name: slash === -1 ? path : path.slice(slash + 1),
      path,
      children: [],
    }
    parent.children.push(folder)
    folders.set(path, folder)
    return folder
  }

  for (const file of files) {
    // Empty segments (a leading slash, a doubled one) are not directories.
    const segments = file.path.split('/').filter((s) => s !== '')
    if (segments.length === 0) continue
    const name = segments[segments.length - 1]!
    const parent = folderFor(segments.slice(0, -1).join('/'))
    parent.children.push({ kind: 'file', name, path: segments.join('/'), file })
  }

  sortChildren(root)
  return root.children
}

function sortChildren(folder: FileTreeFolder): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    // Byte order, not localeCompare: locale collation varies by machine, and
    // the tree must render identically everywhere (and match the tests).
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  for (const child of folder.children) {
    if (child.kind === 'folder') sortChildren(child)
  }
}

/**
 * Every folder on the way to `path`, outermost first — `a/b/c.ts` gives
 * `['a', 'a/b']`. What must be expanded for that file's row to be visible.
 */
export function ancestorFolders(path: string): string[] {
  const segments = path.split('/').filter((s) => s !== '')
  const ancestors: string[] = []
  for (let i = 1; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i).join('/'))
  }
  return ancestors
}
