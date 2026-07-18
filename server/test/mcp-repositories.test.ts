import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let repoId: string
let accountToken: string
let repoScopedToken: string
let otherRepoId: string

const clients: Client[] = []

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content[0]?.text ?? ''
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)

  const repo = (
    await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie: ownerCookie },
      body: { name: 'mcp-repo', ingestionMethod: 'agent_push' },
    })
  ).json() as { id: string }
  repoId = repo.id
  await syncRepositoryFiles(
    repoId,
    [{ path: 'src/service.ts', content: "import './helper'\nexport function run() { return 1 }" }, { path: 'src/helper.ts', content: 'export const helper = 1' }],
    ['src/service.ts', 'src/helper.ts'],
  )
  await flushExtraction()

  const otherRepo = (
    await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie: ownerCookie },
      body: { name: 'mcp-other-repo', ingestionMethod: 'agent_push' },
    })
  ).json() as { id: string }
  otherRepoId = otherRepo.id

  accountToken = (
    (await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'account-agent', scope: 'account' },
    })).json() as { token: string }
  ).token

  repoScopedToken = (
    (await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'repo-agent', scope: 'repository', repositoryId: repoId },
    })).json() as { token: string }
  ).token
})

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('MCP repository tools', () => {
  it('creating a repository-scoped connection requires access to that repository', async () => {
    const stranger = await createActiveUser()
    const strangerCookie = await loginCookie(app, stranger.email)
    const denied = await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: strangerCookie },
      body: { name: 'nope', scope: 'repository', repositoryId: repoId },
    })
    expect(denied.statusCode).toBe(404)
  })

  it('list_repositories works for account-scoped connections, hard-rejected for repository-scoped', async () => {
    const account = await mcpClient(accountToken)
    const list = await account.callTool({ name: 'list_repositories', arguments: {} })
    expect(list.isError).toBeFalsy()
    expect(textOf(list)).toContain('mcp-repo')

    const scoped = await mcpClient(repoScopedToken)
    const rejected = await scoped.callTool({ name: 'list_repositories', arguments: {} })
    expect(rejected.isError).toBe(true)
    expect(textOf(rejected)).toContain('account-scoped')
  })

  it('browse_repository and read_file work with the declared-symbol outline', async () => {
    const scoped = await mcpClient(repoScopedToken)
    const browse = await scoped.callTool({ name: 'browse_repository', arguments: {} })
    expect(textOf(browse)).toContain('src/service.ts')

    const read = await scoped.callTool({ name: 'read_file', arguments: { path: 'src/service.ts' } })
    const parsed = JSON.parse(textOf(read)) as {
      content: string
      symbols: Array<{ name: string; kind: string }>
    }
    expect(parsed.content).toContain('function run')
    expect(parsed.symbols.some((s) => s.name === 'run' && s.kind === 'function')).toBe(true)
  })

  it('a repository-scoped connection is rejected for a different repository', async () => {
    const scoped = await mcpClient(repoScopedToken)
    const res = await scoped.callTool({
      name: 'browse_repository',
      arguments: { repositoryId: otherRepoId },
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('pinned to a different repository')
  })

  it('search and graph accept a repositoryId and find code content', async () => {
    const account = await mcpClient(accountToken)
    const search = await account.callTool({
      name: 'search',
      arguments: { query: 'helper', repositoryId: repoId },
    })
    expect(textOf(search)).toContain('src/helper.ts')

    const graph = await account.callTool({ name: 'graph', arguments: { repositoryId: repoId } })
    const parsed = JSON.parse(textOf(graph)) as { nodes: unknown[] }
    expect(parsed.nodes.length).toBeGreaterThan(0)
  })

  it('repository_status reports sync freshness', async () => {
    const scoped = await mcpClient(repoScopedToken)
    const res = await scoped.callTool({ name: 'repository_status', arguments: {} })
    const parsed = JSON.parse(textOf(res)) as { syncStatus: string }
    expect(parsed.syncStatus).toBe('idle')
  })

  it('a vault-scoped connection is hard-rejected from repository tools', async () => {
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie: ownerCookie },
        body: { name: 'mcp-vault-for-repo-test' },
      })
    ).json() as { id: string }
    const vaultToken = (
      (await app.inject({
        method: 'POST',
        url: '/api/mcp-connections',
        headers: { cookie: ownerCookie },
        body: { name: 'vault-agent', scope: 'vault', vaultId: vault.id },
      })).json() as { token: string }
    ).token
    const client = await mcpClient(vaultToken)
    const res = await client.callTool({ name: 'browse_repository', arguments: { repositoryId: repoId } })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('scoped to a vault')
  })
})
