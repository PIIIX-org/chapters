import { isSlug, OkfValidationError } from '../okf.js'

export interface ResolvedNotePath {
  fullPath: string
  directory: string
  baseName: string
  segments: string[]
  type: string
  name: string
  isRootBundleFile: boolean
  ancestorDirectories: string[]
}

export function resolveNotePath(inputPath: string): ResolvedNotePath {
  if (typeof inputPath !== 'string') {
    throw new OkfValidationError('note path must be a string')
  }

  let p = inputPath.trim()

  if (p.includes('\0')) {
    throw new OkfValidationError('note path contains null bytes')
  }

  p = p.replace(/\\/g, '/')

  if (p.endsWith('.md')) {
    p = p.slice(0, -3)
  }

  if (p.length === 0) {
    throw new OkfValidationError('note path cannot be empty')
  }

  if (p.startsWith('/') || p.endsWith('/') || p.includes('//')) {
    throw new OkfValidationError('note path cannot have leading, trailing, or consecutive slashes')
  }

  const segments = p.split('/')

  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    throw new OkfValidationError('note path cannot be empty')
  }

  if (segments.length > 8) {
    throw new OkfValidationError('note path exceeds maximum depth of 8 segments')
  }

  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new OkfValidationError(`directory traversal not allowed: ${seg}`)
    }
    if (seg.startsWith('.')) {
      throw new OkfValidationError(`hidden path segments not allowed: ${seg}`)
    }
    if (!isSlug(seg)) {
      throw new OkfValidationError(`invalid path segment: ${seg}`)
    }
  }

  const fullPath = segments.join('/')
  const baseName = segments[segments.length - 1]!
  const directory = segments.slice(0, -1).join('/')
  const isRootBundleFile = segments.length === 1
  const type = segments[0]!
  const name = segments.length === 1 ? segments[0]! : segments.slice(1).join('/')

  const ancestorDirectories: string[] = []
  for (let i = segments.length - 1; i >= 1; i--) {
    ancestorDirectories.push(segments.slice(0, i).join('/'))
  }

  return {
    fullPath,
    directory,
    baseName,
    segments,
    type,
    name,
    isRootBundleFile,
    ancestorDirectories,
  }
}

export function splitPath(path: string): { type: string; name: string } {
  const resolved = resolveNotePath(path)
  return { type: resolved.type, name: resolved.name }
}
