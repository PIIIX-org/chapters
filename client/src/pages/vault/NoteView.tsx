import { useEffect, useRef } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { useNote } from '../../hooks/useNote.js'
import { useUpdateNote } from '../../hooks/useUpdateNote.js'
import { useCodeMirrorEditor } from '../../hooks/useCodeMirrorEditor.js'
import { canEdit } from '../../api/vaults.js'
import type { Vault } from '../../api/vaults.js'

const SAVE_DEBOUNCE_MS = 1200

export function NoteView() {
  const { vaultId } = useParams<{ vaultId: string }>()
  const path = useParams()['*']
  const vault = useOutletContext<Vault | undefined>()
  const note = useNote(vaultId!, path!)

  if (note.isPending) return null
  if (note.isError) return <div className="p-8 text-muted-foreground">Note not found.</div>

  // Conservative default: unknown access (vault undefined) => read-only.
  const readOnly = !canEdit(vault?.access)

  return (
    <NoteEditor
      // Remount key is the full note identity (vault + path) plus the edit
      // capability: keying on path alone would reuse a stale editor across a
      // cross-vault switch to the same path, and would also miss a change in
      // the user's access to this note (e.g. a live share revocation).
      key={`${vaultId}/${path}/${readOnly}`}
      vaultId={vaultId!}
      path={path!}
      vaultName={vault?.name}
      frontmatter={note.data!.frontmatter}
      initialBody={note.data!.body}
      readOnly={readOnly}
    />
  )
}

interface NoteEditorProps {
  vaultId: string
  path: string
  vaultName: string | undefined
  frontmatter: Record<string, unknown>
  initialBody: string
  readOnly: boolean
}

function NoteEditor({ vaultId, path, vaultName, frontmatter, initialBody, readOnly }: NoteEditorProps) {
  const updateNote = useUpdateNote(vaultId, path)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function handleChange(newBody: string) {
    // Belt-and-suspenders: the editor is non-editable when readOnly, so this
    // shouldn't fire from user input — but never PUT an edit the server will
    // 404 anyway.
    if (readOnly) return
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      updateNote.mutate({ body: newBody })
    }, SAVE_DEBOUNCE_MS)
  }

  const editorRef = useCodeMirrorEditor({ doc: initialBody, onChange: handleChange, readOnly })

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-8 py-4 text-sm text-muted-foreground">
        {vaultName ?? vaultId} / <span className="text-foreground">{path}</span>
        {readOnly && <span className="ml-2 text-xs uppercase tracking-wide">· read-only</span>}
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
