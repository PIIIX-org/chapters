// Issue close check. For every issue a PR closes (`Closes #N`, `Fixes #N`,
// `Resolves #N` in the body, same repository), the `issue-close` job:
//
// (a) reads the issue's acceptance items (a `Done when` section or line and
//     the unchecked `- [ ]` items) and posts or updates ONE sticky PR comment
//     (marker COMMENT_MARKER) listing each item and whether the PR body
//     mentions it. An item the body does not mention needs an author
//     response: edit the body (the check re-runs on `edited`) and say how the
//     PR meets it, or why it does not; until then the check fails.
// (b) fails if `lab/known-defects.json` still has an entry whose `issue` is N
//     (lab.md, rule 5: the lab gate turns red once N is closed).
// (c) fails if N is already closed, is a pull request, or does not exist.
// (d) warns (passes) when the body has no closing keyword but the title names
//     an issue number (`fix: ... (#457)`): the PR will close nothing.
//
// On `merge_group` the PR is resolved from the queue branch name
// (`gh-readonly-queue/<base>/pr-<N>-<sha>`) and the same check runs on it.
// Workflow: .github/workflows/issue-close-check.yml; rules:
// docs/agents/github-workflow.md (CI, Issue close check).
//
// Plain Node, no dependencies, one file: the workflow copies the base
// commit's version of this file alone to a temp dir when there is one, so it
// must not import sibling modules.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The first line of the sticky comment; how the job finds it again. */
export const COMMENT_MARKER = '<!-- issue-close-check -->'

/** The closing keywords GitHub recognises (docs, "Linking a pull request to an issue"). */
export const CLOSING_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]

const FENCE = /^\s*(`{3,}|~{3,})/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const CHECKBOX = /^\[([ xX])\]\s+(.*)$/
const DONE_WHEN_LINE =
  /^\s*(?:\*\*|__)?\s*done\s+when\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$/i
const DONE_WHEN_HEADING = /^done\s+when\s*:?$/i

/**
 * The lines of a Markdown body with fenced code blocks and HTML comments
 * removed (kept as empty lines so line structure survives), and inline code
 * too unless `inlineCode` is true. GitHub links no reference inside code,
 * and a commented-out `Closes #N` is not a decision to close.
 */
export function proseLines(body, { inlineCode = false } = {}) {
  const out = []
  let fence = null
  let comment = false
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const f = raw.match(FENCE)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      out.push('')
      continue
    }
    if (f) {
      fence = f[1]
      out.push('')
      continue
    }
    let line = ''
    let rest = raw
    while (rest) {
      if (comment) {
        const end = rest.indexOf('-->')
        if (end < 0) {
          rest = ''
        } else {
          rest = rest.slice(end + 3)
          comment = false
        }
        continue
      }
      const open = rest.indexOf('<!--')
      const tick = inlineCode ? -1 : rest.search(/`+/)
      if (tick >= 0 && (open < 0 || tick < open)) {
        const run = rest.slice(tick).match(/^`+/)[0]
        const close = rest.indexOf(run, tick + run.length)
        line += rest.slice(0, tick)
        if (close < 0) {
          // An unclosed backtick run is literal text.
          line += rest.slice(tick)
          rest = ''
        } else {
          rest = rest.slice(close + run.length)
        }
        continue
      }
      if (open >= 0) {
        line += rest.slice(0, open)
        rest = rest.slice(open + 4)
        comment = true
        continue
      }
      line += rest
      rest = ''
    }
    out.push(line)
  }
  return out
}

/**
 * The issues a PR body closes, in order of first appearance, de-duplicated:
 * [{ number, sameRepo, repo }]. A reference is `<keyword>[:] #N`,
 * `owner/repo#N` or a full issue/PR URL; `sameRepo` says whether it is an
 * issue of `repo` (only those can be checked and only those close on merge
 * to the default branch here).
 */
