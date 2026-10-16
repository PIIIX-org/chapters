// The agent trial's task file (benchmarks/agent-trial/tasks.json): the
// study's 8 A/B tasks with key facts and false claims, each tied to file:line
// evidence at the pinned commit. Node-compatible (no Bun APIs): the unit
// tests run under `node --test`.

/** A line range of a file at the pinned commit that must contain `contains`. */
export interface Evidence {
  path: string
  /** `N` or `N-M`, 1-based, inclusive. */
  lines: string
  contains: string
}

export interface Fact {
  id: string
  fact: string
  evidence: Evidence[]
  /** Case-insensitive regexes; the fact is found when every one matches the answer. */
  patterns: string[]
  /** A phrasing that must count as found (unit-tested). */
  sample: string
}

export interface FalseClaim {
  id: string
  claim: string
  refutedBy: string
  evidence: Evidence[]
  /** Case-insensitive regexes that must all match within one sentence. */
  patterns: string[]
  /** A sentence matching this regex is not flagged (default: DEFAULT_UNLESS in grade.ts). */
  unless?: string
  /** A sentence that must be flagged (unit-tested). */
  sample: string
  /** A sentence that repeats the claim to reject it and must not be flagged (unit-tested). */
  refutation: string
}

export interface Task {
  id: string
  title: string
  /** Why the prompt differs from the round-2 task, when it does. */
  adaptation?: string
  prompt: string
  facts: Fact[]
  falseClaims: FalseClaim[]
}

export interface TaskFile {
  version: number
  repo: { url: string; commit: string }
  source: string
  tasks: Task[]
}

export function parseLines(lines: string): { start: number; end: number } {
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines)
  if (!m) throw new Error(`bad line range "${lines}"`)
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : start
  if (start < 1 || end < start) throw new Error(`bad line range "${lines}"`)
  return { start, end }
}

function regexError(source: string): string | null {
  try {
    new RegExp(source, 'i')
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Structural problems of a task file; empty when it is usable. */
export function validateTasks(file: TaskFile): string[] {
  const errors: string[] = []
  if (!/^[0-9a-f]{40}$/.test(file.repo.commit)) errors.push(`repo.commit must be a full SHA, got ${file.repo.commit}`)
  if (!file.repo.url.startsWith('https://')) errors.push(`repo.url must be https, got ${file.repo.url}`)
  const ids = new Set<string>()
  const unique = (id: string) => {
    if (ids.has(id)) errors.push(`duplicate id ${id}`)
    ids.add(id)
  }
  const checkEvidence = (owner: string, evidence: Evidence[]) => {
    if (evidence.length === 0) errors.push(`${owner}: no evidence`)
    for (const e of evidence) {
      try {
        parseLines(e.lines)
      } catch (err) {
        errors.push(`${owner}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!e.path || e.path.startsWith('/') || e.path.includes('..')) errors.push(`${owner}: bad evidence path "${e.path}"`)
      if (!e.contains) errors.push(`${owner}: evidence ${e.path}:${e.lines} has no anchor`)
    }
  }
  const checkPatterns = (owner: string, patterns: string[]) => {
    if (patterns.length === 0) errors.push(`${owner}: no patterns`)
    for (const p of patterns) {
      const err = regexError(p)
      if (err) errors.push(`${owner}: pattern ${p}: ${err}`)
      else if (new RegExp(p, 'i').test('')) errors.push(`${owner}: pattern ${p} matches the empty string`)
    }
  }
  for (const t of file.tasks) {
    unique(t.id)
    if (!t.prompt.trim()) errors.push(`${t.id}: empty prompt`)
    if (t.facts.length === 0) errors.push(`${t.id}: no facts`)
    for (const f of t.facts) {
      unique(f.id)
      if (!f.id.startsWith(`${t.id}.`)) errors.push(`${f.id}: id must start with ${t.id}.`)
      checkEvidence(f.id, f.evidence)
      checkPatterns(f.id, f.patterns)
      if (!f.sample) errors.push(`${f.id}: no sample`)
    }
    for (const c of t.falseClaims) {
      unique(c.id)
      if (!c.id.startsWith(`${t.id}.F`)) errors.push(`${c.id}: id must start with ${t.id}.F`)
      checkEvidence(c.id, c.evidence)
      checkPatterns(c.id, c.patterns)
      if (c.unless !== undefined) {
        const err = regexError(c.unless)
        if (err) errors.push(`${c.id}: unless ${c.unless}: ${err}`)
      }
      if (!c.sample || !c.refutation) errors.push(`${c.id}: needs a sample and a refutation`)
    }
  }
  return errors
}

/**
 * Every evidence range must exist at the pinned commit and contain its
 * anchor, or the task file is wrong. `lines(path)` returns the file's lines,
 * or null when the file does not exist.
 */
export function checkEvidence(file: TaskFile, lines: (path: string) => string[] | null): string[] {
  const problems: string[] = []
  const check = (owner: string, e: Evidence) => {
    const all = lines(e.path)
    if (!all) {
      problems.push(`${owner}: ${e.path} does not exist`)
      return
    }
    const { start, end } = parseLines(e.lines)
    if (end > all.length) {
      problems.push(`${owner}: ${e.path}:${e.lines} is past the end of the file (${all.length} lines)`)
      return
    }
    if (!all.slice(start - 1, end).some((l) => l.includes(e.contains))) {
      problems.push(`${owner}: ${e.path}:${e.lines} does not contain ${JSON.stringify(e.contains)}`)
    }
  }
  for (const t of file.tasks) {
    for (const f of t.facts) for (const e of f.evidence) check(f.id, e)
    for (const c of t.falseClaims) for (const e of c.evidence) check(c.id, e)
  }
  return problems
}

/** The tasks named in `wanted` (comma list of ids; empty = all), in file order. */
export function selectTasks(file: TaskFile, wanted: string): Task[] {
  const ids = wanted
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) return file.tasks
  const unknown = ids.filter((id) => !file.tasks.some((t) => t.id === id))
  if (unknown.length > 0) throw new Error(`unknown tasks ${unknown.join(', ')}; have ${file.tasks.map((t) => t.id).join(', ')}`)
  return file.tasks.filter((t) => ids.includes(t.id))
}
