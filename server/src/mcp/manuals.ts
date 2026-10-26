import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The tool manuals, served as MCP resources (#429) so that tool descriptions
 * can stay at two sentences. Their one source is the agent reference
 * `skills/elara/references/mcp-tools.md`; the image copies it to the same
 * place relative to the server. Its `## Transport and conventions` section is
 * one manual; each numbered tool section is one manual for its family of
 * tools, made of the text before the section's first tool and one
 * `` ### `tool` `` entry per tool.
 */
export const MANUAL_FILE = fileURLToPath(new URL('../../../skills/elara/references/mcp-tools.md', import.meta.url))

/** The manuals, by the start of their section heading in the reference. */
const FAMILIES = [
  {
    slug: 'conventions',
    heading: 'Transport and conventions',
    description: 'Scopes, access levels, profiles, budgets and `truncated`, strict arguments: rules every tool follows.',
  },
  { slug: 'vaults', heading: '1. ', description: 'The vault tools: parameters, answers and limits.' },
  {
    slug: 'notes',
    heading: '2. ',
    description: 'The note tools: reads, writes and their answers (rev, status, merges, conflicts, quarantine, idempotency_key, dry_run), trash and history.',
  },
  { slug: 'repositories', heading: '3. ', description: 'The repository tools: parameters, answers and limits.' },
  { slug: 'search', heading: '4. ', description: 'search and find_symbols: parameters and answers.' },
  { slug: 'graph', heading: '5. ', description: 'graph, find_graph_path and graph perspectives: parameters, answers and edge rows.' },
  { slug: 'teams', heading: '6. ', description: 'The team and user tools: parameters and answers.' },
  { slug: 'export', heading: '7. ', description: 'The export, notification and usage report tools: parameters and answers.' },
] as const

export interface ToolManual {
  uri: string
  name: string
  title: string
  description: string
  /** The section heading line, without its tool count. */
  heading: string
  /** The section's text before its first tool (all of it for the conventions). */
  preamble: string
  /** Each tool's entry by tool name, in the reference's order; `null` for the conventions. */
  entries: ReadonlyMap<string, string> | null
}

const TOOL_HEADING = /^### `([a-z_]+)`/

/** The reference's `## ` sections (outside code fences) by heading text, each with its lines after the heading. */
function sections(markdown: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  let current: string[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    if (!fenced && line.startsWith('## ')) {
      current = []
      found.set(line.slice(3).trim(), current)
    } else {
      current.push(line)
    }
  }
  return found
}

/** Lines as text, without the blank lines and `---` rules at either end. */
function trimmed(lines: string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && /^(\s*|---)$/.test(lines[start]!)) start++
  while (end > start && /^(\s*|---)$/.test(lines[end - 1]!)) end--
  return lines.slice(start, end).join('\n')
}

function parse(markdown: string): ToolManual[] {
  const bySection = [...sections(markdown)]
  return FAMILIES.map(({ slug, heading, description }) => {
    const matches = bySection.filter(([text]) => text.startsWith(heading))
    if (matches.length !== 1) throw new Error(`${MANUAL_FILE}: ${matches.length} sections start with "${heading}"`)
    const [text, lines] = matches[0]!
    const shown = text.replace(/\s*\(\d+ tools?\)$/, '')
    let entries: Map<string, string> | null = null
    let preamble = lines
    if (slug !== 'conventions') {
      entries = new Map()
      // Each tool heading starts an entry that runs to the next one.
      const starts = lines.flatMap((line, i) => (TOOL_HEADING.test(line) ? [i] : []))
      preamble = lines.slice(0, starts[0] ?? lines.length)
      for (const [k, start] of starts.entries()) {
        entries.set(TOOL_HEADING.exec(lines[start]!)![1]!, trimmed(lines.slice(start, starts[k + 1] ?? lines.length)))
      }
    }
    return {
      uri: `elara://manual/${slug}`,
      name: `manual-${slug}`,
      title: `Elara manual: ${shown.replace(/^\d+\.\s*/, '')}`,
      description,
      heading: `## ${shown}`,
      preamble: trimmed(preamble),
      entries,
    }
  })
}

let loaded: readonly ToolManual[] | undefined

/**
 * The manuals, read from the reference once per process. Without the file
 * (a deployment that left it out) there are none, and the tools work as
 * before; the error is logged once.
 */
export function toolManuals(): readonly ToolManual[] {
  if (loaded) return loaded
  try {
    loaded = parse(readFileSync(MANUAL_FILE, 'utf8'))
  } catch (err) {
    console.error('[mcp] tool manuals unavailable:', err)
    loaded = []
  }
  return loaded
}

/**
 * Whether a connection that lists the tools `listed` sees the manual: the
 * conventions when it lists any tool, a family's manual when it lists at
 * least one of the family's tools. One it does not see is neither listed nor
 * read. Builds no text.
 */
export function manualVisible(manual: ToolManual, listed: ReadonlySet<string>): boolean {
  if (listed.size === 0) return false
  return manual.entries === null || [...manual.entries.keys()].some((name) => listed.has(name))
}

/**
 * A manual as a connection that lists the tools `listed` reads it (call only
 * when `manualVisible`): the conventions whole; a family's preamble and the
 * entries of the tools it lists.
 */
export function manualText(manual: ToolManual, listed: ReadonlySet<string>): string {
  const entries = manual.entries ? [...manual.entries].filter(([name]) => listed.has(name)).map(([, text]) => text) : []
  return [manual.heading, ...(manual.preamble ? [manual.preamble] : []), ...entries].join('\n\n') + '\n'
}
