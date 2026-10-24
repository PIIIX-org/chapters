// How the lab reads an MCP tool answer's content (McpClient, rawMcp).

/**
 * A tool answer's JSON: `content[0].text` parsed, with each
 * `{"in": "content[n]"}` marker replaced by that block's text (read_note
 * sends its body as plain text in `content[1]`, #445). Undefined when
 * `content[0]` is not JSON.
 */
export function answerJson(content: ReadonlyArray<{ text?: string }>): unknown {
  let json: unknown
  try {
    json = JSON.parse(content[0]?.text ?? '')
  } catch {
    return undefined
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return json
  for (const [key, value] of Object.entries(json)) {
    const marker = value !== null && typeof value === 'object' && 'in' in value ? value.in : undefined
    const at = typeof marker === 'string' ? /^content\[(\d+)\]$/.exec(marker) : null
    if (!at) continue
    const block = content[Number(at[1])]
    // A marker without its block is a broken answer, not an empty body.
    if (block === undefined) throw new Error(`${key} is in ${marker}, but the answer has ${content.length} content blocks`)
    Reflect.set(json, key, block.text ?? '')
  }
  return json
}
