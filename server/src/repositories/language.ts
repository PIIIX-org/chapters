/**
 * The user-visible `language` of a repository file (read_file, search
 * filters). `.tsx`, `.mts` and `.cts` are all `typescript`, so one filter
 * finds every TypeScript file (#449, #451); extraction.ts picks the grammar
 * from the file extension (TSX for `.tsx`), not from this label.
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
}

export function detectLanguage(path: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path)
  if (!match) return null
  return EXTENSION_LANGUAGE[match[1]!.toLowerCase()] ?? null
}
