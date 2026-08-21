// Decides what a wikilink click does: navigate to an existing note, or (for an
// edit-capable user) create a missing `type/name` note then navigate.
export function handleWikilinkClick(
  target: string,
  vaultId: string,
  existingTargets: string[],
  canCreate: boolean,
  navigate: (to: string) => void,
  create: (input: { type: string; name: string }, onSettled: () => void) => void,
): void {
  const to = `/vaults/${vaultId}/notes/${target}`
  if (!canCreate || existingTargets.includes(target)) {
    navigate(to)
    return
  }
  const slash = target.indexOf('/')
  if (slash <= 0 || slash >= target.length - 1) {
    navigate(to) // no parseable type/name — can't create; navigate (not-found)
    return
  }
  create({ type: target.slice(0, slash), name: target.slice(slash + 1) }, () => navigate(to))
}
