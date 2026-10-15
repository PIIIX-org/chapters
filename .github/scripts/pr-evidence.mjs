// PR evidence check (#579). A PR body must have an Evidence section that
// links at least one run or artifact of this repo, and a claim ("all tests
// pass", "476/476", "0 errors", "verified", "100%", ...) must sit in a
// sentence, bullet or table row that links the evidence behind it: a GitHub
// Actions run, PR, issue, commit or file of this repo. CLAIMS below is the
// one list of claim patterns. Template: .github/pull_request_template.md;
// rules: docs/agents/github-workflow.md.
//
// Plain Node, no dependencies, one file: the workflow copies the base
// commit's version of this file alone to a temp dir when there is one, so it
// must not import sibling modules.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PASS = String.raw`(?:are\s+|were\s+)?(?:pass(?:es|ed|ing)?|green)\b`
const TESTS = String.raw`tests?(?:\s+(?:suites?|files?|cases?))?\s+`

/**
 * Claims that need a link next to them: [label, pattern]. Matched on
 * NFKC-normalised text (so `１００％` is `100%`) with zero-width characters
 * removed, outside code, URLs and headings.
 */
export const CLAIMS = [
  ['100%', /(?<![\w.])100(?:[.,]0+)?\s?(?:%|percent\b)/i],
  ['verified', /\bverified\b/i],
  ['fully tested', /\bfully[\s-]+(?:tested|covered)\b/i],
  [
    'tested end-to-end',
    /\btested\s+end[\s-]to[\s-]end\b|\bend[\s-]to[\s-]end[\s-]+tested\b/i,
  ],
  [
    'all tests pass',
    new RegExp(
      String.raw`\ball\s+(?:[\w,-]+\s+){0,3}?${TESTS}${PASS}|\btests\s+all\s+pass(?:es|ed|ing)?\b`,
      'i',
    ),
  ],
  [
    'N tests pass',
    new RegExp(
      String.raw`(?<![\w.])\d[\d,]*\s+(?:[\w-]+\s+){0,2}?${TESTS}${PASS}`,
      'i',
    ),
  ],
  ['N/N', /(?<![\w./-])(\d[\d,]*)\s*\/\s*\1(?![\w/])/],
  [
    '0 errors',
    /(?<![\w.])(?:0|zero)\s+(?:[\w/-]+\s+)?(?:errors?|fail(?:s|ed|ures?)?|warnings?|bugs?|regressions?|violations?)\b/i,
  ],
  [
    'no regressions',
    /\bno\s+(?:known\s+)?(?:regressions?|bugs?)\b|\bbug[\s-]free\b/i,
  ],
  [
    'is green',
    /\b(?:is|are|was|were|all|stays?|stayed)\s+green\b|\b(?:CI|suites?|tests?|checks?|builds?)\s+green\b/i,
  ],
  ['production-ready', /\bproduction[\s-]ready\b/i],
  ['stable', /\bstable\b/i],
  ['remediated', /\bremediated\b/i],
]

const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g
const FENCE = /^\s*(`{3,}|~{3,})/
const REF_DEF = /^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/

/**
 * One line with inline code (backtick spans, `<code>`) removed first and
 * then HTML comments, in reading order, so `<!--` inside code opens no
 * comment. `comment` says whether the line starts inside a comment.
 */
function stripInline(line, comment) {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (comment) {
      const end = line.indexOf('-->', i)
      if (end < 0) return { text: out, comment: true }
      comment = false
      out += ' '
      i = end + 3
      continue
    }
    const m = /`+|<!--|<code\b[^>]*>/i.exec(line.slice(i))
    if (!m) {
      out += line.slice(i)
      break
    }
    out += line.slice(i, i + m.index)
    const after = i + m.index + m[0].length
    if (m[0] === '<!--') {
      comment = true
      i = after
      continue
    }
    let close = -1
    if (m[0][0] === '`') {
      const re = new RegExp('(?<!`)' + m[0] + '(?!`)', 'g')
      re.lastIndex = after
      const c = re.exec(line)
      if (c) close = c.index + m[0].length
    } else {
      const c = line.toLowerCase().indexOf('</code>', after)
      if (c >= 0) close = c + '</code>'.length
    }
    if (close < 0) {
      out += m[0]
      i = after
      continue
    }
    out += ' '
    i = close
  }
  return { text: out, comment }
}

