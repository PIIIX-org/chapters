import { describe, expect, it } from 'vitest'
import type { RepositoryFile } from '../../api/repositories.js'
import { ancestorFolders, buildFileTree, type FileTreeNode } from './fileTree.js'

function file(path: string): RepositoryFile {
  return { id: `id:${path}`, path, language: null, size: 1, updatedAt: '2026-08-24T11:00:00.000Z' }
}

/** The tree as indented names — one line per node, folders suffixed with `/`. */
function outline(nodes: FileTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'folder'
      ? [`${'  '.repeat(depth)}${node.name}/`, ...outline(node.children, depth + 1)]
      : [`${'  '.repeat(depth)}${node.name}`],
  )
}

describe('buildFileTree', () => {
  it('nests files under their directories, folders first, each level sorted by name', () => {
    // Deliberately out of order, with root files, nested folders and a folder
    // whose name sorts after a sibling file's — a builder that sorted
    // everything together, or kept input order, would fail here.
    const tree = buildFileTree([
      file('server/src/app.ts'),
      file('README.md'),
      file('client/src/lib/api.ts'),
      file('scripts/seed.py'),
      file('server/src/graph/louvain.ts'),
      file('client/src/hooks/useGraph.ts'),
      file('package.json'),
      file('server/src/graph/assemble.ts'),
    ])

    expect(outline(tree)).toEqual([
      'client/',
      '  src/',
      '    hooks/',
      '      useGraph.ts',
      '    lib/',
      '      api.ts',
      'scripts/',
      '  seed.py',
      'server/',
      '  src/',
      '    graph/',
      '      assemble.ts',
      '      louvain.ts',
      '    app.ts',
      'README.md',
      'package.json',
    ])
  })

  it('keeps the full path and the original row on every file, and a path on every folder', () => {
    const [server] = buildFileTree([file('server/src/app.ts')])
    expect(server).toMatchObject({ kind: 'folder', name: 'server', path: 'server' })
    const src = (server as { children: FileTreeNode[] }).children[0]!
    expect(src).toMatchObject({ kind: 'folder', name: 'src', path: 'server/src' })
    const app = (src as { children: FileTreeNode[] }).children[0]!
    expect(app).toMatchObject({
      kind: 'file',
      name: 'app.ts',
      path: 'server/src/app.ts',
      file: { id: 'id:server/src/app.ts' },
    })
  })

  it('shares one folder between files that live in it', () => {
    const tree = buildFileTree([file('a/one.ts'), file('a/two.ts'), file('a/b/three.ts')])
    expect(outline(tree)).toEqual(['a/', '  b/', '    three.ts', '  one.ts', '  two.ts'])
  })

  it('ignores empty segments instead of inventing nameless folders', () => {
    const tree = buildFileTree([file('/lead/x.ts'), file('double//slash.ts'), file('')])
    expect(outline(tree)).toEqual(['double/', '  slash.ts', 'lead/', '  x.ts'])
  })

  it('builds nothing from nothing', () => {
    expect(buildFileTree([])).toEqual([])
  })
})

describe('ancestorFolders', () => {
  it('lists every folder above a file, outermost first', () => {
    expect(ancestorFolders('server/src/graph/louvain.ts')).toEqual([
      'server',
      'server/src',
      'server/src/graph',
    ])
  })

  it('has no ancestors for a root file or an empty path', () => {
    expect(ancestorFolders('README.md')).toEqual([])
    expect(ancestorFolders('')).toEqual([])
  })
})
