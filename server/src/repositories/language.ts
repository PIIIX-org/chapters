/**
 * The user-visible `language` of a repository file (read_file, search
 * filters). `.tsx`, `.mts` and `.cts` are all `typescript`, so one filter
 * finds every TypeScript file (#449, #451); extraction.ts picks the grammar
 * from the file extension (TSX for `.tsx`), not from this label. A `.h`
 * header is `c` (parsed as C). Markdown and HTML get heading outlines, not
 * symbols (outline.ts, #464). A sync labels a file it writes; extraction
 * relabels an unchanged file whose label a new version of this table changed.
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
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  swift: 'swift',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
}

export function detectLanguage(path: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path)
  if (!match) return null
  return EXTENSION_LANGUAGE[match[1]!.toLowerCase()] ?? null
}
