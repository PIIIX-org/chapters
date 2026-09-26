import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config.js'
import * as schema from './schema.js'

export const sql = postgres(config.databaseUrl, {
  max: 10,
  onnotice: (notice) => {
    if (notice.severity === 'ERROR' || notice.severity === 'FATAL') {
      console.error('postgres pool notice error:', notice.message)
    }
  },
})

if (typeof (sql as { on?: unknown }).on === 'function') {
  (sql as unknown as { on: (event: string, handler: (err: unknown) => void) => void }).on(
    'error',
    (err) => {
      console.error('postgres pool error:', err)
    },
  )
}

export const db = drizzle(sql, { schema })

export type Db = typeof db
