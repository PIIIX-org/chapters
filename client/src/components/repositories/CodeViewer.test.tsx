import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRef } from 'react'
import { act, render, screen } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { mockJsonResponse } from '../../lib/api.js'
import { expectNoA11yViolations } from '../../test/axe.js'
import type { Repository, RepositoryFileContent } from '../../api/repositories.js'
import { CodeViewer, type CodeViewerHandle } from './CodeViewer.js'

type RepoProp = Pick<Repository, 'id' | 'ingestionMethod' | 'gitUrl' | 'defaultBranch'>

// One git repository and one that cannot possibly have a deep link. A fixture
// with only a git repo would let a viewer that renders the button
// unconditionally pass.
const GIT_REPO: RepoProp = {
  id: 'r1',
  ingestionMethod: 'git',
  gitUrl: 'https://github.com/piiix-org/chapters.git',
  defaultBranch: 'dev',
}
const LOCAL_REPO: RepoProp = {
  id: 'r2',
  ingestionMethod: 'local_path',
  gitUrl: null,
  defaultBranch: null,
}

// Lines 1-5 are load-bearing for the outline assertions below (a symbol at
// line 2 and one at line 5); the comment and string live after them.
const CODE = [
  'const a = 1',
  'export function alpha() {',
  '  return a',
  '}',
  'export class Beta {}',
  '// tail note',
  "const label = 'beta'",
].join('\n')

const TS_FILE: RepositoryFileContent = {
  id: 'f1',
  path: 'client/src/thing.ts',
  language: 'typescript',
  size: CODE.length,
  updatedAt: '2026-08-24T11:02:11.000Z',
  content: CODE,
  contentHash: 'sha256-abc',
  sourceModifiedAt: '2026-08-20T09:12:00.000Z',
  // Different kinds and different lines, so a click can be traced to one row.
  symbols: [
    { name: 'alpha', kind: 'function', startLine: 2, endLine: 4 },
    { name: 'Beta', kind: 'class', startLine: 5, endLine: 5 },
  ],
}

// Same source in two languages, so a viewer that highlights everything with
// one hardcoded mode fails: `#` opens a comment in Python and does not in
// TypeScript, and `def`/`const` are keywords in one language each.
const PY_CODE = ['# the count', 'def alpha():', '    n = 41', "    return 'a' + str(n)"].join('\n')

const PY_FILE: RepositoryFileContent = {
  ...TS_FILE,
  id: 'f2',
  path: 'scripts/seed.py',
  language: 'python',
  size: PY_CODE.length,
  content: PY_CODE,
  symbols: [{ name: 'alpha', kind: 'function', startLine: 2, endLine: 4 }],
}

// A language the index labels but nothing in the client has a mode for — it
// must still read, as plain mono text.
const RUST_FILE: RepositoryFileContent = {
  ...TS_FILE,
  id: 'f3',
  path: 'src/main.rs',
  language: 'rust',
  size: 24,
  content: 'fn main() { let a = 1; }',
  symbols: [],
}

function textsOf(container: HTMLElement, className: string): string[] {
  return [...container.querySelectorAll(className)].map((el) => el.textContent ?? '')
}

function renderWithClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function stubFile(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(status, body)))
}

function editorView(): EditorView {
  return EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
}

