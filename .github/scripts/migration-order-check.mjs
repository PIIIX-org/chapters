// Migration order guard. Drizzle applies a migration when its journal `when`
// is newer than the last one the database ran, so a migration whose `when`
// is older than the newest one already on `dev` is skipped on every database
// that already ran `dev`'s newest. That happens when a branch generates a
// migration, then another migration merges to `dev` first. This script
// compares the journal entries a PR adds (head journal minus base journal,
// minus entries identical to dev's: a merge of dev or a dev->prod promotion
// adds nothing) with the journal on the CURRENT `dev`, fetched when the
// check runs rather than the base the PR was branched from, and fails when:
//
// - an added entry's `when` is not strictly greater than the newest `when`
//   on `dev`, its `idx` is not greater than the largest `idx` on `dev`, or
//   its `tag` already exists on `dev`;
// - an added entry lacks an integer `idx`, a string `tag` or an integer
//   `when`, its `tag` does not start with the zero-padded `idx`, or the SQL
//   file `server/drizzle/<tag>.sql` is missing at the head;
// - the head journal is not strictly increasing in `idx` and `when`;
// - an entry the base already had was removed or altered (bumping an old
//   entry's `when` would bypass this guard and break deployed databases).
//
// Plain Node, no dependencies, one file. CLI (GitHub Actions and local):
//   node .github/scripts/migration-order-check.mjs --base <ref> --head <ref> [--dev <ref>]
// `--dev` defaults to `origin/dev` fetched now (`git fetch origin dev`);
// pass a ref to skip the fetch. Base and head are fetched (depth 1) from
// `origin` when the clone lacks them.

import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const JOURNAL = 'server/drizzle/meta/_journal.json'
export const MIGRATIONS_DIR = 'server/drizzle'

const isInt = (v) => Number.isInteger(v)

/** The SQL file a journal entry stands for. */
export const sqlPath = (tag) => `${MIGRATIONS_DIR}/${tag}.sql`

/** Entries of a parsed journal (null/undefined journal -> []). */
export function entries(journal) {
  const list = journal?.entries
  return Array.isArray(list) ? list : []
}

/** The largest `when` / `idx` of a journal, or null when it has none. */
export function newest(journal) {
  let when = null
  let idx = null
  for (const e of entries(journal)) {
    if (isInt(e.when) && (when === null || e.when > when)) when = e.when
    if (isInt(e.idx) && (idx === null || e.idx > idx)) idx = e.idx
  }
  return { when, idx }
}

const entryKey = (e) =>
  typeof e.tag === 'string' ? `tag:${e.tag}` : `idx:${e.idx}`
const label = (e) => `\`${typeof e.tag === 'string' ? e.tag : `idx ${e.idx}`}\``

/**
 * Compare journals. `base`, `head`, `dev` are parsed journals (null when the
 * ref has none); `fileExists(path)` says whether a repo path exists at the
 * head. Returns { ok, added: [entry], problems: [{ entry?, message }] }.
 */
