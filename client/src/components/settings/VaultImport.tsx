import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { FormError } from '../FormError.js'
import { useImportVault } from '../../hooks/useImportVault.js'
import type { ImportResult } from '../../api/import.js'

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

/**
 * The counterpart to `AccountExport`. Import NEVER merges — `export/routes.ts`
 * inserts a new vault every time — so the copy says so before the file picker
 * rather than after, because the person this surprises is the one who expected
 * a merge and has already clicked by then.
 */
function ImportSummary({ result }: { result: ImportResult }) {
  const unmatched = result.unmatchedShares
  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <p className="text-sm text-foreground">
        {plural(result.imported, 'note')} imported, {plural(result.skipped.length, 'note')} skipped.
      </p>
      {/* `skipped` is a list of reasons, not a count — one
          "<path>: <why>" per note the OKF validator rejected. Those reasons
          are the only explanation that exists anywhere for why a note did not
          come through, so showing the number and dropping them would leave
          someone with a silently incomplete vault and no way to find out
          which notes or why. */}
      {result.skipped.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground">These notes were not imported:</p>
          <ul className="flex flex-col gap-0.5">
            {result.skipped.map((reason) => (
              <li key={reason} className="font-mono text-xs text-muted-foreground">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Not a footnote. The server re-grants a share only where the manifest's
          email already has an account here; everyone else is dropped and NOBODY
          is told — not them, not the owner. This list is the only notice that
          ever exists, so it sits at the same weight as the note count. */}
      {unmatched.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground">
            {unmatched.length} {unmatched.length === 1 ? 'person' : 'people'} listed in the archive
            got no access. They have no account on this instance, and nothing told them so:
          </p>
          <ul className="flex flex-col gap-0.5">
            {unmatched.map((email) => (
              <li key={email} className="font-mono text-xs text-muted-foreground">
                {email}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            Once they have an account here, share the new vault with them again.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Everyone the archive listed as a collaborator has an account here and got access again.
        </p>
      )}
      <Link to={`/vaults/${result.vaultId}`} className="w-fit underline">
        Open the new vault
      </Link>
    </div>
  )
}

export function VaultImport() {
  const [file, setFile] = useState<File | null>(null)
  const importVault = useImportVault()

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-lg text-foreground">Import a vault</h2>
      <p className="text-sm text-muted-foreground">
        Importing always creates a new vault that you own. It never merges into a vault you already
        have and never touches notes you already have — importing the same archive twice leaves you
        with two vaults.
      </p>
      <p className="text-sm text-muted-foreground">
        Collaborators named in the archive get access again only where their email already has an
        account on this instance. Anyone else is left out silently, so read the list below before you
        assume the vault came across whole.
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="vault-import-archive">Vault archive (.zip)</Label>
        <Input
          id="vault-import-archive"
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <Button
        type="button"
        className="w-fit"
        disabled={file === null || importVault.isPending}
        onClick={() => file !== null && importVault.mutate(file)}
      >
        {importVault.isPending ? 'Importing…' : 'Import as a new vault'}
      </Button>
      {/* isError before data, always: a failed import must never fall through
          to a summary rendering zeroes as if nothing had gone wrong. */}
      {importVault.isError ? (
        <FormError message={importVault.error.message} />
      ) : importVault.data ? (
        <ImportSummary result={importVault.data} />
      ) : null}
    </section>
  )
}
