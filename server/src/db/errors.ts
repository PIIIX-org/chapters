import { DrizzleQueryError } from 'drizzle-orm/errors'
import postgres from 'postgres'

/** What a caller is told when a query failed (#443): never the query, its parameters or the row. */
export const DATABASE_FAILED = 'a database query failed'

export interface DatabaseFailure {
  /** The SQLSTATE (or the driver's error code), from the first error in the `cause` chain that has one. */
  code: string | null
  /** What the server log prints: the driver error, since drizzle's wrapper message carries every parameter. */
  logged: unknown
}

/**
 * The failed query in `err` or its `cause` chain, if there is one (#443):
 * drizzle's `DrizzleQueryError`, whose message is `Failed query: <sql>
 * params: <every parameter>`, or the driver's `PostgresError`, whose
 * detail can quote a row. Matched by class: drizzle does not set the
 * error's `name` (#813). Any other error is undefined.
 */
export function databaseFailure(err: unknown): DatabaseFailure | undefined {
  let failed = false
  let code: string | null = null
  let logged: unknown
  const seen = new Set<unknown>()
  for (let current = err; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current)
    if (current instanceof DrizzleQueryError) {
      failed = true
      // Without a driver error, the statement alone (no parameters).
      logged ??= current.cause ?? `DrizzleQueryError: ${current.query}`
    } else if (current instanceof postgres.PostgresError) {
      failed = true
      logged = current
    }
    if (code === null && 'code' in current && typeof current.code === 'string') code = current.code
  }
  return failed ? { code, logged } : undefined
}
