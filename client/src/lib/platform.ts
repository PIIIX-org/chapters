/** macOS uses ⌘ for the palette; everything else uses Ctrl. Read once. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

export const MOD_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl'

/**
 * Keystrokes that land in something editable belong to it, not to the shell:
 * inputs, textareas, selects, contenteditable (CodeMirror), and ARIA text
 * roles the palette and pickers use.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (
    target.closest(
      '.cm-editor, [role="textbox"], [role="combobox"], [contenteditable="true"]',
    ) !== null
  )
}
