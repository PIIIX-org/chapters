export type VerificationTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

export type NoteStatus = 'draft' | 'active' | 'deprecated' | 'superseded' | 'archived' | 'stable'

export interface GeneratedMetadata {
  by: string
  at: string
}

export interface SourceDescriptor {
  id?: string
  resource: string
  title?: string
  hash?: string
  last_modified?: string
  author?: string
  usage_count?: number
  [key: string]: unknown
}

export interface VerifiedMetadata {
  tier: VerificationTier
  by?: string
  at?: string
}

export interface UsageWindow {
  from: string
  to?: string
}

export type OkfV2Frontmatter = Record<string, unknown> & {
  type: string
  title?: string
  description?: string
  status?: NoteStatus
  resource?: string
  tags?: string[]
  timestamp?: string
  stale_after?: string
  generated?: GeneratedMetadata
  sources?: SourceDescriptor[]
  verified?: VerifiedMetadata | VerifiedMetadata[]
  usage_window?: UsageWindow
  properties?: Record<string, unknown>
  [key: string]: unknown
}

export type Frontmatter = OkfV2Frontmatter

export interface OkfNote {
  frontmatter: Frontmatter
  body: string
}
