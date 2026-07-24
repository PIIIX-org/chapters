import { useEffect, useRef } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { useNote } from '../../hooks/useNote.js'
import { useUpdateNote } from '../../hooks/useUpdateNote.js'
import { useCodeMirrorEditor } from '../../hooks/useCodeMirrorEditor.js'
import type { Vault } from '../../api/vaults.js'

const SAVE_DEBOUNCE_MS = 1200

export function NoteView() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const path = useParams()['*']
  const vault = useOutletContext<Vault | undefined>()
  const note = useNote(vaultId!, path!)

  if (note.isPending) return null
  if (note.isError) return <div className="p-8 text-muted-foreground">Note not found.</div>

  return (
    <NoteEditor
      // Remount key is the full note identity (vault + path), not just path:
      // if NoteView ever stays mounted across a cross-vault switch to the same
      // path (e.g. a future cross-vault wikilink), keying on path alone would
      // reuse the stale editor and PUT one vault's body into another's note.
      key={`${vaultId}/${path}`}
      vaultId={vaultId!}
      path={path!}
      vaultName={vault?.name}
      frontmatter={note.data!.frontmatter}
      initialBody={note.data!.body}
    />
  )
}

interface NoteEditorProps {
  vaultId: string
  path: string
  vaultName: string | undefined
  frontmatter: Record<string, unknown>
  initialBody: string
}

function NoteEditor({ vaultId, path, vaultName, frontmatter, initialBody }: NoteEditorProps) {
  const updateNote = useUpdateNote(vaultId, path)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function handleChange(newBody: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      updateNote.mutate({ body: newBody })
    }, SAVE_DEBOUNCE_MS)
  }

  const editorRef = useCodeMirrorEditor({ doc: initialBody, onChange: handleChange })

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 py-4 text-sm text-muted-foreground">
        {vaultName ?? vaultId} / <span className="text-foreground">{path}</span>
      </div>
      <div className="border-b border-border px-8 py-4">
        <dl className="flex flex-col gap-1 text-sm">
          {Object.entries(frontmatter).map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="font-medium text-muted-foreground">{key}:</dt>
              <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div ref={editorRef} className="flex-1 overflow-auto" />
    </div>
  )
}
