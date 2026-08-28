import { ACCOUNT_EXPORT_URL } from '../../api/account.js'

export function AccountExport() {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-lg text-foreground">Export your account</h2>
      <p className="text-sm text-muted-foreground">
        Downloads every vault you own as a single zip: notes and frontmatter exactly as stored, plus
        a manifest of each vault&rsquo;s name, whether it is mergeable, and who it is shared with.
      </p>
      <p className="text-sm text-muted-foreground">
        Vaults that are only shared with you are not included — they belong to whoever owns them, and
        their owner exports them. The file contains your notes in plain text, so treat it the way you
        would treat the notes themselves.
      </p>
      {/* A zip, not JSON: a plain same-origin link carries the session cookie
          and streams straight to disk, where apiFetch would try to parse it. */}
      <a
        href={ACCOUNT_EXPORT_URL}
        download
        className="w-fit rounded-lg bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/80"
      >
        Download my vaults
      </a>
    </section>
  )
}
