import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let vaultId: string
let accountToken: string

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

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)

  const vaultRes = await app.inject({
    method: 'POST',
    url: '/api/vaults',
    headers: { cookie: ownerCookie },
    body: { name: 'Prompts Vault' },
  })
  vaultId = (vaultRes.json() as { id: string }).id

  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: {
      type: 'project',
      name: 'elara',
      body: 'Elara flagship knowledge base project note.',
    },
  })

  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: {
      type: 'spec',
      name: 'scheduled-backups',
      body: 'Specification for automated scheduled backups to object storage.',
    },
  })

  const account = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'prompt-test-agent', scope: 'account' },
    })
  ).json() as { id: string; token: string }
  accountToken = account.token
})

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('MCP Prompts Suite (20 Engineering Prompts)', () => {
  it('lists all 20 registered prompts with descriptions and arguments', async () => {
    const client = await mcpClient(accountToken)
    const result = await client.listPrompts()
    const names = result.prompts.map((p) => p.name)

    const expectedPrompts = [
      'active_project_companion',
      'sync_local_docs_to_vault',
      'plan_feature_implementation',
      'prepare_task_context',
      'draft_adr',
      'draft_rfc',
      'generate_api_spec',
      'explain_code_architecture',
      'onboard_subsystem',
      'summarize_concept_chain',
      'audit_architecture_drift',
      'refactor_impact_analysis',
      'audit_orphaned_code',
      'test_gap_analysis',
      'pr_review_against_specs',
      'generate_release_notes',
      'audit_security_surface',
      'database_schema_evolution',
      'supernode_bottleneck_audit',
      'incident_postmortem',
    ]

    expect(result.prompts.length).toBe(20)
    for (const expected of expectedPrompts) {
      expect(names).toContain(expected)
      const prompt = result.prompts.find((p) => p.name === expected)
      expect(prompt?.description).toBeTruthy()
    }
  })

  it('evaluates active_project_companion prompt and hydrates session guidance', async () => {
    const client = await mcpClient(accountToken)
    const prompt = await client.getPrompt({
      name: 'active_project_companion',
      arguments: {
        projectName: 'elara',
        taskDescription: 'Implement MCP prompts suite with 20 engineering workflows',
        vaultId,
      },
    })

    expect(prompt.messages).toHaveLength(1)
    const text = (prompt.messages[0]?.content as { type: string; text: string }).text
    expect(text).toContain('You are actively pairing on project "elara"')
    expect(text).toContain('Implement MCP prompts suite with 20 engineering workflows')
    expect(text).toContain('session/')
    expect(text).toContain('Elara flagship knowledge base project note')
    expect(text).toContain('create_note')
  })

  it('evaluates sync_local_docs_to_vault prompt with validation steps', async () => {
    const client = await mcpClient(accountToken)
    const prompt = await client.getPrompt({
      name: 'sync_local_docs_to_vault',
      arguments: {
        directoryPath: 'docs/superpowers/specs',
        vaultId,
      },
    })

    expect(prompt.messages).toHaveLength(1)
    const text = (prompt.messages[0]?.content as { type: string; text: string }).text
    expect(text).toContain('docs/superpowers/specs')
    expect(text).toContain(vaultId)
    expect(text).toContain('VALIDATE OKF v0.2')
  })

  it('evaluates draft_adr prompt and scaffolds compliant OKF v0.2 ADR template', async () => {
    const client = await mcpClient(accountToken)
    const prompt = await client.getPrompt({
      name: 'draft_adr',
      arguments: {
        title: 'Use Redis for Session Cache',
        problem: 'Database connection pool contention under high traffic',
        decision: 'Introduce Redis cluster for distributed session caching',
        codeTarget: 'server/src/auth/sessions.ts#verifySession',
        vaultId,
      },
    })

    expect(prompt.messages).toHaveLength(1)
    const text = (prompt.messages[0]?.content as { type: string; text: string }).text
    expect(text).toContain('type: adr')
    expect(text).toContain('title: "Use Redis for Session Cache"')
    expect(text).toContain('[[repo:server/src/auth/sessions.ts#verifySession]]')
    expect(text).toContain('adr/use-redis-for-session-cache')
  })

  it('evaluates summarize_concept_chain prompt', async () => {
    const client = await mcpClient(accountToken)
    const prompt = await client.getPrompt({
      name: 'summarize_concept_chain',
      arguments: {
        sourceNode: 'project/elara',
        targetNode: 'spec/scheduled-backups',
        vaultId,
      },
    })

    expect(prompt.messages).toHaveLength(1)
    const text = (prompt.messages[0]?.content as { type: string; text: string }).text
    expect(text).toContain('project/elara')
    expect(text).toContain('spec/scheduled-backups')
    expect(text).toContain('Explain the architectural connection')
  })

  it('evaluates explain_code_architecture prompt', async () => {
    const client = await mcpClient(accountToken)
    const prompt = await client.getPrompt({
      name: 'explain_code_architecture',
      arguments: {
        repositoryName: 'elara',
        filePath: 'server/src/sync/collab-server.ts',
        symbol: 'writeThroughCollab',
        vaultId,
      },
    })

    expect(prompt.messages).toHaveLength(1)
    const text = (prompt.messages[0]?.content as { type: string; text: string }).text
    expect(text).toContain('server/src/sync/collab-server.ts')
    expect(text).toContain('writeThroughCollab')
    expect(text).toContain('ANALYSIS GUIDELINES')
  })

  it('evaluates incident_postmortem prompt and scaffolds blameless template', async () => {
    const client = await mcpClient(accountToken)
    const prompt = await client.getPrompt({
      name: 'incident_postmortem',
      arguments: {
        incidentTitle: 'Postgres Connection Pool Saturation',
        symptoms: '504 Gateway Timeouts across REST endpoints for 8 minutes',
        rootCause: 'Leaked database client in background sync worker',
        affectedSymbols: 'server/src/repositories/scheduler.ts#pollRepositories',
        vaultId,
      },
    })

    expect(prompt.messages).toHaveLength(1)
    const text = (prompt.messages[0]?.content as { type: string; text: string }).text
    expect(text).toContain('type: incident')
    expect(text).toContain('Post-Mortem: Postgres Connection Pool Saturation')
    expect(text).toContain('Leaked database client in background sync worker')
    expect(text).toContain('incident/postgres-connection-pool-saturation')
  })
})