/**
 * The rendered prose of a body: lines with fenced code, inline code and
 * HTML comments (template hints; GitHub hides them, an unclosed one to the
 * end) removed, plus the reference-link definitions (`[1]: url`), which are
 * taken out of the lines.
 */
export function parseBody(body) {
  const lines = []
  const refs = new Map()
  let fence = null
  let comment = false
  const text = (body ?? '').normalize('NFKC').replace(INVISIBLE, '')
  for (const raw of text.split(/\r?\n/)) {
    if (fence) {
      const m = FENCE.exec(raw)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (!comment) {
      const m = FENCE.exec(raw)
      if (m) {
        fence = m[1]
        continue
      }
    }
    const r = stripInline(raw, comment)
    comment = r.comment
    const def = REF_DEF.exec(r.text)
    if (def) {
      refs.set(def[1].trim().toLowerCase(), def[2])
      continue
    }
    lines.push(r.text)
  }
  return { lines, refs }
}

/** Appends the URL of each reference-style link (`[run][1]`, `[run]`). */
export function resolveRefs(text, refs) {
  if (refs.size === 0) return text
  return text.replace(/\[([^\]]*)\](?:\[([^\]]*)\])?/g, (all, a, b) => {
    const url = refs.get((b || a).trim().toLowerCase())
    return url ? `${all} ${url}` : all
  })
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const BOLD_EVIDENCE = /^\s*\*\*evidence:?\*\*:?\s*(.*)$/i
const BOLD_LABEL = /^\s*\*\*(?:[^*]+\*\*:?\s*$|[^*]+:\*\*)/

/**
 * The content of the first non-empty Evidence section, or null. A section
 * is a heading with the word Evidence (`## Evidence`, `### Tests /
 * Evidence`) running to the next heading of the same or a higher level, or
 * a bold `**Evidence**` / `**Evidence:**` line running to the next heading
 * or bold label line. Comments and code do not count as content.
 */
export function evidenceSection(body) {
  const { lines } = parseBody(body)
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i])
    const heading = h && /\bevidence\b/i.test(h[2]) ? h : null
    const bold = heading ? null : BOLD_EVIDENCE.exec(lines[i])
    if (!heading && !bold) continue
    const content = bold ? [bold[1]] : []
    for (let j = i + 1; j < lines.length; j++) {
      const next = HEADING.exec(lines[j])
      if (heading && next && next[1].length <= heading[1].length) break
      if (bold && (next || BOLD_LABEL.test(lines[j]))) break
      content.push(lines[j])
    }
    const text = content.join('\n').trim()
    if (text !== '') return text
  }
  return null
}

const HTML_TAG =
  /^\/?(?:a|b|i|em|strong|code|kbd|samp|sub|sup|br|hr|p|pre|img|details|summary|div|span|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|ins|del|s)\b/i

