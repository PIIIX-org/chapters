// The two arms' tools, behind one interface for the agent loop.
//   elara: allow-listed read-only repository tools of the lab instance's MCP
//          server, offered with the server's own schemas; each call is one
//          MCP tools/call.
//   local: read_file / grep / list_files over a checkout of the same commit,
//          in plain node:fs (no ripgrep, no network), so the mapping is
//          unit-testable under `node --test`.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { JsonObjectSchema, ToolSpec } from './model.ts'

export interface ToolOutput {
  text: string
  isError: boolean
}

export interface Toolset {
  specs: ToolSpec[]
  run(name: string, args: Record<string, unknown>): Promise<ToolOutput>
}

// ---------------------------------------------------------------- Elara

/**
 * What the Elara arm may call: Elara's read-only tools for a repository. The
 * token is pinned to the trial repository with read access and this
 * allow-list, so the server refuses anything else as well.
 */
export const ELARA_TOOLS = ['search', 'find_symbols', 'read_file', 'browse_repository', 'repository_status', 'graph', 'find_graph_path']

/** The subset of an MCP tools/list entry the mapping reads. */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; ok: boolean }>

/** An MCP input schema as a model tool's parameters: an object schema without the draft marker. */
export function toParameters(schema: Record<string, unknown> | undefined): JsonObjectSchema {
  const rest: Record<string, unknown> = { ...schema }
  delete rest.$schema
  const properties = rest.properties && typeof rest.properties === 'object' ? (rest.properties as Record<string, unknown>) : {}
  return { ...rest, type: 'object', properties }
}

/** Tools offered to the Elara arm, in ELARA_TOOLS order; throws if the server lacks one. */
export function elaraToolset(listed: McpToolInfo[], call: McpCall, allow: readonly string[] = ELARA_TOOLS): Toolset {
  const byName = new Map(listed.map((t) => [t.name, t]))
  const missing = allow.filter((n) => !byName.has(n))
  if (missing.length > 0) throw new Error(`the MCP server does not list ${missing.join(', ')}`)
  const specs = allow.map((n) => {
    const t = byName.get(n)!
    return { name: n, description: t.description ?? n, parameters: toParameters(t.inputSchema) }
  })
  return {
    specs,
    async run(name, args) {
      if (!allow.includes(name)) return { text: `Error: unknown tool ${name}; available: ${allow.join(', ')}`, isError: true }
      const r = await call(name, args)
      return { text: r.text, isError: !r.ok }
    },
  }
}

// ---------------------------------------------------------------- local

/** Glob to RegExp over '/'-separated paths: `**` any depth, `*` and `?` within a segment, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  let braces = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` anything.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') {
      braces++
      out += '(?:'
    } else if (c === '}' && braces > 0) {
      braces--
      out += ')'
    } else if (c === ',' && braces > 0) out += '|'
    else out += c.replace(/[.+^$(){}|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024
const GREP_LINE_CHARS = 300
const READ_LINE_CHARS = 2_000

export const LOCAL_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_files',
    description:
      'List files of the repository checkout whose path matches a glob (`**` any depth, `*` within a directory, `{a,b}` alternatives), e.g. `server/src/**/*.ts`. Paths are relative to the repository root. At most `limit` paths (default 200, max 1000), sorted.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'glob, e.g. server/src/**/*.ts' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents with a JavaScript regular expression, line by line. Returns `path:line:text` for each matching line (text cut at 300 characters), at most `max_results` lines (default 100, max 500). Optional `path` limits the search to a directory or file; optional `glob` filters file paths (e.g. `**/*.test.ts`). Binary files and files over 2 MB are skipped.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', description: 'directory or file, relative to the repository root' },
        glob: { type: 'string' },
        ignore_case: { type: 'boolean' },
        max_results: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file of the repository checkout with line numbers. `offset` is the first line (1-based, default 1), `limit` the number of lines (default 400, max 2000). Lines longer than 2000 characters are cut.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } },
      required: ['path'],
    },
  },
]

function intArg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = args[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return fallback
  return Math.min(Math.floor(v), max)
}

/** The checkout-relative path, or null when it escapes the checkout. */
function safePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const p = raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (p.split('/').includes('..')) return null
  return p
}