describe('CodeViewer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the file’s code with no way to edit it', async () => {
    // The symbol outline no longer renders here — it is an inspector tab on
    // RepositoryPage, wired back through the revealLine handle below.
    stubFile(TS_FILE)
    const { container } = renderWithClient(<CodeViewer repository={GIT_REPO} path={TS_FILE.path} />)

    // CM6's content element is an ARIA textbox; it needs a name of its own.
    const content = await screen.findByRole('textbox', { name: `${TS_FILE.path} (read-only)` })
    expect(content.textContent).toContain('export class Beta {}')
    // Read-only is the whole design boundary: no caret, no edit transactions.
    expect(content.getAttribute('contenteditable')).toBe('false')
    expect(editorView().state.readOnly).toBe(true)

    await expectNoA11yViolations(container)
  })

  it('asks for the file by path and offers GitHub only for the git repository', async () => {
    stubFile(TS_FILE)
    const { rerender } = renderWithClient(<CodeViewer repository={GIT_REPO} path={TS_FILE.path} />)

    const link = await screen.findByRole('link', { name: `Open ${TS_FILE.path} on GitHub` })
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/piiix-org/chapters/blob/dev/client/src/thing.ts',
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/repositories/r1/files/content?path=client%2Fsrc%2Fthing.ts',
      expect.anything(),
    )

    // Same file, a repository with no remote: the button is absent, not disabled.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={queryClient}>
        <CodeViewer repository={LOCAL_REPO} path={TS_FILE.path} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /on GitHub/ })).toBeNull()
  })

  it('surfaces a failed read instead of rendering it as an empty file', async () => {
    stubFile({ error: 'repository not found' }, 404)
    const { container } = renderWithClient(<CodeViewer repository={GIT_REPO} path={TS_FILE.path} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('repository not found')
    // Neither an empty editor nor an empty outline may appear in its place.
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Symbol outline' })).toBeNull()
  })

  it('moves the viewer to the line the outline asks for, via its handle', async () => {
    stubFile(TS_FILE)
    const handle = createRef<CodeViewerHandle>()
    renderWithClient(<CodeViewer repository={GIT_REPO} path={TS_FILE.path} ref={handle} />)
    await screen.findByRole('textbox', { name: `${TS_FILE.path} (read-only)` })

    act(() => handle.current!.revealLine(5))

    const view = editorView()
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from)
    expect(view.state.selection.main.head).not.toBe(0)
  })

  it('refuses to render a file past the size cap, and shows no outline beside what it did not mount', async () => {
    stubFile({ ...TS_FILE, size: 600 * 1024 })
    const { container } = renderWithClient(<CodeViewer repository={GIT_REPO} path={TS_FILE.path} />)

    expect(await screen.findByText(/too large to show here/)).toBeInTheDocument()
    expect(screen.getByText(/Open it on GitHub instead/)).toBeInTheDocument()
    expect(container.querySelector('.cm-editor')).toBeNull()
    // The outline is a jump list: with no editor to move, every row is dead.
    expect(screen.queryByRole('navigation', { name: 'Symbol outline' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'alpha, function, line 2' })).toBeNull()
  })

  it('highlights the file in the language the index recorded', async () => {
    stubFile(TS_FILE)
    const { container } = renderWithClient(<CodeViewer repository={GIT_REPO} path={TS_FILE.path} />)

    await screen.findByRole('textbox', { name: `${TS_FILE.path} (read-only)` })

    expect(textsOf(container, '.cm-code-keyword')).toEqual(
      expect.arrayContaining(['const', 'export', 'function', 'class']),
    )
    expect(textsOf(container, '.cm-code-comment')).toContain('// tail note')
    expect(textsOf(container, '.cm-code-string')).toContain("'beta'")
    expect(textsOf(container, '.cm-code-number')).toContain('1')
  })

  it('uses that language’s rules, not one mode for every file', async () => {
    stubFile(PY_FILE)
    const { container } = renderWithClient(<CodeViewer repository={GIT_REPO} path={PY_FILE.path} />)

    await screen.findByRole('textbox', { name: `${PY_FILE.path} (read-only)` })

    // `#` opens a comment here and `def` is a keyword — neither is true under
    // the TypeScript mode the previous test exercised.
    expect(textsOf(container, '.cm-code-comment')).toContain('# the count')
    expect(textsOf(container, '.cm-code-keyword')).toEqual(expect.arrayContaining(['def', 'return']))
    expect(textsOf(container, '.cm-code-keyword')).not.toContain('const')
  })

  it('still renders a language it has no mode for, as plain text', async () => {
    stubFile(RUST_FILE)
    const { container } = renderWithClient(<CodeViewer repository={GIT_REPO} path={RUST_FILE.path} />)

    const content = await screen.findByRole('textbox', { name: `${RUST_FILE.path} (read-only)` })
    expect(content.textContent).toContain('fn main()')
    // Not "highlighted wrong": not highlighted at all.
    expect(container.querySelectorAll('.cm-code-keyword')).toHaveLength(0)
    expect(container.querySelectorAll('.cm-code-comment')).toHaveLength(0)

    await expectNoA11yViolations(container)
  })
})
