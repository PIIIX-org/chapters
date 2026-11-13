import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

// Limits apply before Git sees an untrusted pack, including delta instructions, not just HTTP bytes.
export const PACK_LIMITS = { request: 16 * 1024 * 1024, object: 8 * 1024 * 1024, expanded: 64 * 1024 * 1024, objects: 4096, milliseconds: 15_000 }
const OID = /^[0-9a-f]{40}$/
export const MAIN = 'refs/heads/main'

export class GitPushError extends Error {
  readonly statusCode = 400
}

export function pkt(text: string): Buffer {
  const data = Buffer.from(text)
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data])
}

/** Report-status and SHA-1 only: no sideband, multiple refs, push options, signed pushes or atomic claims. */
export function advertisement(head: string): Buffer {
  if (!OID.test(head)) throw new GitPushError('invalid remote ref')
  return Buffer.concat([pkt('# service=git-receive-pack\n'), Buffer.from('0000'), pkt(`${head} ${MAIN}\0report-status object-format=sha1 agent=elara\n`), Buffer.from('0000')])
}

export interface PushCommand { old: string; next: string; pack: Buffer }

export function parsePush(request: Buffer): PushCommand {
  if (request.length > PACK_LIMITS.request || request.length < 8) throw new GitPushError('push exceeds request limit or is truncated')
  const lengthText = request.subarray(0, 4).toString('ascii')
  if (!/^[0-9a-f]{4}$/i.test(lengthText)) throw new GitPushError('not a pkt-line push')
  const length = parseInt(lengthText, 16)
  if (length < 4 || length > 1024 || length + 4 > request.length || request.subarray(length, length + 4).toString() !== '0000') {
    throw new GitPushError('exactly one main ref update is supported')
  }
  const command = request.subarray(4, length).toString('utf8').replace(/\n$/, '').split('\0')
  const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) refs\/heads\/main$/.exec(command[0] ?? '')
  const capabilities = command[1]?.split(' ').filter(Boolean) ?? []
  if (!match || command.length > 2 || !capabilities.includes('report-status')) throw new GitPushError('only a report-status main update is supported')
  const unsupported = capabilities.find((cap) => cap !== 'report-status' && cap !== 'object-format=sha1' && !/^agent=[!-~]+$/.test(cap))
  if (unsupported) throw new GitPushError(`unsupported push capability ${JSON.stringify(unsupported.slice(0, 80))}`)
  if (match[1] === '0'.repeat(40) || match[2] === '0'.repeat(40)) throw new GitPushError('creating or deleting the main ref is not supported')
  const pack = request.subarray(length + 4)
  validatePack(pack)
  return { old: match[1]!, next: match[2]!, pack }
}

/** A real pack v2/v3, bounded per inflated object and in aggregate; Git subsequently checks deltas, hashes and connectivity. */
export function validatePack(pack: Buffer): void {
  if (pack.length < 32 || pack.subarray(0, 4).toString() !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4))) throw new GitPushError('not a supported Git pack')
  const count = pack.readUInt32BE(8)
  if (count > PACK_LIMITS.objects) throw new GitPushError('too many packed objects')
  const end = pack.length - 20
  if (!createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end))) throw new GitPushError('pack checksum mismatch')
  let offset = 12
  let expanded = 0
  const started = performance.now()
  for (let object = 0; object < count; object++) {
    if (performance.now() - started > PACK_LIMITS.milliseconds || offset >= end) throw new GitPushError('pack limit or truncated object')
    let byte = pack[offset++]!
    const type = (byte >> 4) & 7
    if (![1, 2, 3, 4, 6, 7].includes(type)) throw new GitPushError('unsupported packed object type')
    let size = byte & 15
    let factor = 16
    while (byte & 128) {
      if (offset >= end || factor > PACK_LIMITS.object) throw new GitPushError('invalid packed object size')
      byte = pack[offset++]!
      size += (byte & 127) * factor
      factor *= 128
    }
    if (size > PACK_LIMITS.object) throw new GitPushError('packed object exceeds size limit')
    if (type === 7) offset += 20
    if (type === 6) {
      do {
        if (offset >= end) throw new GitPushError('truncated delta base')
        byte = pack[offset++]!
      } while (byte & 128)
    }
    if (offset >= end) throw new GitPushError('truncated compressed object')
    try {
      // Node's synchronous `info` result is not represented by @types/node's Buffer-only overload.
      const decoded = inflateSync(pack.subarray(offset, end), { maxOutputLength: PACK_LIMITS.object, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
      if (decoded.buffer.length !== size || decoded.engine.bytesWritten <= 0) throw new GitPushError('packed size mismatch')
      expanded += decoded.buffer.length
      if (expanded > PACK_LIMITS.expanded) throw new GitPushError('pack expansion exceeds limit')
      // A delta's result size is an unsigned base-128 integer following its base size.
      if (type === 6 || type === 7) {
        let cursor = 0
        for (let field = 0; field < 2; field++) {
          let value = 0
          let multiplier = 1
          do {
            if (cursor >= decoded.buffer.length || multiplier > PACK_LIMITS.object * 128) throw new GitPushError('invalid delta size')
            byte = decoded.buffer[cursor++]!
            value += (byte & 127) * multiplier
            multiplier *= 128
          } while (byte & 128)
          if (value > PACK_LIMITS.object) throw new GitPushError('delta result/base exceeds limit')
          expanded += value
          if (expanded > PACK_LIMITS.expanded) throw new GitPushError('delta expansion exceeds limit')
        }
      }
      offset += decoded.engine.bytesWritten
    } catch (err) {
      if (err instanceof GitPushError) throw err
      throw new GitPushError('invalid or oversized compressed pack object')
    }
  }
  if (offset !== end) throw new GitPushError('trailing or missing pack objects')
}

/** Minimal child environment; no server credentials, global Git configuration, hooks, replace refs, lazy fetch or prompts. */
export function boundedGit(args: string[], cwd: string, input?: Buffer, maxOutput = PACK_LIMITS.expanded): Promise<Buffer> {
  // The shared ES2023 type library does not expose Promise.withResolvers.
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', ...args], {
      cwd,
      env: { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
    })
    const out: Buffer[] = []
    let bytes = 0
    let failure: Error | null = null
    const fail = (message: string) => { failure ??= new GitPushError(message); child.kill('SIGKILL') }
    const timer = setTimeout(() => fail('Git time limit exceeded'), PACK_LIMITS.milliseconds)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxOutput) fail('Git output limit exceeded')
      else out.push(chunk)
    })
    child.stderr.resume()
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure ?? new GitPushError(`Git ${args[0]} refused the request`))
      else resolve(Buffer.concat(out))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
