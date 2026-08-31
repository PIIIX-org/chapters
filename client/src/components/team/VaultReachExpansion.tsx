import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useVaults } from '../../hooks/useVaults.js'
import { useShares } from '../../hooks/useShares.js'
import { Button } from '../ui/button.js'
import { Eyebrow } from '../ui/eyebrow.js'
import { Pill } from '../ui/pill.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js'
import { cn } from '../../lib/utils.js'
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

function ReachRow({ person, permission }: { person: React.ReactNode; permission: string }) {
  return (
    <TableRow>
      <TableCell className="h-8 min-w-0 max-w-40 truncate text-[13px] text-foreground">
        {person}
      </TableCell>
      <TableCell className="h-8">
        <Pill tone={permission === 'owner' ? 'human' : 'neutral'}>{permission}</Pill>
      </TableCell>
    </TableRow>
  )
}

function VaultReachList({ shares }: { shares: Share[] }) {
  if (shares.length === 0) {
    return (
      <p className="px-2 pb-2 text-xs text-muted-foreground">
        Only you can reach this vault.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1 pb-1">
      <p className="px-2 text-xs whitespace-normal text-muted-foreground">
        {reachablePeopleCount(shares)} people can reach this vault right now.
        Adding someone to a team it is shared with gives them access
        immediately — access is re-checked on every request.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="h-7">
              Person
            </TableHead>
            <TableHead scope="col" className="h-7">
              Access
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <ReachRow person="You" permission="owner" />
          {shares.map((share) =>
            share.granteeType === 'user' ? (
              <ReachRow
                key={share.id}
                person={share.email ?? <span className="font-mono text-xs">{share.granteeId}</span>}
                permission={share.permission}
              />
            ) : (
              (share.members ?? []).map((member) => (
                <ReachRow
                  key={`${share.id}:${member.userId}`}
                  person={member.email}
                  permission={share.permission}
                />
              ))
            ),
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function VaultReachRow({ vault }: { vault: Vault }) {
  const [expanded, setExpanded] = useState(false)
  const sharesQuery = useShares(vault.id, expanded)

  return (
    <li className="border-b border-border last:border-b-0">
      <Button
        type="button"
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        className="h-8 w-full justify-start gap-1 rounded-none px-2 text-[13px] font-normal"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('shrink-0 transition-transform duration-100', expanded && 'rotate-90')}
        />
        <span className="min-w-0 flex-1 truncate text-left">
          Who can reach {vault.name}
        </span>
      </Button>
      {expanded &&
        (sharesQuery.isError ? (
          <p role="alert" className="px-2 pb-2 text-xs text-destructive">
            Could not load who can reach this vault. Try again.
          </p>
        ) : sharesQuery.isPending ? (
          <p className="px-2 pb-2 text-xs text-muted-foreground">Loading…</p>
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
      <section aria-label="Vault reach" className="flex flex-col gap-2">
        <Eyebrow as="h3">Vault reach</Eyebrow>
        <p role="alert" className="text-xs text-destructive">
          Could not load your vaults, so this can&rsquo;t show who can reach
          them. Try again.
        </p>
      </section>
    )
  }

  const owned = vaults.data.filter((v) => v.access === 'owner')
  if (owned.length === 0) return null

  return (
    <section aria-label="Vault reach" className="flex flex-col gap-2">
      <Eyebrow as="h3">Vault reach</Eyebrow>
      <ul className="flex flex-col overflow-hidden rounded-md border border-border bg-card">
        {owned.map((vault) => (
          <VaultReachRow key={vault.id} vault={vault} />
        ))}
      </ul>
    </section>
  )
}
