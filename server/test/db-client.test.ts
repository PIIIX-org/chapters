import { describe, expect, it, vi } from 'vitest'
import { sql, db } from '../src/db/client.js'

describe('db client configuration and listeners', () => {
  it('initializes drizzle db with postgres sql instance', () => {
    expect(sql).toBeDefined()
    expect(db).toBeDefined()
  })

  it('handles postgres notices via onnotice callback', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Options are exposed on the postgres instance
    const options = (sql as unknown as { options: { onnotice?: (notice: { severity: string; message: string }) => void } }).options
    expect(typeof options?.onnotice).toBe('function')

    // Test non-error notice (should not log to console.error)
    options.onnotice!({ severity: 'NOTICE', message: 'routine notice' })
    expect(errorSpy).not.toHaveBeenCalled()

    // Test error/fatal notice (should log to console.error)
    options.onnotice!({ severity: 'ERROR', message: 'fatal connection warning' })
    expect(errorSpy).toHaveBeenCalledWith(
      'postgres pool notice error:',
      'fatal connection warning',
    )

    errorSpy.mockRestore()
  })

  it('can query the database via sql tagged template', async () => {
    const result = await sql`SELECT 1 as num`
    expect(result).toHaveLength(1)
    expect(result[0]?.num).toBe(1)
  })
})