export function check({ base, head, dev, fileExists }) {
  const problems = []
  const add = (message, entry) => problems.push({ entry, message })

  if (!head) {
    if (base || dev) {
      add(
        `\`${JOURNAL}\` is missing at the head but exists on the base or on dev.`,
      )
    }
    return { ok: problems.length === 0, added: [], problems }
  }

  const baseByKey = new Map(entries(base).map((e) => [entryKey(e), e]))
  const headByKey = new Map(entries(head).map((e) => [entryKey(e), e]))

  // Entries the base had must survive unchanged.
  for (const [key, b] of baseByKey) {
    const h = headByKey.get(key)
    if (!h) {
      add(
        `${label(b)} is in the base journal but not in the head journal: migrations already on dev are never removed.`,
        b,
      )
    } else if (h.idx !== b.idx || h.when !== b.when || h.tag !== b.tag) {
      add(
        `${label(b)} differs from the base journal (idx/when/tag changed): entries already on dev are never edited.`,
        h,
      )
    }
  }

  // An entry the base lacks but dev already has, byte for byte (idx, when,
  // tag), is dev's own: the PR merged dev, or is a dev->prod promotion. It
  // is not an addition of this PR.
  const devByKey = new Map(entries(dev).map((e) => [entryKey(e), e]))
  const sameAsDev = (e) => {
    const d = devByKey.get(entryKey(e))
    return !!d && d.idx === e.idx && d.when === e.when && d.tag === e.tag
  }
  const added = entries(head).filter(
    (e) => !baseByKey.has(entryKey(e)) && !sameAsDev(e),
  )
  const devNewest = newest(dev)
  const devTags = new Set(entries(dev).map((e) => e.tag))

  for (const e of added) {
    const shape = []
    if (!isInt(e.idx)) shape.push('`idx` (integer)')
    if (typeof e.tag !== 'string' || e.tag.length === 0)
      shape.push('`tag` (string)')
    if (!isInt(e.when)) shape.push('`when` (integer, ms since epoch)')
    if (shape.length > 0) {
      add(`${label(e)} lacks ${shape.join(', ')}.`, e)
      continue
    }
    const prefix = String(e.idx).padStart(4, '0')
    if (!e.tag.startsWith(`${prefix}_`)) {
      add(
        `${label(e)} has idx ${e.idx} but its tag does not start with \`${prefix}_\`.`,
        e,
      )
    }
    if (!fileExists(sqlPath(e.tag))) {
      add(`${label(e)} has no \`${sqlPath(e.tag)}\` at the head.`, e)
    }
    if (devTags.has(e.tag)) {
      add(`${label(e)} already exists on dev.`, e)
    }
    if (devNewest.when !== null && e.when <= devNewest.when) {
      add(
        `${label(e)} has when ${e.when}, not greater than the newest when on dev (${devNewest.when}): ` +
          "a database that already ran dev's newest migration would skip it. Regenerate the migration on top of current dev.",
        e,
      )
    }
    if (devNewest.idx !== null && e.idx <= devNewest.idx) {
      add(
        `${label(e)} has idx ${e.idx}, not greater than the largest idx on dev (${devNewest.idx}).`,
        e,
      )
    }
  }

  // Each added entry must come after its predecessor in the head journal:
  // drizzle reads it top to bottom. Entries already on the base are not
  // judged (dev's history has an old inversion, 0026 -> 0027).
  const list = entries(head)
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const cur = list[i]
    if (!added.includes(cur)) continue
    if (isInt(prev.idx) && isInt(cur.idx) && cur.idx <= prev.idx) {
      add(
        `${label(cur)} has idx ${cur.idx} after ${label(prev)} with idx ${prev.idx}: idx must strictly increase.`,
        cur,
      )
    }
    if (isInt(prev.when) && isInt(cur.when) && cur.when <= prev.when) {
      add(
        `${label(cur)} has when ${cur.when} after ${label(prev)} with when ${prev.when}: when must strictly increase.`,
        cur,
      )
    }
  }

  return { ok: problems.length === 0, added, problems }
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** Markdown for the step summary. `refs` = { base, head, dev } (short shas or names). */
export function summaryMarkdown(result, refs, devNewest) {
  const lines = [
    `## Migration order check: ${result.ok ? 'passed' : 'failed'}`,
    '',
    `Base \`${refs.base}\`, head \`${refs.head}\`, dev \`${refs.dev}\` (newest when on dev: ` +
      `${devNewest.when ?? 'none'}, largest idx: ${devNewest.idx ?? 'none'}).`,
    '',
  ]
  if (result.added.length === 0) {
    lines.push('The PR adds no journal entry.')
  } else {
    lines.push('| Added entry | idx | when | |', '| --- | --- | --- | --- |')
    for (const e of result.added) {
      const bad = result.problems.some((p) => p.entry === e)
      lines.push(
        `| \`${cell(e.tag ?? '(no tag)')}\` | ${cell(e.idx ?? '(none)')} | ${cell(e.when ?? '(none)')} | ${bad ? '❌' : '✅'} |`,
      )
    }
  }
  if (result.problems.length > 0) {
    lines.push('', '**Problems**', '')
    for (const p of result.problems) lines.push(`- ${p.message}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Runner

function parseArgs(argv) {
  const out = { base: null, head: 'HEAD', dev: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base' || a === '--head' || a === '--dev') {
      out[a.slice(2)] = argv[++i]
    } else {
      throw new Error(`Unknown argument: ${a}`)
    }
  }
  if (!out.base) throw new Error('--base <ref> is required')
  return out
}

function git(args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.error) throw res.error
  if (res.status !== 0) {
    if (allowFail) return null
    throw new Error(`git ${args.join(' ')} exited ${res.status}: ${res.stderr}`)
  }
  return res.stdout
}

/** A commit sha for `ref`, fetching it from origin when the clone lacks it. */
function resolveRef(ref) {
  const local = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    allowFail: true,
  })
  if (local) return local.trim()
  git(['fetch', '--no-tags', '--depth=1', 'origin', ref])
  return git(['rev-parse', 'FETCH_HEAD']).trim()
}

function journalAt(sha) {
  const text = git(['show', `${sha}:${JOURNAL}`], { allowFail: true })
  return text === null ? null : JSON.parse(text)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const base = resolveRef(args.base)
  const head = resolveRef(args.head)
  let dev
  if (args.dev) {
    dev = resolveRef(args.dev)
  } else {
    git(['fetch', '--no-tags', '--depth=1', 'origin', 'dev'])
    dev = git(['rev-parse', 'FETCH_HEAD']).trim()
  }
  const devJournal = journalAt(dev)
  const result = check({
    base: journalAt(base),
    head: journalAt(head),
    dev: devJournal,
    fileExists: (path) =>
      git(['cat-file', '-e', `${head}:${path}`], { allowFail: true }) !== null,
  })
  const markdown = summaryMarkdown(
    result,
    { base: base.slice(0, 12), head: head.slice(0, 12), dev: dev.slice(0, 12) },
    newest(devJournal),
  )
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  for (const p of result.problems) {
    console.log(`::error file=${JOURNAL},title=Migration order::${p.message}`)
  }
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main()
  } catch (err) {
    console.log(
      `::error title=Migration order check could not run::${err?.message ?? err}`,
    )
    console.error(err?.stack ?? err)
    process.exit(1)
  }
}
