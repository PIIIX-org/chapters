// The error envelope's catalogue (#439, mcp/errors.ts): the codes and
// `retryable` flags of the domain errors a tool call can throw, which the
// MCP tests cannot all provoke (a busy store, the maintenance lock, a file
// system error), and RATE_LIMITED, which #440 sends with HTTP 429. Kept in
// its own file: before #439 the module does not exist, so this file fails on
// its import; mcp-errors.test.ts is the assertion-level proof.
import { describe, expect, it } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { McpToolError, envelope, errorResult, rateLimitedError, toErrorEnvelope } from '../src/mcp/errors.js'
import { CursorError } from '../src/mcp/response.js'
import { IdempotencyKeyReusedError } from '../src/mcp/write-result.js'
import { NoteNotMigratedError, StoreBusyError } from '../src/notes/store-tx.js'
import { MaintenanceInProgressError } from '../src/notes/maintenance-lock.js'
import { NoteWriteQuarantinedError } from '../src/notes/growth-guard.js'
import { NoteTooLargeError } from '../src/notes/size-cap.js'
import { OkfValidationError, SLUG_RULE } from '../src/notes/okf.js'
import { NoteEditError } from '../src/sync/edit-ops.js'

describe('error envelope catalogue (#439)', () => {
  it('RATE_LIMITED is retryable after retryAfterMs, for #440', () => {
    expect(rateLimitedError(1500)).toEqual({
      code: 'RATE_LIMITED',
      message: 'rate limit exceeded for this connection',
      retryable: true,
      retryAfterMs: 1500,
    })
  })

  it('busy stores are BUSY and retryable, a note waiting for the store migration too (a write answers it as status retry)', () => {
    expect(toErrorEnvelope(new StoreBusyError('lock timeout'))).toMatchObject({ code: 'BUSY', retryable: true })
    expect(toErrorEnvelope(new MaintenanceInProgressError('shared'))).toMatchObject({ code: 'BUSY', retryable: true })
    expect(toErrorEnvelope(new NoteNotMigratedError())).toMatchObject({ code: 'BUSY', retryable: true })
  })

  it('domain refusals keep their message and get their code and rule', () => {
    expect(toErrorEnvelope(new OkfValidationError('invalid path segment: A', 'invalid', SLUG_RULE))).toEqual({
      code: 'OKF_INVALID',
      message: 'invalid path segment: A',
      retryable: false,
      rule: '^[a-z0-9][a-z0-9-]*$',
    })
    expect(toErrorEnvelope(new NoteTooLargeError(20, 10))).toMatchObject({ code: 'TOO_LARGE', rule: 'note body at most 10 bytes (UTF-8, ELARA_NOTE_MAX_BYTES)' })
    expect(toErrorEnvelope(new NoteTooLargeError(20, 10, undefined, false, 'frontmatter'))).toMatchObject({
      code: 'TOO_LARGE',
      rule: 'note frontmatter (keys and values as JSON) at most 10 bytes (UTF-8, ELARA_NOTE_MAX_BYTES)',
    })
    const finding = { rule: 'growth' as const, previousBytes: 4096, nextBytes: 9000, repeatedBytes: 0 }
    expect(toErrorEnvelope(new NoteWriteQuarantinedError('docs/a', finding, 'rev-1', false))).toMatchObject({ code: 'QUARANTINED', rule: 'growth', retryable: false })
    expect(toErrorEnvelope(new NoteEditError('ops[0] append: `text` is empty'))).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(toErrorEnvelope(new IdempotencyKeyReusedError('k', 'edit_note'))).toMatchObject({ code: 'CONFLICT', retryable: false })
    expect(toErrorEnvelope(new CursorError('CURSOR_STALE', 'stale cursor: x'))).toEqual({ code: 'CURSOR_STALE', message: 'stale cursor: x', retryable: false })
  })

  it('a file system error is INTERNAL with its code only; any other error is INTERNAL with its message', () => {
    const fsError = Object.assign(new Error("ENOENT: no such file or directory, rename '/data/vaults/x.md.tmp'"), { syscall: 'rename', code: 'ENOENT' })
    const original = console.error
    console.error = () => {}
    try {
      expect(toErrorEnvelope(fsError)).toEqual({ code: 'INTERNAL', message: 'internal storage error (ENOENT)', retryable: false })
    } finally {
      console.error = original
    }
    expect(toErrorEnvelope(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom', retryable: false })
  })

  it('a failed query is INTERNAL with a fixed message and its code, never its SQL or parameters; the log names the statement, not its values (#443)', () => {
    const original = console.error
    const logged: unknown[][] = []
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      const driver = Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' })
      const wrapped = new DrizzleQueryError('insert into "notes" ("body") values ($1)', ['secret body'], driver)
      expect(toErrorEnvelope(wrapped)).toEqual({ code: 'INTERNAL', message: 'a database query failed (CONNECTION_CLOSED)', retryable: false })
      expect(logged).toEqual([['[mcp] tool failed:', driver, { query: 'insert into "notes" ("body") values ($1)' }]])
      expect(toErrorEnvelope(new DrizzleQueryError('select 1', []))).toEqual({ code: 'INTERNAL', message: 'a database query failed', retryable: false })
    } finally {
      console.error = original
    }
  })

  it('keys come in one order, absent fields and empty suggestions left out', () => {
    expect(JSON.stringify(envelope('NOT_FOUND', 'not found', { suggestions: [] }))).toBe('{"code":"NOT_FOUND","message":"not found","retryable":false}')
    const full = envelope('INVALID_ARGUMENT', 'm', { suggestions: ['b'], field: 'f', rule: 'r', retryAfterMs: 5 })
    expect(Object.keys(full)).toEqual(['code', 'message', 'retryable', 'retryAfterMs', 'rule', 'field', 'suggestions'])
    expect(errorResult(toErrorEnvelope(new McpToolError('NOT_FOUND', 'not found')))).toEqual({
      content: [{ type: 'text', text: '{"error":{"code":"NOT_FOUND","message":"not found","retryable":false}}' }],
      isError: true,
    })
  })
})
