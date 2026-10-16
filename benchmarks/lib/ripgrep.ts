// The grep policy's tools over a checkout: real ripgrep for search, plain
// file reads for ranged reads (an agent's Read with offset/limit). Bun only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GrepTools } from './policies.ts'

/** Lines of a checkout file, cached per path. */
export function fileReader(root: string): (path: string) => string[] {
  const cache = new Map<string, string[]>()
  return (path) => {
    let lines = cache.get(path)
    if (!lines) {
      lines = readFileSync(join(root, path), 'utf8').split('\n')
      cache.set(path, lines)
    }
    return lines
  }
}

/**
 * ripgrep in `root`: case-insensitive, every file of the checkout (the
 * checkout has no .git, so --no-ignore only stops .ignore files from hiding
 * tracked files; --hidden keeps .github and other dot paths). Binary files
 * are skipped by ripgrep itself.
 */
async function rg(root: string, args: string[]): Promise<{ stdout: string; ms: number }> {
  const t0 = performance.now()
  const proc = Bun.spawn(['rg', '--ignore-case', '--no-ignore', '--hidden', '--no-messages', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  // 0 = matches, 1 = no match, 2 = error; an unreadable file alone also gives 2, with output.
  if (code > 1 && stdout === '') throw new Error(`rg ${args.join(' ')} failed (${code}): ${stderr.slice(0, 500)}`)
  return { stdout, ms: performance.now() - t0 }
}

export function grepTools(root: string, lines: (path: string) => string[]): GrepTools {
  const patterns = (ks: readonly string[]) => ks.flatMap((k) => ['-e', k])
  return {
    async count(keywords) {
      const r = await rg(root, ['--count', ...patterns(keywords)])
      const files = r.stdout
        .split('\n')
        .filter(Boolean)
        // Repository paths use '/', also when ripgrep runs on Windows.
        .map((l) => ({ path: l.slice(0, l.lastIndexOf(':')).replaceAll('\\', '/'), count: Number(l.slice(l.lastIndexOf(':') + 1)) }))
      return { files, ms: r.ms }
    },
    async matches(keywords, path) {
      const r = await rg(root, ['--line-number', '--no-filename', ...patterns(keywords), '--', path])
      const found = r.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => ({ line: Number(l.slice(0, l.indexOf(':'))), text: l.slice(l.indexOf(':') + 1) }))
      return { lines: found, ms: r.ms }
    },
    async read(path, start, end) {
      const t0 = performance.now()
      const all = lines(path)
      const from = Math.min(start, all.length)
      // Like an agent's Read tool: very long lines are cut.
      const slice = all.slice(from - 1, end).map((l) => (l.length > 2000 ? l.slice(0, 2000) : l))
      return { lines: slice, start: from, ms: performance.now() - t0 }
    },
  }
}
