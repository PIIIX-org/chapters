import { useState } from 'react'
import { useVaults } from '../../hooks/useVaults.js'
import { useShares } from '../../hooks/useShares.js'
import { Button } from '../ui/button.js'
import type { Share } from '../../api/shares.js'
import type { Vault } from '../../api/vaults.js'

// Union of every distinct person who can reach the vault right now, keyed by
// user id so someone reachable both directly and through a team counts once.
// +1 for the owner, who never appears as a share row.
function reachablePeopleCount(shares: Share[]): number {
  const ids = new Set<string>()
  for (const share of shares) {
    if (share.granteeType === 'user') ids.add(share.granteeId)
    else for (const member of share.members ?? []) ids.add(member.userId)
  }
  return ids.size + 1
}

function VaultReachList({ shares }: { shares: Share[] }) {
  if (shares.length === 0) {
    return <p className="px-2 py-1 text-sm text-muted-foreground">Only you can reach this vault.</p>
  }
  return (
    <>
      <p className="px-2 py-1 text-sm text-foreground">
        {reachablePeopleCount(shares)} people can reach this vault right now. Adding someone to a team it is shared
        with gives them access immediately — access is re-checked on every request.
      </p>
      <ul className="flex flex-col gap-1 px-2 pb-1">
        <li className="text-sm text-foreground">You — owner</li>
        {shares.map((share) =>
          share.granteeType === 'user' ? (
            <li key={share.id} className="text-sm text-foreground">
              {share.email ?? <span className="font-mono text-xs">{share.granteeId}</span>} — {share.permission}
            </li>
          ) : (
            (share.members ?? []).map((member) => (
              <li key={`${share.id}:${member.userId}`} className="text-sm text-foreground">
                {member.email} — {share.permission}
              </li>
            ))
          ),
        )}
      </ul>
    </>
  )
}

function VaultReachRow({ vault }: { vault: Vault }) {
  const [expanded, setExpanded] = useState(false)
  const sharesQuery = useShares(vault.id, expanded)

  return (
    <li className="border-b border-border py-1 last:border-b-0">
      <Button
        type="button"
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="h-auto w-full justify-start px-2 py-1.5 text-left"
      >
        Who can reach {vault.name}
      </Button>
      {expanded &&
        (sharesQuery.isError ? (
          <p role="alert" className="px-2 py-1 text-sm text-destructive">
            Could not load who can reach this vault. Try again.
          </p>
        ) : sharesQuery.isPending ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <VaultReachList shares={sharesQuery.data} />
        ))}
    </li>
  )
}

/**
 * Team-share transparency requirement (security hardening pass, structure
 * spec §4): a vault shared with a team is reachable by whoever is in that
 * team right now, which the sharing panel's share row doesn't say. One
 * disclosure per vault this viewer owns; `GET /vaults/:id/shares` is
 * owner-only, so non-owned vaults get nothing to expand.
 */
export function VaultReachExpansion() {
  const vaults = useVaults()

  if (vaults.isPending) return null

  if (vaults.isError) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="font-display text-base text-foreground">Who can reach your vaults</h2>
        <p role="alert" className="px-2 py-1 text-sm text-destructive">
          Could not load your vaults, so this can&rsquo;t show who can reach them. Try again.
        </p>
      </section>
    )
  }

  const owned = vaults.data.filter((v) => v.access === 'owner')
  if (owned.length === 0) return null

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-base text-foreground">Who can reach your vaults</h2>
      <ul className="flex flex-col">
        {owned.map((vault) => (
          <VaultReachRow key={vault.id} vault={vault} />
        ))}
      </ul>
    </section>
  )
}