/** Every file of the checkout, '/'-separated, sorted. */
function listAll(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

export function localToolset(root: string): Toolset {
  let files: string[] | undefined
  const text = new Map<string, string | null>()
  /** File content for grep; null for binary or oversized files. */
  const grepText = (path: string): string | null => {
    if (!text.has(path)) {
      const full = join(root, path)
      const buf = statSync(full).size > MAX_GREP_FILE_BYTES ? null : readFileSync(full)
      text.set(path, buf && !buf.subarray(0, 8192).includes(0) ? buf.toString('utf8') : null)
    }
    return text.get(path)!
  }
  const error = (message: string): ToolOutput => ({ text: `Error: ${message}`, isError: true })

  return {
    specs: LOCAL_TOOL_SPECS,
    async run(name, args) {
      try {
        if (name === 'list_files') {
          if (typeof args.pattern !== 'string' || args.pattern === '') return error('pattern is required')
          const re = globToRegExp(args.pattern.replace(/^\.\//, ''))
          const limit = intArg(args, 'limit', 200, 1000)
          const matched = (files ??= listAll(root)).filter((f) => re.test(f))
          const shown = matched.slice(0, limit)
          return { text: `${matched.length} file(s)${matched.length > limit ? `, first ${limit}` : ''}\n${shown.join('\n')}`, isError: false }
        }
        if (name === 'grep') {
          if (typeof args.pattern !== 'string' || args.pattern === '') return error('pattern is required')
          let re: RegExp
          try {
            re = new RegExp(args.pattern, args.ignore_case === true ? 'i' : '')
          } catch (err) {
            return error(`invalid regular expression: ${err instanceof Error ? err.message : String(err)}`)
          }
          const scope = args.path === undefined ? '' : safePath(args.path)
          if (scope === null) return error('path must stay inside the repository')
          const glob = typeof args.glob === 'string' && args.glob !== '' ? globToRegExp(args.glob) : null
          const max = intArg(args, 'max_results', 100, 500)
          const hits: string[] = []
          let total = 0
          for (const f of (files ??= listAll(root))) {
            if (scope && f !== scope && !f.startsWith(`${scope}/`)) continue
            if (glob && !glob.test(f)) continue
            const content = grepText(f)
            if (content === null) continue
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (!re.test(lines[i]!)) continue
              total++
              if (hits.length < max) hits.push(`${f}:${i + 1}:${lines[i]!.slice(0, GREP_LINE_CHARS)}`)
            }
          }
          return { text: total === 0 ? 'no matches' : `${total} matching line(s)${total > max ? `, first ${max}` : ''}\n${hits.join('\n')}`, isError: false }
        }
        if (name === 'read_file') {
          const path = safePath(args.path)
          if (!path) return error('path is required and must stay inside the repository')
          const all = readFileSync(join(root, path), 'utf8').split('\n')
          const offset = intArg(args, 'offset', 1, Number.MAX_SAFE_INTEGER)
          const limit = intArg(args, 'limit', 400, 2000)
          if (offset > all.length) return error(`offset ${offset} is past the end of ${path} (${all.length} lines)`)
          const slice = all.slice(offset - 1, offset - 1 + limit)
          const end = offset + slice.length - 1
          const body = slice.map((l, i) => `${offset + i}\t${l.length > READ_LINE_CHARS ? l.slice(0, READ_LINE_CHARS) : l}`).join('\n')
          return { text: `${path} lines ${offset}-${end} of ${all.length}\n${body}`, isError: false }
        }
        return error(`unknown tool ${name}; available: ${LOCAL_TOOL_SPECS.map((t) => t.name).join(', ')}`)
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
        return error(code === 'ENOENT' ? 'no such file' : code === 'EISDIR' ? 'is a directory (use list_files)' : err instanceof Error ? err.message : String(err))
      }
    },
  }
}
