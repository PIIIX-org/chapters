import { z } from 'zod'

// #957: the stable identity present in every read mode, including targets,
// outlines, unchanged answers and session references. Other answer fields
// remain available without repeating their changing shapes in tools/list.
export const READ_NOTE_RESULT_SCHEMA = z.looseObject({ rev: z.number() })
export const READ_FILE_RESULT_SCHEMA = z.looseObject({ hash: z.string() })

// Bounded lists (history, trash, and the excluded reader reads measured by
// mcp-tool-budget.test.ts) can replace rows with locations or counts as the
// budget ladder drops levels; the continuation contract is the same at every
// level.
export const CONTINUATION_RESULT_SCHEMA = z.looseObject({
  truncated: z.union([z.literal(false), z.looseObject({ cursor: z.string().nullable() })]),
})
export const REVISION_RESULT_SCHEMA = z.looseObject({ id: z.string(), body: z.string() })

export const GRAPH_PREFERENCE_RESULT_SCHEMA = z.looseObject({ include: z.boolean() })
export const VAULT_PREFERENCES_RESULT_SCHEMA = z.looseObject({ storageMode: z.string() })
export const REPOSITORY_STATUS_RESULT_SCHEMA = z.looseObject({ syncStatus: z.string() })
export const VAULT_EXPORT_RESULT_SCHEMA = z.looseObject({ zipBase64: z.string() })
export const NOTE_EXPORT_RESULT_SCHEMA = z.looseObject({ markdown: z.string() })
export const USER_RESULT_SCHEMA = z.looseObject({ id: z.string() })
export const AUDIT_RESULT_SCHEMA = z.looseObject({ totalNotes: z.number() })
export const USAGE_RESULT_SCHEMA = z.looseObject({ enabled: z.boolean() })
