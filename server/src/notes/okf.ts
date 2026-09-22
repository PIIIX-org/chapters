import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  VerificationTier,
  NoteStatus,
  GeneratedMetadata,
  SourceDescriptor,
  VerifiedMetadata,
  UsageWindow,
  OkfV2Frontmatter,
  OkfNote,
} from './okf/types.js'

export type {
  VerificationTier,
  NoteStatus,
  GeneratedMetadata,
  SourceDescriptor,
  VerifiedMetadata,
  UsageWindow,
  OkfV2Frontmatter,
  OkfNote,
}

export type Frontmatter = OkfV2Frontmatter

export const ISO_8601_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function isValidIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_8601_OFFSET_REGEX.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

export const NOTE_STATUSES: readonly NoteStatus[] = [
  'draft',
  'active',
  'deprecated',
  'superseded',
  'archived',
  'stable',
] as const

export const VERIFICATION_TIERS: readonly VerificationTier[] = [
  'unverified',
  'machine-confirmed',
  'human-reviewed',
] as const

export const STRUCTURED_KEYS = new Set([
  'generated',
  'sources',
  'verified',
  'usage_window',
  'properties',
])

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
  const nameSegments = name.split('/')
  if (nameSegments.length === 0 || nameSegments.some((seg) => !isSlug(seg))) {
    throw new OkfValidationError(`invalid name slug: ${name}`)
  }
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
    if (!isValidIsoDateTime(frontmatter.timestamp)) {
      throw new OkfValidationError('timestamp must be an ISO 8601 datetime with explicit UTC/offset')
    }
  }
  if (frontmatter.resource !== undefined && typeof frontmatter.resource !== 'string') {
    throw new OkfValidationError('resource must be a string')
  }
  if (frontmatter.title !== undefined && typeof frontmatter.title !== 'string') {
    throw new OkfValidationError('title must be a string')
  }
  if (frontmatter.description !== undefined && typeof frontmatter.description !== 'string') {
    throw new OkfValidationError('description must be a string')
  }
  if (frontmatter.stale_after !== undefined) {
    if (!isValidIsoDateTime(frontmatter.stale_after)) {
      throw new OkfValidationError('stale_after must be an ISO 8601 datetime with explicit UTC/offset')
    }
  }
  if (frontmatter.status !== undefined) {
    if (!NOTE_STATUSES.includes(frontmatter.status as NoteStatus)) {
      throw new OkfValidationError(`status must be one of: ${NOTE_STATUSES.join(', ')}`)
    }
  }
  if (frontmatter.generated !== undefined) {
    if (
      typeof frontmatter.generated !== 'object' ||
      frontmatter.generated === null ||
      Array.isArray(frontmatter.generated) ||
      typeof frontmatter.generated.by !== 'string' ||
      !isValidIsoDateTime(frontmatter.generated.at)
    ) {
      throw new OkfValidationError(
        'generated must be an object with string "by" and ISO 8601 datetime "at"',
      )
    }
  }
  if (frontmatter.sources !== undefined) {
    if (!Array.isArray(frontmatter.sources)) {
      throw new OkfValidationError('sources must be an array of objects')
    }
    for (const source of frontmatter.sources) {
      if (
        typeof source !== 'object' ||
        source === null ||
        Array.isArray(source) ||
        typeof source.resource !== 'string'
      ) {
        throw new OkfValidationError('sources items must be objects with a string "resource"')
      }
      if (source.last_modified !== undefined && !isValidIsoDateTime(source.last_modified)) {
        throw new OkfValidationError(
          'sources item last_modified must be an ISO 8601 datetime with explicit UTC/offset',
        )
      }
    }
  }
  if (frontmatter.verified !== undefined) {
    if (
      typeof frontmatter.verified !== 'object' ||
      frontmatter.verified === null
    ) {
      throw new OkfValidationError(
        `verified must be an object or array of objects with tier in: ${VERIFICATION_TIERS.join(', ')}`,
      )
    }
    const items = Array.isArray(frontmatter.verified)
      ? frontmatter.verified
      : [frontmatter.verified]
    for (const item of items) {
      if (
        typeof item !== 'object' ||
        item === null ||
        Array.isArray(item) ||
        !VERIFICATION_TIERS.includes(item.tier as VerificationTier) ||
        (item.by !== undefined && typeof item.by !== 'string') ||
        (item.at !== undefined && !isValidIsoDateTime(item.at))
      ) {
        throw new OkfValidationError(
          `verified must be an object or array of objects with valid tier (${VERIFICATION_TIERS.join(', ')})`,
        )
      }
    }
  }
  if (frontmatter.usage_window !== undefined) {
    if (
      typeof frontmatter.usage_window !== 'object' ||
      frontmatter.usage_window === null ||
      Array.isArray(frontmatter.usage_window) ||
      !isValidIsoDateTime(frontmatter.usage_window.from) ||
      (frontmatter.usage_window.to !== undefined && !isValidIsoDateTime(frontmatter.usage_window.to))
    ) {
      throw new OkfValidationError(
        'usage_window must be an object with ISO 8601 datetime "from" and optional ISO 8601 datetime "to"',
      )
    }
  }
  if (frontmatter.properties !== undefined) {
    if (
      typeof frontmatter.properties !== 'object' ||
      frontmatter.properties === null ||
      Array.isArray(frontmatter.properties)
    ) {
      throw new OkfValidationError('properties must be an object')
    }
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!isValidOkfValue(value, key)) {
      throw new OkfValidationError(`frontmatter key "${key}" must be a scalar or list of scalars`)
    }
  }
  if (typeof body !== 'string') throw new OkfValidationError('body must be a string')
}

export function isValidOkfValue(valueOrKey: unknown, keyOrValue?: unknown): boolean {
  let value = valueOrKey
  let key: string | undefined = typeof keyOrValue === 'string' ? keyOrValue : undefined
  if (typeof valueOrKey === 'string' && keyOrValue !== undefined && typeof keyOrValue !== 'string') {
    key = valueOrKey
    value = keyOrValue
  }
  if (key !== undefined && STRUCTURED_KEYS.has(key)) {
    return true
  }
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
