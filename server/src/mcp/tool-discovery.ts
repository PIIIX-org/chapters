import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { compareCodeUnits } from './response.js'

export const TOOL_DISCOVERY_HEADER = 'elara-tool-discovery'
export const TOOL_DISCOVERY_CAPABILITY = 'elara/tool-discovery'
export const TOOL_DISCOVERY_VERSION = z.object({ version: z.literal(1) })
export const TOOL_SEARCH_RESULT_SCHEMA = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string(), inputSchema: z.looseObject({ type: z.literal('object') }) })),
  total: z.number(),
})

/** Search actual eligible SDK descriptors; returned schemas never execute a call. */
export function discoverTools(tools: readonly Tool[], query: string, limit: number) {
  const normalized = query.toLowerCase().trim()
  const words = normalized.split(/\s+/)
  const ranked: Array<{ tool: Tool; score: number }> = []
  for (const tool of tools) {
    const name = tool.name.toLowerCase()
    const description = (tool.description ?? '').toLowerCase()
    if (!words.every((word) => name.includes(word) || description.includes(word))) continue
    const score = name === normalized ? 0 : words.every((word) => name.includes(word)) ? 1 : 2
    ranked.push({ tool, score })
  }
  ranked.sort((a, b) => a.score - b.score || compareCodeUnits(a.tool.name, b.tool.name))
  return { tools: ranked.slice(0, limit).map(({ tool }) => tool), total: ranked.length }
}