export function closingRefs(body, repo) {
  const text = proseLines(body).join('\n')
  const kw = CLOSING_KEYWORDS.join('|')
  const re = new RegExp(
    String.raw`\b(?:${kw})\s*:?\s+(?:(?:https?://github\.com/([\w.-]+/[\w.-]+)/(?:issues|pull)/(\d+))|(?:([\w.-]+/[\w.-]+))?#(\d+))\b`,
    'gi',
  )
  const seen = new Set()
  const out = []
  for (const m of text.matchAll(re)) {
    const r = (m[1] ?? m[3] ?? repo).toLowerCase()
    const number = Number(m[2] ?? m[4])
    const key = `${r}#${number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ number, repo: r, sameRepo: r === String(repo).toLowerCase() })
  }
  return out
}

/** The issue numbers a PR title names (`#457`), de-duplicated. */
export function titleIssueRefs(title) {
  const out = []
  for (const m of String(title ?? '').matchAll(/(?:^|[^\w&])#(\d+)\b/g)) {
    const n = Number(m[1])
    if (!out.includes(n)) out.push(n)
  }
  return out
}

/**
 * Strips Markdown emphasis, links (keeps the text) and HTML tags from one
 * item so it reads as plain text.
 */
function plain(text) {
  return String(text)
    .replace(/`+/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The acceptance items of an issue body, in order, de-duplicated by their
 * normalised text: every unchecked checklist item (`- [ ]`) anywhere, and
 * the content of a `Done when` section (heading of any level) or line
 * (`**Done when:** text`, `Done when: text`). In a section the items are
 * its list items, or its paragraphs when it has no list; a line's text is
 * one item and the list that directly follows adds more. Checked items
 * (`- [x]`) are already done and are not listed. Code and HTML comments are
 * ignored.
 */
export function acceptanceItems(issueBody) {
  const lines = proseLines(issueBody, { inlineCode: true })
  const items = []
  const seen = new Set()
  const add = (text) => {
    if (text == null) return
    const t = plain(text)
    const key = normalise(t)
    if (!key || seen.has(key)) return
    seen.add(key)
    items.push(t)
  }
  // A list item's text, or null for a checked `- [x]` item (already done).
  const itemText = (m) => {
    const c = m[1].match(CHECKBOX)
    return c ? (c[1] === ' ' ? c[2] : null) : m[1]
  }
  // Pass 1: `Done when` sections and lines, in order.
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEADING)
    if (h && DONE_WHEN_HEADING.test(plain(h[2]))) {
      let j = i + 1
      const section = []
      for (; j < lines.length && !HEADING.test(lines[j]); j++)
        section.push(lines[j])
      const listItems = section.map((l) => l.match(LIST_ITEM)).filter(Boolean)
      if (listItems.length) {
        for (const m of listItems) add(itemText(m))
      } else {
        for (const p of section.join('\n').split(/\n\s*\n/))
          add(p.replace(/\n/g, ' '))
      }
      i = j - 1
      continue
    }
    const d = !h && lines[i].match(DONE_WHEN_LINE)
    if (d) {
      if (d[1].trim()) add(d[1])
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      for (; j < lines.length; j++) {
        const m = lines[j].match(LIST_ITEM)
        if (!m) break
        add(itemText(m))
      }
      i = j - 1
    }
  }
  // Pass 2: unchecked checklist items anywhere.
  for (const line of lines) {
    const m = line.match(LIST_ITEM)
    const c = m && m[1].match(CHECKBOX)
    if (c && c[1] === ' ') add(c[2])
  }
  return items
}

const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g

/** Lower-case NFKC text with punctuation turned into single spaces. */
export function normalise(text) {
  return plain(text)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Words that say nothing about which item is meant. */
const STOP = new Set(
  (
    'a an and are as at be been but by for from has have in into is it its of on or ' +
    'that the their then there these this to was were when which will with without ' +
    'not no only also than can does done each every should must after before'
  ).split(' '),
)

/** The words of an item that identify it: 4+ characters, not in STOP. */
export function contentWords(item) {
  const words = normalise(item).split(' ').filter(Boolean)
  const content = words.filter((w) => w.length >= 4 && !STOP.has(w))
  return [
    ...new Set(content.length ? content : words.filter((w) => w.length >= 2)),
  ]
}

/**
 * Whether a PR body mentions an acceptance item: it contains the item's
 * normalised text, or at least two thirds (rounded up) of its content
 * words. Deterministic and lenient on wording, so quoting the item in the
 * body always counts. HTML comments and code fences in the body are
 * ignored; inline code counts (a path in backticks is a mention).
 */
export function mentions(prBody, item) {
  const body = normalise(proseLines(prBody, { inlineCode: true }).join('\n'))
  const needle = normalise(item)
  if (!needle) return true
  if (body.includes(needle)) return true
  const words = contentWords(item)
  if (!words.length) return true
  const have = new Set(body.split(' '))
  const hits = words.filter((w) => have.has(w)).length
  return hits >= Math.ceil((words.length * 2) / 3)
}

/**
 * The entries of a parsed `lab/known-defects.json` whose `issue` is N:
 * [{ test, check, match }]. `issue` may be a number or a numeric string.
 */
export function defectEntriesFor(defects, n) {
  const list = Array.isArray(defects?.defects) ? defects.defects : []
  return list
    .filter((d) => d && typeof d === 'object' && Number(d.issue) === n)
    .map(({ test, check, match }) => ({ test, check, match }))
}

/**
 * The PR number of a merge-queue branch (`gh-readonly-queue/<base>/pr-<N>-<sha>`,
 * with or without `refs/heads/`), or null.
 */
export function mergeGroupPr(headRef) {
  const m = String(headRef ?? '').match(
    /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]{40}$/,
  )
  return m ? Number(m[1]) : null
}

/** A `@name` with a zero-width joiner after the `@`, so a comment never pings anyone an issue mentions. */
const unping = (s) => s.replace(/@(?=[\w-])/g, '@\u200D')

const cell = (s) =>
  unping(
    String(s ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\s+/g, ' ')
      .trim(),
  )

/**
 * Whether a body refers to issue N on purpose without closing it
 * (`refs #N`, `references #N`, `related to #N`, `part of #N`, `see #N`).
 */
export function refersTo(body, n) {
  const text = proseLines(body).join('\n')
  const re = new RegExp(
    String.raw`\b(?:refs?|references?|related(?:\s+to)?|part\s+of|see)\s*:?\s+(?:[\w.-]+/[\w.-]+)?#${n}\b`,
    'i',
  )
  return re.test(text)
}

/**
 * The verdict for a PR. `pr` is the API pull request (`number`, `title`,
 * `body`, `state`, `merged`, `head.sha`, `html_url`); `issues` maps a
 * same-repo issue number to the API issue (`number`, `title`, `body`,
 * `state`, `html_url`, `pull_request` when it is a PR) or to null when it
 * does not exist; `defects` is the parsed known-defects file, or an Error
 * when it could not be read. Returns { ok, skipped, refs, issues: [{ number,
 * title, state, problems, unmentioned, items: [{ text, mentioned }],
 * defects }], warnings, title, report, comment }. `comment` is the sticky
 * comment text, null when the PR closes nothing and nothing is to be said,
 * and undefined when the PR is closed (`skipped`: the comment is left as it
 * is). Problems fail the check; warnings do not.
 */
export function check({ pr, issues, defects, repo }) {
  if (pr.state === 'closed' || pr.merged) {
    return {
      ok: true,
      skipped: true,
      refs: [],
      issues: [],
      warnings: [],
      title: `PR #${pr.number} is ${pr.merged ? 'merged' : 'closed'}; nothing to check and the comment is left as it is.`,
      report: '',
      comment: undefined,
    }
  }
  const refs = closingRefs(pr.body, repo)
  const body = pr.body ?? ''
  const warnings = []
  const itemWarnings = []
  const results = []
  const foreign = refs.filter((r) => !r.sameRepo)
  if (defects instanceof Error) {
    warnings.push(
      `\`lab/known-defects.json\` could not be read: ${defects.message}`,
    )
  }

  for (const ref of refs.filter((r) => r.sameRepo)) {
    const issue = issues[ref.number] ?? null
    const problems = []
    let unmentioned = 0
    let items = []
    let entries = []
    if (!issue) {
      problems.push(`#${ref.number} does not exist in \`${repo}\`.`)
    } else if (issue.pull_request) {
      problems.push(`#${ref.number} is a pull request, not an issue.`)
    } else {
      if (issue.state !== 'open') {
        problems.push(
          `#${ref.number} is already closed${issue.state_reason ? ` (${issue.state_reason})` : ''}: a merged PR cannot close it again. Reopen it or drop the closing keyword.`,
        )
      }
      items = acceptanceItems(issue.body).map((text) => ({
        text,
        mentioned: mentions(body, text),
      }))
      unmentioned = items.filter((i) => !i.mentioned).length
      if (unmentioned) {
        itemWarnings.push(
          `${unmentioned} acceptance item${unmentioned === 1 ? '' : 's'} of #${ref.number} ${unmentioned === 1 ? 'is' : 'are'} not mentioned in the PR body (see the comment).`,
        )
      }
    }
    if (!(defects instanceof Error)) {
      entries = defectEntriesFor(defects, ref.number)
      if (entries.length) {
        problems.push(
          `\`lab/known-defects.json\` still has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} for #${ref.number}; remove ${entries.length === 1 ? 'it' : 'them'} in this PR (lab.md, rule 5).`,
        )
      }
    }
    results.push({
      number: ref.number,
      title: issue?.title ?? null,
      state: issue
        ? issue.pull_request
          ? 'pull request'
          : issue.state
        : 'missing',
      url: issue?.html_url ?? null,
      problems,
      unmentioned,
      items,
      defects: entries,
    })
  }

  if (!refs.length) {
    const named = titleIssueRefs(pr.title).filter((n) => !refersTo(body, n))
    if (named.length) {
      warnings.push(
        `The title names ${named.map((n) => `#${n}`).join(', ')} but the body has no closing keyword (\`Closes #N\`, \`Fixes #N\`, \`Resolves #N\`): merging will close nothing. Add one, or say \`refs #N\` to leave it open on purpose.`,
      )
    }
  }
  for (const f of foreign) {
    warnings.push(
      `\`${f.repo}#${f.number}\` is in another repository and is not checked.`,
    )
  }

  const failing = results.filter((r) => r.problems.length)
  const ok = failing.length === 0
  const skipped = false
  const closes = results.length
  const missing = results.reduce((n, r) => n + r.unmentioned, 0)
  const title = !closes
    ? warnings.length
      ? 'The PR closes no issue of this repository; see the warnings.'
      : 'The PR closes no issue; nothing to check.'
    : !ok
      ? `${failing.length} of the ${closes} issue${closes === 1 ? '' : 's'} the PR closes ${failing.length === 1 ? 'has' : 'have'} a problem.`
      : missing
        ? `The PR closes ${closes} open issue${closes === 1 ? '' : 's'}; ${missing} acceptance item${missing === 1 ? ' is' : 's are'} not mentioned in the body (a warning, not a failure).`
        : `The PR closes ${closes} open issue${closes === 1 ? '' : 's'}; every acceptance item is mentioned in the body and no known-defect entry points at ${closes === 1 ? 'it' : 'them'}.`

  const sections = []
  for (const r of results) {
    const head = r.url ? `[#${r.number}](${r.url})` : `#${r.number}`
    const lines = [
      `### ${head}${r.title ? ` ${cell(r.title)}` : ''} (${r.state})`,
    ]
    for (const p of r.problems) lines.push(`- :x: ${p}`)
    if (r.unmentioned) {
      lines.push(
        `- :warning: ${r.unmentioned} acceptance item${r.unmentioned === 1 ? '' : 's'} not mentioned in the PR body (listed below).`,
      )
    }
    if (r.items.length) {
      lines.push('', 'Acceptance items (`Done when`, unchecked `- [ ]`):', '')
      for (const i of r.items) {
        lines.push(
          i.mentioned
            ? `- mentioned: ${cell(i.text)}`
            : `- **not in the PR body**: ${cell(i.text)}`,
        )
      }
    } else if (r.state === 'open') {
      lines.push(
        '',
        'The issue has no `Done when` section and no unchecked checklist item.',
      )
    }
    if (r.defects.length) {
      lines.push('', 'Entries in `lab/known-defects.json`:', '')
      for (const d of r.defects) {
        lines.push(
          `- \`${cell(d.test)}\`: ${d.check ? `\`${cell(d.check)}\`` : `match \`${cell(d.match)}\``}`,
        )
      }
    }
    sections.push(lines.join('\n'))
  }
  const warnBlock = warnings.length
    ? warnings.map((w) => `- :warning: ${w}`).join('\n')
    : ''
  const report = [sections.join('\n\n'), warnBlock].filter(Boolean).join('\n\n')

  const authorNote = missing
    ? '**Author:** for each item marked **not in the PR body**, say in the PR body (the check re-runs on edit) how this PR meets it, or why it does not; quoting the item counts. This is a request, not a gate: the check does not fail on it.'
    : ''
  const comment =
    closes || warnings.length
      ? [
          COMMENT_MARKER,
          `## Issue close check: ${ok ? 'passed' : 'failed'}`,
          '',
          `**${title}**`,
          '',
          report,
          authorNote,
          '',
          `Head: \`${pr.head?.sha ?? ''}\``,
        ]
          .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
          .join('\n')
      : null

  return {
    ok,
    skipped,
    refs,
    issues: results,
    warnings: [...itemWarnings, ...warnings],
    title,
    report,
    comment,
  }
}

// ---------------------------------------------------------------------------
// Runner (GitHub Actions only)

// The workflow runs the base commit's copy of this script when the base
// has one (so a PR's script edits do not judge the PR) and says which.
const CHECKER =
  process.env.ISSUE_CLOSE_CHECKER === 'base'
    ? "Checker: the base commit's `.github/scripts/issue-close-check.mjs`."
    : process.env.ISSUE_CLOSE_CHECKER === 'pr'
      ? "Checker: the PR's `.github/scripts/issue-close-check.mjs` (the base commit has none yet)."
      : ''

function finish(ok, title, body, warnings = []) {
  const markdown =
    `## Issue close check: ${ok ? 'passed' : 'failed'}\n\n**${title}**` +
    (body ? `\n\n${body}` : '') +
    (CHECKER ? `\n\n${CHECKER}` : '')
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
  for (const w of warnings)
    console.log(`::warning title=Issue close check::${w}`)
  if (!ok) console.log(`::error title=Issue close check failed::${title}`)
  process.exit(ok ? 0 : 1)
}

/**
 * Whether a response is worth one retry: a 5xx, a 429, or a 403 that is
 * the rate limit (`x-ratelimit-remaining: 0` or a `retry-after` header).
 */
export function isTransient(status, headers) {
  if (status >= 500 || status === 429) return true
  return (
    status === 403 &&
    (headers.get('x-ratelimit-remaining') === '0' ||
      headers.get('retry-after') !== null)
  )
}

/** Seconds to wait before the retry: `retry-after` when given, else 5. */
export function retryDelay(headers) {
  const s = Number(headers.get('retry-after'))
  return Number.isFinite(s) && s > 0 ? Math.min(s, 60) : 5
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One GitHub API call -> the parsed JSON body (null on 404 when allowed).
 * A network error or a transient response is retried once.
 */
async function api(path, { method = 'GET', body, allow404 = false } = {}) {
  const url = path.startsWith('https://')
    ? path
    : `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`
  const once = () =>
    fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  let res
  try {
    res = await once()
  } catch (err) {
    console.log(
      `::notice::${method} ${url} failed (${err.message}); retrying once`,
    )
    await sleep(5000)
    res = await once()
  }
  if (isTransient(res.status, res.headers)) {
    const delay = retryDelay(res.headers)
    console.log(
      `::notice::${method} ${url}: ${res.status}; retrying once in ${delay}s`,
    )
    await sleep(delay * 1000)
    res = await once()
  }
  if (res.status === 404 && allow404) return null
  if (!res.ok)
    throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

/** Every page of a list endpoint. */
async function pages(path) {
  const out = []
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const data = await api(`${path}${sep}per_page=100&page=${page}`)
    out.push(...data)
    if (data.length < 100) return out
  }
}

/**
 * Posts the sticky comment, or updates the one already there when its text
 * differs; deletes nothing. Returns what it did.
 */
async function upsertComment(repo, number, comment) {
  const existing = (
    await pages(`/repos/${repo}/issues/${number}/comments`)
  ).find((c) => String(c.body ?? '').startsWith(COMMENT_MARKER))
  if (!comment) {
    if (!existing) return 'no comment needed'
    const text = `${COMMENT_MARKER}\n## Issue close check: passed\n\n**The PR closes no issue; nothing to check.**`
    if (existing.body === text) return 'comment unchanged'
    await api(`/repos/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: { body: text },
    })
    return `comment ${existing.html_url} updated (nothing to check now)`
  }
  if (existing) {
    if (existing.body === comment)
      return `comment ${existing.html_url} unchanged`
    await api(`/repos/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: { body: comment },
    })
    return `comment ${existing.html_url} updated`
  }
  const created = await api(`/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: { body: comment },
  })
  return `comment ${created.html_url} posted`
}

function readDefects(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const repo = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY
  let pr = event.pull_request
  let source = 'pull_request event'
  if (!pr && event.merge_group) {
    const n = mergeGroupPr(event.merge_group.head_ref)
    if (n === null) {
      finish(
        false,
        `Cannot resolve the PR from merge group head \`${event.merge_group.head_ref}\`.`,
        '',
      )
    }
    pr = await api(`/repos/${repo}/pulls/${n}`)
    source = `merge group for PR #${n} (${event.merge_group.head_ref})`
  }
  if (!pr)
    finish(
      true,
      'Not a pull_request or merge_group event; nothing to check.',
      '',
    )

  // A body edit after the merge (or close) must not fail on the issues the
  // merge closed, nor rewrite the comment: the workflow's `if` skips the job
  // and this is the same guard for a hand-built event.
  if (pr.state === 'closed' || pr.merged) {
    const r = check({ pr, issues: {}, defects: {}, repo })
    finish(
      true,
      r.title,
      `Source: ${source}; PR [#${pr.number}](${pr.html_url}).`,
    )
  }

  const refs = closingRefs(pr.body, repo)
  const issues = {}
  for (const ref of refs.filter((r) => r.sameRepo)) {
    issues[ref.number] = await api(`/repos/${repo}/issues/${ref.number}`, {
      allow404: true,
    })
  }
  const defects = readDefects(
    process.env.KNOWN_DEFECTS ?? 'lab/known-defects.json',
  )
  const r = check({ pr, issues, defects, repo })

  let commentNote
  try {
    commentNote = await upsertComment(repo, pr.number, r.comment)
  } catch (err) {
    commentNote = `the sticky comment could not be written (${err.message.split('\n')[0]}); its text is below`
    r.report = [
      r.report,
      r.comment ? `\`\`\`markdown\n${r.comment}\n\`\`\`` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  const footer = `Source: ${source}; PR [#${pr.number}](${pr.html_url}) at \`${pr.head?.sha ?? ''}\`; ${commentNote}.`
  finish(
    r.ok,
    r.title,
    [r.report, footer].filter(Boolean).join('\n\n'),
    r.warnings,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) =>
    finish(
      false,
      'The check could not run.',
      `\`\`\`\n${err?.stack ?? err}\n\`\`\``,
    ),
  )
}
