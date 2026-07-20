import { useOutletContext, useParams } from 'react-router'
import { useNote } from '../../hooks/useNote.js'
import type { Vault } from '../../api/vaults.js'

export function NoteView() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const path = useParams()['*']
  const vault = useOutletContext<Vault | undefined>()
  const note = useNote(vaultId!, path!)

  if (note.isPending) return null
  if (note.isError) return <div className="p-8 text-muted-foreground">Note not found.</div>

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 py-4 text-sm text-muted-foreground">
        {vault?.name ?? vaultId} / <span className="text-foreground">{note.data!.path}</span>
      </div>
      <div className="border-b border-border px-8 py-4">
        <dl className="flex flex-col gap-1 text-sm">
          {Object.entries(note.data!.frontmatter).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="font-medium text-muted-foreground">{key}:</dt>
              <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap p-8 font-mono text-sm">{note.data!.body}</pre>
    </div>
  )
}
