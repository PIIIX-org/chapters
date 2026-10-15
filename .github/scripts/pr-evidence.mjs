// PR evidence check (#579). A PR body must have an Evidence section, and a
// claim like "all tests pass", "verified" or "100%" must sit in a sentence,
// bullet or table row that links the run or artifact behind it: a GitHub
// Actions run, PR, issue, commit or file of this repo. Template:
// .github/pull_request_template.md; rules: docs/agents/github-workflow.md.
//
// Plain Node, no dependencies. Reads the PR from the event file; the
// workflow runs the base commit's copy of this file when there is one.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Words that claim a result. Whole words, case-insensitive. */
export const CLAIMS = [
  ['100%', /(?<![\w.])100\s?%/i],
  ['verified', /\bverified\b/i],
  ['fully tested', /\bfully[\s-]+tested\b/i],
  ['all tests pass', /\ball\s+(?:the\s+)?tests\s+pass(?:es|ed|ing)?\b/i],
  ['production-ready', /\bproduction[\s-]ready\b/i],
  ['stable', /\bstable\b/i],
  ['zero bugs', /\bzero\s+bugs?\b/i],
  ['remediated', /\bremediated\b/i],
]

/**
 * Body lines with HTML comments (template hints; GitHub hides them, an
 * unclosed one to the end) and fenced code blocks removed.
 */
function proseLines(body) {
  const text = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/, '')
  const out = []
  let fence = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (m) {
      fence = m[1]
      continue
    }
    out.push(line)
  }
  return out
}

const HEADING = /^\s{0,3}(#{1,6})\s/
const BOLD_EVIDENCE = /^\s*\*\*evidence:?\*\*:?\s*(.*)$/i
const BOLD_LABEL = /^\s*\*\*(?:[^*]+\*\*:?\s*$|[^*]+:\*\*)/

/**
 * The content of the first non-empty Evidence section, or null. A section
 * is a heading `# Evidence` .. `###### Evidence ...` running to the next
 * heading of the same or a higher level, or a bold `**Evidence**` /
 * `**Evidence:**` line running to the next heading or bold label line.
 * Comments and code fences do not count as content.
 */
export function evidenceSection(body) {
  const lines = proseLines(body)
  for (let i = 0; i < lines.length; i++) {
    const heading = /^\s{0,3}(#{1,6})\s+evidence\b/i.exec(lines[i])
    const bold = heading ? null : BOLD_EVIDENCE.exec(lines[i])
    if (!heading && !bold) continue
    const content = bold ? [bold[1]] : []
    for (let j = i + 1; j < lines.length; j++) {
      const h = HEADING.exec(lines[j])
      if (heading && h && h[1].length <= heading[1].length) break
      if (bold && (h || BOLD_LABEL.test(lines[j]))) break
      content.push(lines[j])
    }
    const text = content.join('\n').trim()
    if (text !== '') return text
  }
  return null
}

const LIST_ITEM = /^([-*+]|\d+[.)])\s+/
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'(*_`[])/

/**
 * The units a claim is judged in: each sentence of a paragraph, each list
 * item (with its continuation lines), each table row and each heading.
 */
export function proseUnits(body) {
  const units = []
  let para = []
  let item = null
  const flush = () => {
    if (para.length > 0) {
      for (const s of para.join(' ').split(SENTENCE_END)) {
        if (s.trim() !== '') units.push(s.trim())
      }
      para = []
    }
    if (item !== null) units.push(item)
    item = null
  }
  for (const line of proseLines(body)) {
    const t = line.trim()
    if (t === '') {
      flush()
    } else if (HEADING.test(t) || t.startsWith('|')) {
      flush()
      units.push(t)
    } else if (LIST_ITEM.test(t)) {
      flush()
      item = t
    } else if (item !== null) {
      item += ` ${t}`
    } else {
      const q = t.replace(/^(>\s?)+/, '').trim()
      if (q !== '') para.push(q)
    }
  }
  flush()
  return units
}

/** Claim labels in a unit, ignoring inline code and URLs. */
export function claimsIn(text) {
  const prose = text
    .replace(/(`+)[\s\S]*?\1/g, ' ')
    .replace(/https?:\/\/[^\s)<>\]]+/gi, ' ')
  return CLAIMS.filter(([, re]) => re.test(prose)).map(([label]) => label)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a unit links an Actions run, PR, issue, commit or file of `repo`. */
export function hasEvidenceLink(text, repo) {
  const re = new RegExp(
    String.raw`https?://(?:www\.)?github\.com/${escapeRe(repo)}/` +
      String.raw`(?:actions/runs/\d|pull/\d|issues/\d|commit/[0-9a-f]{7,40}\b|blob/\S|tree/\S)`,
    'i',
  )
  return re.test(text)
}

/** [{ claims, text }] for every unit with a claim and no evidence link. */
export function unlinkedClaims(body, repo) {
  const out = []
  for (const text of proseUnits(body)) {
    const claims = claimsIn(text)
    if (claims.length > 0 && !hasEvidenceLink(text, repo)) {
      out.push({ claims, text })
    }
  }
  return out
}

const cell = (s) => {
  const t = s.length > 200 ? `${s.slice(0, 197)}...` : s
  return t.replace(/\|/g, '\\|')
}

/**
 * The verdict for a PR: { ok, skipped, missingEvidence, claims, title,
 * report } (report is markdown). Applies to every PR the workflow runs on,
 * promotions included. Dependabot bodies are generated upstream release
 * notes, not claims by the author, so they are skipped.
 */
export function check(pr, repo) {
  if (pr.user?.login === 'dependabot[bot]') {
    return {
      ok: true,
      skipped: true,
      missingEvidence: false,
      claims: [],
      title: 'Dependabot PR: skipped.',
      report: 'The body is generated by Dependabot; CI checks the change.',
    }
  }
  const missingEvidence = evidenceSection(pr.body) === null
  const claims = unlinkedClaims(pr.body, repo)
  const parts = []
  if (missingEvidence) {
    parts.push(
      'The PR body has no `## Evidence` section, or it holds only comments. Add one with ' +
        'links: the CI run, the fails-before run (or a `Fails-before: n/a because ...` line), ' +
        'the lab run for integration changes, the benchmark delta for retrieval or token ' +
        'changes. Template: `.github/pull_request_template.md`.',
    )
  }
  if (claims.length > 0) {
    parts.push(
      `${claims.length} sentence(s), bullet(s) or row(s) make a claim with no link to a ` +
        `GitHub Actions run, PR, issue, commit or file of \`${repo}\`. Link the run or ` +
        'artifact in the same sentence or bullet, or reword it. A word quoted in backticks ' +
        'is not a claim.\n\n| Claim | Text |\n| --- | --- |\n' +
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
    missingEvidence,
    claims,
    title: ok
      ? 'The PR body has an Evidence section and every claim links its evidence.'
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
