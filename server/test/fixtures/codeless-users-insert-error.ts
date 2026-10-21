// Preloaded (`--import`) into the restore-backup CLI by test/restore-cli-errors.test.ts:
// the driver fails every insert into "users" with an error that has no `code`
// (no SQLSTATE), which drizzle wraps in a DrizzleQueryError carrying the query
// and its parameters, as it does with any driver failure.
import { PgPreparedQuery } from 'drizzle-orm/pg-core/session'

type QueryWithCache = (queryString: string, params: unknown[], query: () => Promise<unknown>) => Promise<unknown>
const prototype = PgPreparedQuery.prototype as unknown as { queryWithCache: QueryWithCache }
const original = prototype.queryWithCache
prototype.queryWithCache = function (this: unknown, queryString, params, query) {
  const failing = () => Promise.reject(new Error('the driver failed without a code'))
  return original.call(this, queryString, params, /^insert into "users"/.test(queryString) ? failing : query)
}