/** Template placeholders like `<id>` or `<reason>` left in the text. */
export function placeholders(text) {
  return [...text.matchAll(/<([a-z][^<>\n]{0,80})>/gi)]
    .filter(([, inner]) => !HTML_TAG.test(inner) && !/^(?:https?|mailto):/i.test(inner))
    .map(([p]) => p)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A full URL to an Actions run, PR, issue, commit or file of `repo`. */
export function hasEvidenceUrl(text, repo) {
  const re = new RegExp(
    String.raw`https?://(?:www\.)?github\.com/${escapeRe(repo)}/` +
      String.raw`(?:actions/runs/\d|pull/\d|issues/\d|commit/[0-9a-f]{7,40}\b|blob/[^\s<>)]|tree/[^\s<>)])`,
    'i',
  )
  return re.test(text)
}

/**
 * hasEvidenceUrl, or a same-repo reference GitHub links the same way:
 * `#123` or `owner/repo#123`.
 */
export function hasEvidenceLink(text, repo) {
  const ref = new RegExp(
    String.raw`(?:^|[^\w/&#])(?:${escapeRe(repo)})?#\d+\b`,
    'i',
  )
  return hasEvidenceUrl(text, repo) || ref.test(text)
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/
const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'(*_[])/

/**
 * The units a claim is judged in: [{ text, context }]. `text` is where
 * claims are looked for, `context` where links are. A paragraph gives one
 * unit per sentence; a list item (with its continuation lines) is judged
 * with its parent items and its nested items, so a link on a sub-bullet
 * covers the bullet above it; a table row is judged alone. Headings and
 * table header rows are labels, not claims, and give no unit.
 */
export function proseUnits(body) {
  const { lines } = parseBody(body)
  const units = []
  let para = []
  let nodes = []
  let stack = []
  let blank = false
  const flushPara = () => {
    for (const s of para.join(' ').split(SENTENCE_END)) {
      if (s.trim() !== '') units.push({ text: s.trim(), context: s.trim() })
    }
    para = []
  }
  const closeList = () => {
    for (const node of nodes) {
      const parts = []
      for (let p = node.parent; p; p = p.parent) parts.unshift(p.text)
      parts.push(node.text)
      const walk = (n) => {
        for (const c of n.children) {
          parts.push(c.text)
          walk(c)
        }
      }
      walk(node)
      node.unit.text = node.text
      node.unit.context = parts.join(' ')
    }
    nodes = []
    stack = []
  }
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/\t/g, '    ')
    const t = line.trim()
    if (t === '') {
      flushPara()
      blank = true
      continue
    }
    if (HEADING.test(line)) {
      flushPara()
      closeList()
      blank = false
      continue
    }
    if (t.startsWith('|')) {
      flushPara()
      closeList()
      blank = false
      const header = n + 1 < lines.length && TABLE_SEP.test(lines[n + 1].trim())
      if (!TABLE_SEP.test(t) && !header) units.push({ text: t, context: t })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      flushPara()
      const indent = item[1].length
      while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop()
      const parent = stack.at(-1) ?? null
      const node = { indent, text: t, parent, children: [], unit: {} }
      if (parent) parent.children.push(node)
      units.push(node.unit)
      nodes.push(node)
      stack.push(node)
      blank = false
      continue
    }
    const q = t.replace(/^(>\s?)+/, '').trim()
    if (stack.length > 0 && (!blank || line.length - line.trimStart().length >= 2)) {
      stack.at(-1).text += ` ${q}`
      blank = false
      continue
    }
    closeList()
    if (q !== '') para.push(q)
    blank = false
  }
  flushPara()
  closeList()
  return units
}

