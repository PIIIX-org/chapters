// Decides what a wikilink click does: navigate to an existing note, or (for an
// edit-capable user) create a missing `type/name` note then navigate.
// Supports note targets and AST code links ([[repo:name/file.ts#symbol]]).
export function handleWikilinkClick(
  target: string,
  vaultId: string,
  existingTargets: string[],
  canCreate: boolean,
  navigate: (to: string) => void,
  create: (input: { type: string; name: string }, onSettled: () => void) => void,
  repositories?: { id: string; name: string }[],
): void {
  // Code repository link: [[repo:repoIdOrName/path#symbol]] or [[code:...]]
  if (target.startsWith('repo:') || target.startsWith('code:')) {
    const withoutPrefix = target.startsWith('repo:')
      ? target.slice('repo:'.length)
      : target.slice('code:'.length)

    const [fileAndRepo = '', hash] = withoutPrefix.split('#')
    const anchor = hash ? `#${hash}` : ''

    let repoKey = ''
    let filePath = ''

    const colonIdx = fileAndRepo.indexOf(':')
    if (colonIdx !== -1) {
      repoKey = fileAndRepo.slice(0, colonIdx)
      filePath = fileAndRepo.slice(colonIdx + 1)
    } else {
      const slashIdx = fileAndRepo.indexOf('/')
      if (slashIdx !== -1) {
        repoKey = fileAndRepo.slice(0, slashIdx)
        filePath = fileAndRepo.slice(slashIdx + 1)
      } else {
        repoKey = fileAndRepo
        filePath = ''
      }
    }

    let repoId = repoKey
    if (repositories && repositories.length > 0) {
      const match = repositories.find(
        (r) => r.id === repoKey || r.name.toLowerCase() === repoKey.toLowerCase(),
      )
      if (match) {
        repoId = match.id
      }
    }

    const dest = filePath
      ? `/repos/${repoId}/files/${filePath}${anchor}`
      : `/repos/${repoId}/files${anchor}`
    navigate(dest)
    return
  }

  const [noteTarget = '', anchor] = target.split('#')
  const to = `/vaults/${vaultId}/notes/${noteTarget}${anchor ? `#${anchor}` : ''}`
  if (!canCreate || existingTargets.includes(noteTarget)) {
    navigate(to)
    return
  }
  const slash = noteTarget.indexOf('/')
  if (slash <= 0 || slash >= noteTarget.length - 1) {
    navigate(to) // no parseable type/name — can't create; navigate (not-found)
    return
  }
  create({ type: noteTarget.slice(0, slash), name: noteTarget.slice(slash + 1) }, () => navigate(to))
}
