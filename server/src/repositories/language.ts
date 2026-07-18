const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
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
