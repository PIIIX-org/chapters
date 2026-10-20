import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Panel, PanelBody, PanelHeader } from '../ui/panel.js'
import { FormError } from '../FormError.js'
import { useImportVault } from '../../hooks/useImportVault.js'
import type { ImportResult, ShareOutcome, ShareSkipReason } from '../../api/import.js'

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

const SKIP_REASON: Record<ShareSkipReason, string> = {
  not_requested: 'not granted: sharing was left off',
  invalid_entry: 'not granted: the archive entry is malformed',
  invalid_permission: 'not granted: only read or edit can be granted',
  no_active_user: 'not granted: no active account with this email here',
  importer: 'not granted: that is you, and you own the new vault',
  no_team: 'not granted: no team with this name here',
  ambiguous_team: 'not granted: more than one team has this name',
  duplicate: 'not granted: listed more than once',
}

function ShareList({ shares }: { shares: ShareOutcome[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {shares.map((share, i) => (
        <li key={i} className="font-mono text-xs text-muted-foreground">
          {share.granteeType === 'team' ? `team ${share.grantee}` : share.grantee} ({share.permission})
          {share.reason ? ` — ${SKIP_REASON[share.reason]}` : ''}
        </li>
      ))}
    </ul>
  )
}

/**
 * The counterpart to `AccountExport`. Import NEVER merges — `export/routes.ts`
 * inserts a new vault every time — so the copy says so before the file picker
 * rather than after, because the person this surprises is the one who expected
 * a merge and has already clicked by then.
 */
function ImportSummary({ result }: { result: ImportResult }) {
  const { appliedShares, skippedShares } = result
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
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
      {/* Not a footnote. Who got access to the new vault, and who the archive
          named but did not get it, are both stated here: the archive alone never
          grants access (#621), and this list is the only notice the importer
          gets of who is still missing. */}
      {appliedShares.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground">
            {plural(appliedShares.length, 'collaborator')} from the archive got access to the new vault:
          </p>
          <ShareList shares={appliedShares} />
        </div>
      )}
      {skippedShares.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground">
            {plural(skippedShares.length, 'collaborator')} listed in the archive got no access:
          </p>
          <ShareList shares={skippedShares} />
          <p className="text-sm text-muted-foreground">
            Anyone who should still have access can be added from the new vault&apos;s Sharing panel.
          </p>
        </div>
      )}
      <Link to={`/vaults/${result.vaultId}`} className="w-fit text-primary underline underline-offset-4">
        Open the new vault
      </Link>
    </div>
  )
}

export function VaultImport() {
  const [file, setFile] = useState<File | null>(null)
  const [applyShares, setApplyShares] = useState(false)
  const importVault = useImportVault()

  return (
    <Panel>
      <PanelHeader title="Import a vault" />
      <PanelBody className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Importing always creates a new vault that you own. It never merges into a vault you already
          have and never touches notes you already have — importing the same archive twice leaves you
          with two vaults.
        </p>
        <p className="text-sm text-muted-foreground">
          The new vault is private to you unless you choose otherwise: an archive can list collaborators,
          and they get access only if you tick the box below.
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
        <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 min-h-[44px] touch-manipulation transition-colors duration-100 hover:bg-muted">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 accent-primary touch-manipulation"
            checked={applyShares}
            onChange={(e) => setApplyShares(e.target.checked)}
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm text-foreground">Give the archive&apos;s collaborators access again</span>
            <span className="text-xs text-muted-foreground">
              Only people with an active account here and teams that exist here, at the read or edit
              level the archive lists. Everyone else is left out and listed after the import.
            </span>
          </span>
        </label>
        <Button
          type="button"
          className="w-full sm:w-fit min-h-[36px] sm:min-h-0 touch-manipulation"
          disabled={file === null || importVault.isPending}
          onClick={() => file !== null && importVault.mutate({ file, applyShares })}
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
      </PanelBody>
    </Panel>
  )
}
