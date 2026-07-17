import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** OKF frontmatter: the four standard keys plus extensible scalar/list keys. */
export type Frontmatter = Record<string, unknown> & {
  type: string
  resource?: string
  tags?: string[]
  timestamp?: string
}

export interface OkfNote {
  frontmatter: Frontmatter
  body: string
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/

export function isSlug(value: string): boolean {
  return SLUG.test(value)
}

export class OkfValidationError extends Error {}

/**
 * The shared OKF validation (Editor spec hardening): every write path —
 * REST, CRDT persistence, MCP — validates through here. Slug-only path
 * segments make traversal impossible by construction.
 */
export function validateNote(
  type: string,
  name: string,
  frontmatter: Frontmatter,
  body: string,
): void {
  if (!isSlug(type)) throw new OkfValidationError(`invalid type slug: ${type}`)
  if (!isSlug(name)) throw new OkfValidationError(`invalid name slug: ${name}`)
  if (frontmatter.type !== type) {
    throw new OkfValidationError(
      `frontmatter type "${String(frontmatter.type)}" does not match path type "${type}"`,
    )
  }
  if (frontmatter.tags !== undefined) {
    if (
      !Array.isArray(frontmatter.tags) ||
      frontmatter.tags.some((t) => typeof t !== 'string')
    ) {
      throw new OkfValidationError('tags must be an array of strings')
    }
  }
  if (frontmatter.timestamp !== undefined) {
    if (
      typeof frontmatter.timestamp !== 'string' ||
      Number.isNaN(Date.parse(frontmatter.timestamp))
    ) {
      throw new OkfValidationError('timestamp must be an ISO date string')
    }
  }
  if (frontmatter.resource !== undefined && typeof frontmatter.resource !== 'string') {
    throw new OkfValidationError('resource must be a string')
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!isValidOkfValue(value)) {
      throw new OkfValidationError(`frontmatter key "${key}" must be a scalar or list of scalars`)
    }
  }
  if (typeof body !== 'string') throw new OkfValidationError('body must be a string')
}

function isValidOkfValue(value: unknown): boolean {
  const scalar = (v: unknown) =>
    v === null || ['string', 'number', 'boolean'].includes(typeof v)
  return scalar(value) || (Array.isArray(value) && value.every(scalar))
}

export function serializeNote(note: OkfNote): string {
  return `---\n${stringifyYaml(note.frontmatter)}---\n${note.body}`
}

export function parseNote(raw: string): OkfNote {
  const match = raw.match(/^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/)
  if (!match) throw new OkfValidationError('missing frontmatter fence')
  const frontmatter = parseYaml(match[1]!) as Frontmatter
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    throw new OkfValidationError('frontmatter must be a YAML mapping')
  }
  return { frontmatter, body: match[2] ?? '' }
}

/** Extracts `[[wikilink]]` targets from a note body (for the graph engine). */
export function extractWikilinks(body: string): string[] {
  const links: string[] = []
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const target = match[1]!.trim()
    if (target) links.push(target)
  }
  return [...new Set(links)]
}
