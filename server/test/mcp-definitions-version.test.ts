// The definitions version (#681): a hash of a profile's tools/list,
// prompts/list and instructions, served as `serverInfo.version`
// (mcp-cacheable-prompt.test.ts). It is the same for every build of the same
// definitions and changes when one description does. Each build is a fresh
// import of the server module, whose version is computed once per process.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type * as Instructions from '../src/mcp/instructions.js'

type Profile = 'reader' | 'writer' | 'admin'

/** The definitions version of each profile, from a fresh build of the server module. */
async function versions(): Promise<Record<Profile, string>> {
  vi.resetModules()
  // A dynamic import: each build must load the server module afresh.
  const { definitionsVersion } = await import('../src/mcp/server.js')
  return { reader: await definitionsVersion('reader'), writer: await definitionsVersion('writer'), admin: await definitionsVersion('admin') }
}

type Register = (this: McpServer, name: string, config: { description?: string }, cb: unknown) => unknown

/** Makes every later build register `target` with an edited description. */
function editDescription(method: 'registerTool' | 'registerPrompt', target: string): void {
  // The SDK's generic overloads have no single signature to spy with.
  const register = McpServer.prototype[method] as unknown as Register
  const edited: Register = function (name, config, cb) {
    return register.call(this, name, name === target ? { ...config, description: `${config.description ?? ''} Edited.` } : config, cb)
  }
  vi.spyOn(McpServer.prototype, method).mockImplementation(edited as never)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../src/mcp/instructions.js')
})

describe('definitions version (#681)', () => {
  it('is the same for every build of the same definitions, one per profile', async () => {
    const first = await versions()
    expect(await versions()).toEqual(first)
    for (const version of Object.values(first)) expect(version).toMatch(/^0\.2\.0\+[0-9a-f]{16}$/)
    expect(new Set(Object.values(first)).size).toBe(3)
  })

  it('changes when a tool description changes, for each profile listing the tool', async () => {
    const before = await versions()
    editDescription('registerTool', 'read_note')
    const after = await versions()
    for (const profile of ['reader', 'writer', 'admin'] as const) expect(after[profile], profile).not.toBe(before[profile])
  })

  it('changes when a prompt description changes, only for the profiles listing prompts', async () => {
    const before = await versions()
    editDescription('registerPrompt', 'active_project_companion')
    const after = await versions()
    expect(after.reader).toBe(before.reader)
    expect(after.writer).not.toBe(before.writer)
    expect(after.admin).not.toBe(before.admin)
  })

  it('changes when the instructions change', async () => {
    const before = await versions()
    vi.doMock('../src/mcp/instructions.js', async (importOriginal) => {
      const actual = await importOriginal<typeof Instructions>()
      return { instructionsFor: (profile: Profile) => `${actual.instructionsFor(profile)} Edited.` }
    })
    const after = await versions()
    for (const profile of ['reader', 'writer', 'admin'] as const) expect(after[profile], profile).not.toBe(before[profile])
  })
})
