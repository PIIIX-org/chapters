import { describe, expect, it } from 'vitest'
import { OVERLAY_MAX_FILES, OverlayError, applyHunks, parseOverlay } from '../src/repositories/overlay.js'

// #676: the unified diff the overlay takes, parsed and applied in memory with every context line checked.

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 export function one(): number {
-  return 1
+  return 11
 }
+export function added(): number { return 2 }
 export function two(): number {
`

describe('parseOverlay and applyHunks', () => {
  it('reads a modified file and applies its hunks to the base', () => {
    const [patch] = parseOverlay(MODIFIED)
    expect(patch).toMatchObject({ path: 'src/a.ts', status: 'modified' })
    const base = 'export function one(): number {\n  return 1\n}\nexport function two(): number {\n  return 2\n}\n'
    expect(applyHunks('src/a.ts', base, patch!.hunks)).toBe(
      'export function one(): number {\n  return 11\n}\nexport function added(): number { return 2 }\nexport function two(): number {\n  return 2\n}\n',
    )
  })

  it('reads an added and a deleted file', () => {
    const patches = parseOverlay(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const a = 1
+export const b = 2
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = 1
`)
    expect(patches.map((p) => [p.path, p.status])).toEqual([['new.ts', 'added'], ['old.ts', 'deleted']])
    expect(applyHunks('new.ts', '', patches[0]!.hunks)).toBe('export const a = 1\nexport const b = 2\n')
  })

  it('refuses a hunk whose context is not the indexed content, naming the file', () => {
    const [patch] = parseOverlay(MODIFIED)
    expect(() => applyHunks('src/a.ts', 'export function other(): number {\n  return 1\n}\n', patch!.hunks)).toThrow(/does not apply to src\/a.ts at line 1/)
  })

  it('refuses renames, binary changes, an empty diff, a repeated file, too many files and too large a diff', () => {
    expect(() => parseOverlay('diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n')).toThrow(/--no-renames/)
    expect(() => parseOverlay('diff --git a/x b/x\nBinary files a/x and b/x differ\n')).toThrow(/binary/)
    expect(() => parseOverlay('not a diff')).toThrow(OverlayError)
    expect(() => parseOverlay(MODIFIED + MODIFIED)).toThrow(/twice/)
    const many = Array.from({ length: OVERLAY_MAX_FILES + 1 }, (_, i) => `--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n`).join('')
    expect(() => parseOverlay(many)).toThrow(/more than 50 files/)
    expect(() => parseOverlay('x'.repeat(200_001))).toThrow(/200 KB/)
  })

  it("decodes git's quoted paths: octal bytes of a non-ASCII name, escaped quotes and tabs", () => {
    const patches = parseOverlay('--- "a/src/caf\\303\\251.ts"\n+++ "b/src/caf\\303\\251.ts"\n@@ -1,1 +1,1 @@\n-a\n+b\n--- "a/src/say \\"hi\\".ts"\n+++ "b/src/say \\"hi\\".ts"\n@@ -1,1 +1,1 @@\n-a\n+b\n')
    expect(patches.map((p) => p.path)).toEqual(['src/café.ts', 'src/say "hi".ts'])
    expect(parseOverlay('diff --git "a/\\346\\227\\245.ts" "b/\\346\\227\\245.ts"\n--- /dev/null\n+++ "b/\\346\\227\\245.ts"\n@@ -0,0 +1,1 @@\n+x\n')[0]).toMatchObject({ path: '日.ts', status: 'added' })
    expect(() => parseOverlay('--- "a/bad\\q.ts"\n+++ "b/bad\\q.ts"\n@@ -1,1 +1,1 @@\n-a\n+b\n')).toThrow(/quoted path/)
  })

  it('preserves final-newline bytes and rejects malformed counts and positions', () => {
    const diff = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-last\n\\ No newline at end of file\n+next\n\\ No newline at end of file\n'
    const [patch] = parseOverlay(diff)
    expect(applyHunks('a.txt', 'one\nlast', patch!.hunks)).toBe('one\nnext')
    expect(() => applyHunks('a.txt', 'one\nlast\n', patch!.hunks)).toThrow(/newline/)
    expect(() => parseOverlay(diff.replace('+1,2', '+1,3'))).toThrow(/counts/)
    const [shifted] = parseOverlay(diff.replace('+1,2', '+3,2'))
    expect(() => applyHunks('a.txt', 'one\nlast', shifted!.hunks)).toThrow(/position/)
  })

  it('never silently drops unsupported metadata or replaces invalid path/text bytes', () => {
    expect(() => parseOverlay(MODIFIED + 'diff --git a/mode.ts b/mode.ts\nold mode 100644\nnew mode 100755\n')).toThrow(/no supported text patch/)
    expect(() => parseOverlay('diff --git a/link b/link\nnew file mode 120000\n')).toThrow(/symlink/)
    expect(() => parseOverlay(MODIFIED + '\ud800')).toThrow(/UTF-8/)
    expect(() => parseOverlay('--- "a/\\377.ts"\n+++ "b/\\377.ts"\n@@ -1,1 +1,1 @@\n-a\n+b\n')).toThrow(/UTF-8/)
    expect(parseOverlay('--- "a/🙂.ts"\n+++ "b/🙂.ts"\n@@ -1,1 +1,1 @@\n-a\n+b\n')[0]!.path).toBe('🙂.ts')
  })
})