/** Claim labels in a text, ignoring inline code and URLs. */
export function claimsIn(text) {
  const prose = text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/(`+)[\s\S]*?\1/g, ' ')
    .replace(/https?:\/\/[^\s)<>\]]+/gi, ' ')
  return CLAIMS.filter(([, re]) => re.test(prose)).map(([label]) => label)
}

/** [{ claims, text }] for every unit with a claim and no evidence link. */
export function unlinkedClaims(body, repo) {
  const { refs } = parseBody(body)
  const out = []
  for (const u of proseUnits(body)) {
    const claims = claimsIn(u.text)
    if (claims.length > 0 && !hasEvidenceLink(resolveRefs(u.context, refs), repo)) {
      out.push({ claims, text: u.text })
    }
  }
  return out
}

/**
 * A PR made by GitHub's Revert button: title `Revert "..."` and a body
 * naming the reverted PR (`Reverts owner/repo#123`).
 */
export function isRevert(pr) {
  return (
    /^Revert "/.test(pr.title ?? '') &&
    /\bReverts\s+[\w.-]+\/[\w.-]+#\d+/.test(pr.body ?? '')
  )
}

const cell = (s) => {
  const t = s.length > 200 ? `${s.slice(0, 197)}...` : s
  return t.replace(/\|/g, '\\|')
}

/**
 * The state of the Evidence section: 'ok', 'missing' (none, or only
 * comments), 'no-link' (no full URL to a run, PR, issue, commit or file of
 * this repo), 'placeholder' (template placeholders left), or 'revert' (a
 * Revert-button PR without a section; the body already names the PR).
 */
export function evidenceState(pr, repo) {
  const section = evidenceSection(pr.body)
  const revert = isRevert(pr)
  if (section === null) return { state: revert ? 'revert' : 'missing' }
  const found = placeholders(section)
  if (found.length > 0) return { state: 'placeholder', placeholders: found }
  const { refs } = parseBody(pr.body)
  if (!hasEvidenceUrl(resolveRefs(section, refs), repo)) {
    return { state: revert ? 'revert' : 'no-link' }
  }
  return { state: 'ok' }
}

/**
 * The verdict for a PR: { ok, skipped, evidence, placeholders, claims,
 * title, report } (report is markdown). Applies to every PR the workflow
 * runs on, promotions included. Dependabot bodies are generated upstream
 * release notes, not claims by the author, so they are skipped.
 */
export function check(pr, repo) {
  if (pr.user?.login === 'dependabot[bot]') {
    return {
      ok: true,
      skipped: true,
      evidence: 'skipped',
      placeholders: [],
      claims: [],
      title: 'Dependabot PR: skipped.',
      report: 'The body is generated by Dependabot; CI checks the change.',
    }
  }
  const ev = evidenceState(pr, repo)
  const claims = unlinkedClaims(pr.body, repo)
  const parts = []
  const what =
    'the CI run, the fails-before run (or a `Fails-before: n/a because ...` line), the lab ' +
    'run for integration changes, the benchmark delta for retrieval or token changes'
  if (ev.state === 'missing') {
    parts.push(
      'The PR body has no `## Evidence` section, or it holds only comments. Add one with ' +
        `links: ${what}. Template: \`.github/pull_request_template.md\`.`,
    )
  } else if (ev.state === 'no-link') {
    parts.push(
      'The Evidence section links nothing. It needs at least one full URL to a GitHub ' +
        `Actions run, PR, issue, commit or file of \`${repo}\` (\`#N\` does not count here): ` +
        `${what}. Before CI has run, link the issue or the head commit; editing the body ` +
        're-runs this check once the run link is added.',
    )
  } else if (ev.state === 'placeholder') {
    parts.push(
      'The Evidence section still holds template placeholders: ' +
        ev.placeholders.map((p) => `\`${cell(p)}\``).join(', ') +
        '. Replace them with the real links or reasons.',
    )
  }
  if (claims.length > 0) {
    parts.push(
      `${claims.length} sentence(s), bullet(s) or row(s) make a claim with no link to a ` +
        `GitHub Actions run, PR, issue (\`#N\` counts), commit or file of \`${repo}\`. Link the ` +
        'run or artifact in the same sentence, bullet (or a sub-bullet of it) or row, or ' +
        'reword it. A word quoted in backticks is not a claim.\n\n' +
        '| Claim | Text |\n| --- | --- |\n' +
        claims
          .map(
            (c) =>
              `| ${c.claims.map((w) => `\`${w}\``).join(', ')} | ${cell(c.text)} |`,
          )
          .join('\n'),
    )
  }
  const ok = parts.length === 0
  return {
    ok,
    skipped: false,
    evidence: ev.state,
    placeholders: ev.placeholders ?? [],
    claims,
    title: ok
      ? ev.state === 'revert'
        ? 'Revert PR: no Evidence section needed, and every claim links its evidence.'
        : 'The PR body has an Evidence section with links, and every claim links its evidence.'
      : 'The PR body needs evidence.',
    report: ok ? '' : parts.join('\n\n'),
  }
}

// ---------------------------------------------------------------------------
// Runner (GitHub Actions only)

// The workflow runs the base commit's copy of this script when the base
// has one (so a PR cannot edit the check it is judged by) and says which.
const CHECKER =
  process.env.PR_EVIDENCE_CHECKER === 'base'
    ? "Checker: the base commit's `.github/scripts/pr-evidence.mjs`."
    : process.env.PR_EVIDENCE_CHECKER === 'pr'
      ? "Checker: the PR's `.github/scripts/pr-evidence.mjs` (the base commit has none yet)."
      : ''

function finish(ok, title, body) {
  const markdown =
    `## PR evidence check: ${ok ? 'passed' : 'failed'}\n\n**${title}**` +
    (body ? `\n\n${body}` : '') +
    (CHECKER ? `\n\n${CHECKER}` : '')
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
  if (!ok) console.log(`::error title=PR evidence check failed::${title}`)
  process.exit(ok ? 0 : 1)
}

function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const pr = event.pull_request
  if (!pr) finish(true, 'Not a pull_request event; nothing to check.', '')
  const repo = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY
  const r = check(pr, repo)
  finish(r.ok, r.title, r.report)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main()
  } catch (err) {
    finish(
      false,
      'The check could not run.',
      `\`\`\`\n${err?.stack ?? err}\n\`\`\``,
    )
  }
}
