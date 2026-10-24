// Attachments: upload through the UI's REST route (POST /api/vaults/:id/assets,
// multipart `file`, client/src/api/assets.ts), link them the way the editor
// does (client/src/hooks/imageDecorations.ts:141), then:
//   - bytes/headers on download, listing
//   - is text inside a PDF searchable (hybrid search, MCP search, SQL)?
//   - permissions: non-member, unauthenticated, read share, revoked share,
//     cross-vault fetch, traversal names, read-only upload
//   - lifecycle: soft delete, purge of the linking note, vault purge — is the
//     asset file cleaned up (SQL/disk ground truth)?
//   - agent reach: can an MCP agent read an attachment at all?
import type { Check, LabTest } from '../lib/context.ts'
import { getRaw, makePdf, makePng, poll, postFile, sha256 } from '../lib/portability.ts'

const PDF_TOKEN = 'quokkazanzibar7731'

const test: LabTest = {
  name: 'attachments',
  description: 'Upload PNG/PDF via REST, link from a note, PDF text search, delete/purge cleanup, permissions for non-members.',
  async run(ctx) {
    const checks: Check[] = []
    const admin = ctx.rest('admin')
    const member = ctx.rest('member')
    const mcp = ctx.mcp('adminAccount')
    const base = ctx.baseUrl
    const vault = await ctx.createVault('admin', ctx.uniq('att'))
    const V = vault.id
    const dataDir = `/data/elara/vaults/${V}/assets`
    const lsAssets = async (dir = dataDir) =>
      (await ctx.docker.appExec(['sh', '-c', `ls -1 ${dir} 2>/dev/null; true`])).stdout
        .split('\n')
        .filter(Boolean)

    const png = makePng(32, 32, 3)
    const pdf = makePdf(`Quarterly invoice ${PDF_TOKEN} for the Elara lab`)
    const upPng = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, 'diagram.png', png, 'image/png')
    const upPdf = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, 'invoice.pdf', pdf, 'application/pdf')
    // Shape: server/src/notes/routes.ts:314-320.
    type Uploaded = { fileName: string; url: string; size: number; mimeType: string }
    const pngMeta = upPng.json as Uploaded | undefined
    const pdfMeta = upPdf.json as Uploaded | undefined
    checks.push({
      name: 'upload PNG + PDF (multipart, UI route)',
      expected: '200/200 with sizes',
      actual: `${upPng.status} ${pngMeta?.size}/${png.length}, ${upPdf.status} ${pdfMeta?.size}/${pdf.length}`,
      ok: upPng.status === 200 && upPdf.status === 200 && pngMeta?.size === png.length && pdfMeta?.size === pdf.length,
      severity: 'high',
    })
    if (!pngMeta || !pdfMeta) throw new Error(`upload failed: ${upPng.text.slice(0, 200)} / ${upPdf.text.slice(0, 200)}`)

    const notePath = 'concepts/with-attachments'
    const body = [
      '# Attachments',
      `![diagram.png](/api/vaults/${V}/assets/${encodeURIComponent(pngMeta.fileName)})`,
      `[invoice.pdf](/api/vaults/${V}/assets/${encodeURIComponent(pdfMeta.fileName)})`,
      '',
    ].join('\n')
    const created = await mcp.call('create_note', { vaultId: V, path: notePath, frontmatter: { type: 'concepts', title: 'Attachments' }, body })
    checks.push({ name: 'note linking both attachments created', expected: 'ok', actual: created.ok ? 'ok' : created.text.slice(0, 120), ok: created.ok, severity: 'high' })

    const dlPng = await getRaw(base, pngMeta.url, admin.cookie)
    const dlPdf = await getRaw(base, pdfMeta.url, admin.cookie)
    checks.push({
      name: 'download is byte-identical with the right content type',
      expected: 'sha256 equal; image/png, application/pdf',
      actual: `${dlPng.status} ${dlPng.headers['content-type']} ${sha256(dlPng.bytes) === sha256(png)}; ${dlPdf.status} ${dlPdf.headers['content-type']} ${sha256(dlPdf.bytes) === sha256(pdf)}`,
      ok:
        sha256(dlPng.bytes) === sha256(png) &&
        sha256(dlPdf.bytes) === sha256(pdf) &&
        dlPng.headers['content-type'] === 'image/png' &&
        dlPdf.headers['content-type'] === 'application/pdf',
      severity: 'high',
    })
    checks.push({
      name: 'private attachment not marked publicly cacheable',
      expected: 'Cache-Control private/no-store (content is access-controlled)',
      actual: dlPdf.headers['cache-control'] ?? '(none)',
      ok: !/public/.test(dlPdf.headers['cache-control'] ?? ''),
      severity: 'low',
      detail: { code: 'server/src/notes/routes.ts:337 cache-control: public, max-age=86400, immutable' },
    })

    // ------------------------------------------------- PDF text search
    await poll(async () => {
      const rows = await ctx.docker.psqlRows<{ e: boolean }>(`select exists (select 1 from blocks b where b.owner_type = 'note' and b.owner_id = n.id and b.owner_version = n.seq::text and b.embedding is not null) as e from notes n where n.vault_id = '${V}' and n.path = '${notePath}'`)
      return rows[0]?.e ? true : undefined
    }, 600_000, 2_000)
    type Hit = { path: string; snippet: string; score: number }
    const restSearch = await admin.get<Hit[]>(`/api/vaults/${V}/search?q=${PDF_TOKEN}`)
    const mcpSearch = await mcp.call('search', { vaultId: V, query: PDF_TOKEN })
    const nonsense = await admin.get<Hit[]>(`/api/vaults/${V}/search?q=xqzvbnmplokij`)
    const controlSearch = await admin.get<Hit[]>(`/api/vaults/${V}/search?q=Attachments`)
    // Ground truth: the keyword retriever's own predicate (search/search.ts:108).
    const ftsHits = Number(await ctx.docker.psql(`select count(*) from notes where vault_id = '${V}' and fts @@ websearch_to_tsquery('english', '${PDF_TOKEN}')`))
    const assetTables = await ctx.docker.psql(
      `select coalesce(string_agg(table_name, ','), '') from information_schema.tables where table_schema = 'public' and table_name ilike any (array['%asset%','%attachment%','%file_text%'])`,
    )
    const restHits = Array.isArray(restSearch.json) ? restSearch.json : []
    const mcpHits = (Array.isArray(mcpSearch.json) ? mcpSearch.json : []) as Hit[]
    const tokenInSnippet = [...restHits, ...mcpHits].some((h) => h.snippet.includes(PDF_TOKEN))
    checks.push({
      name: 'text inside an uploaded PDF is searchable',
      expected: `"${PDF_TOKEN}" (only inside the PDF) matched by the keyword index or shown in a snippet`,
      actual: `FTS matches ${ftsHits}; REST ${restHits.length} result(s) [${restHits.map((h) => `${h.path} score ${h.score.toFixed(4)}`).join(', ')}] — vector-only rank (1/61); token in snippet: ${tokenInSnippet}; asset tables: ${assetTables || 'none'}`,
      ok: ftsHits > 0 || tokenInSnippet,
      severity: 'medium',
      detail: { restSearch: restSearch.json, mcpSearch: mcpSearch.text.slice(0, 500), code: 'notes/routes.ts:306-322 saves bytes to disk only; nothing extracts or indexes asset text' },
    })
    const nonsenseHits = Array.isArray(nonsense.json) ? nonsense.json : []
    checks.push({
      name: 'a query matching nothing returns no results',
      expected: '0 results for "xqzvbnmplokij"',
      actual: `${nonsenseHits.length} result(s): ${nonsenseHits.map((h) => `${h.path} score ${h.score.toFixed(4)}`).join(', ')}`,
      ok: nonsenseHits.length === 0,
      severity: 'low',
      detail: { code: 'search/search.ts:118-127 vector KNN has no similarity floor; RRF (294-316) ranks whatever it returns' },
    })
    checks.push({
      name: 'control: the linking note itself is searchable',
      expected: '>= 1 hit for "Attachments"',
      actual: String(Array.isArray(controlSearch.json) ? controlSearch.json.length : controlSearch.status),
      ok: Array.isArray(controlSearch.json) && controlSearch.json.length > 0,
      severity: 'info',
    })
    const tools = await mcp.listTools()
    const assetTools = tools.map((t) => t.name).filter((n) => /asset|attach|file|upload/i.test(n))
    checks.push({
      name: 'an MCP agent can read or list attachments',
      expected: 'some MCP tool returns asset bytes/metadata',
      actual: `asset-like tools: ${assetTools.join(', ') || 'none'} (read_file is repository code)`,
      ok: assetTools.some((n) => /asset|attach|upload/i.test(n)),
      severity: 'low',
    })

    // ------------------------------------------------------ permissions
    const memberNoShare = await getRaw(base, pdfMeta.url, member.cookie)
    const memberList = await getRaw(base, `/api/vaults/${V}/assets`, member.cookie)
    const anon = await getRaw(base, pdfMeta.url)
    const memberUpload = await postFile(base, `/api/vaults/${V}/assets`, member.cookie, 'evil.png', makePng(2, 2, 5), 'image/png')
    checks.push({
      name: 'non-member cannot download, list or upload',
      expected: '404/404/404 (or 403)',
      actual: `download ${memberNoShare.status}, list ${memberList.status}, upload ${memberUpload.status}`,
      ok: [memberNoShare, memberList, memberUpload].every((r) => r.status === 404 || r.status === 403),
      severity: 'critical',
    })
    checks.push({ name: 'unauthenticated download refused', expected: '401', actual: String(anon.status), ok: anon.status === 401, severity: 'critical' })

    const memberVault = await ctx.createVault('member', ctx.uniq('att-member'))
    const crossVault = await getRaw(base, `/api/vaults/${memberVault.id}/assets/${encodeURIComponent(pdfMeta.fileName)}`, member.cookie)
    checks.push({
      name: "admin's asset not reachable through the member's own vault id",
      expected: '404',
      actual: String(crossVault.status),
      ok: crossVault.status === 404,
      severity: 'critical',
    })
    const traversal: Record<string, number> = {}
    for (const name of ['..%2F..%2F..%2Fetc%2Fpasswd', '%2e%2e', `..%2F${memberVault.id}%2Fassets%2F${pdfMeta.fileName}`, `${encodeURIComponent(pdfMeta.fileName)}%00.png`]) {
      traversal[name] = (await getRaw(base, `/api/vaults/${memberVault.id}/assets/${name}`, member.cookie)).status
    }
    checks.push({
      name: 'traversal-style asset names refused',
      expected: 'all 4xx',
      actual: JSON.stringify(traversal),
      ok: Object.values(traversal).every((s) => s >= 400 && s < 500),
      severity: 'high',
    })

    const share = await mcp.call('share_vault', { vaultId: V, granteeType: 'user', granteeId: ctx.env.users.member.id, permission: 'read' })
    // Shape: share_vault returns the vault_shares row (mcp/server.ts:586).
    const shareRow = share.json as { id?: string } | undefined
    const memberRead = await getRaw(base, pdfMeta.url, member.cookie)
    const memberReadUpload = await postFile(base, `/api/vaults/${V}/assets`, member.cookie, 'evil.png', makePng(2, 2, 6), 'image/png')
    checks.push({
      name: 'read share: member downloads, cannot upload',
      expected: 'download 200, upload 403/404',
      actual: `download ${memberRead.status}, upload ${memberReadUpload.status}`,
      ok: memberRead.status === 200 && (memberReadUpload.status === 403 || memberReadUpload.status === 404),
      severity: 'high',
    })
    const revoke = shareRow?.id ? await mcp.call('revoke_vault_share', { vaultId: V, shareId: shareRow.id }) : undefined
    const afterRevoke = await getRaw(base, pdfMeta.url, member.cookie)
    checks.push({
      name: 'revoked share: download refused again',
      expected: '404',
      actual: `revoke ${revoke?.ok}, download ${afterRevoke.status}`,
      ok: afterRevoke.status === 404 || afterRevoke.status === 403,
      severity: 'critical',
    })

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>')
    const html = new TextEncoder().encode('<html><body><script>alert(1)</script></body></html>')
    const upSvg = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, 'x.svg', svg, 'image/svg+xml')
    const upHtml = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, 'x.html', html, 'text/html')
    const svgGet = upSvg.json ? await getRaw(base, (upSvg.json as Uploaded).url, admin.cookie) : undefined
    const htmlGet = upHtml.json ? await getRaw(base, (upHtml.json as Uploaded).url, admin.cookie) : undefined
    checks.push({
      name: 'active content (SVG/HTML) served inert',
      expected: 'SVG: CSP sandbox + attachment; HTML: not text/html; nosniff',
      actual: `svg ${svgGet?.headers['content-type']} csp=${svgGet?.headers['content-security-policy']} cd=${svgGet?.headers['content-disposition']}; html ${htmlGet?.headers['content-type']} nosniff=${htmlGet?.headers['x-content-type-options']}`,
      ok:
        /sandbox/.test(svgGet?.headers['content-security-policy'] ?? '') &&
        /attachment/.test(svgGet?.headers['content-disposition'] ?? '') &&
        !/text\/html/.test(htmlGet?.headers['content-type'] ?? 'text/html') &&
        htmlGet?.headers['x-content-type-options'] === 'nosniff',
      severity: 'high',
    })
    // No expectation either way: both answers are kept in data.uploads (empty, dup).
    const empty = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, 'empty.png', new Uint8Array(0), 'image/png')
    const dup = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, 'diagram.png', png, 'image/png')

    // -------------------------------------------------------- lifecycle
    const before = await lsAssets()
    const softDel = await mcp.call('delete_note', { vaultId: V, path: notePath })
    const afterSoft = await getRaw(base, pdfMeta.url, admin.cookie)
    checks.push({
      name: 'soft-deleted note: attachment still available (note is restorable)',
      expected: '200',
      actual: `delete ${softDel.ok}, download ${afterSoft.status}`,
      ok: afterSoft.status === 200,
      severity: 'medium',
    })
    // Shape: delete_note returns { status, id } (mcp/server.ts:740).
    const noteId = (softDel.json as { id?: string } | undefined)?.id
    const purge = noteId ? await mcp.call('purge_note', { vaultId: V, noteId }) : undefined
    const afterPurge = await getRaw(base, pdfMeta.url, admin.cookie)
    const afterPurgeDisk = await lsAssets()
    const refs = await ctx.docker.psql(`select count(*) from notes where vault_id = '${V}' and body like '%${pdfMeta.fileName}%'`)
    checks.push({
      name: 'purged note: its now-unreferenced attachments are cleaned up',
      expected: 'PDF/PNG removed (404, not on disk)',
      actual: `purge ${purge?.ok}; download ${afterPurge.status}; files on disk ${afterPurgeDisk.length} (before ${before.length}); notes still referencing: ${refs}`,
      ok: afterPurge.status === 404 && !afterPurgeDisk.includes(pdfMeta.fileName),
      severity: 'medium',
      detail: { before, afterPurgeDisk, code: 'store.ts:1027-1041 purgeNote never touches assets/; there is no asset delete function' },
    })
    const del = await admin.request('DELETE', `/api/vaults/${V}/assets/${pdfMeta.fileName}`)
    checks.push({
      name: 'an attachment can be deleted at all (REST)',
      expected: '2xx on DELETE /api/vaults/:id/assets/:file',
      actual: `${del.status} ${del.text.slice(0, 80)}`,
      ok: del.status >= 200 && del.status < 300,
      severity: 'medium',
    })

    const delVault = await mcp.call('delete_vault', { vaultId: V })
    const purgeVault = await mcp.call('purge_vault', { vaultId: V })
    const afterVaultPurge = await lsAssets()
    const vaultDirLeft = await lsAssets(`/data/elara/vaults/${V}`)
    checks.push({
      name: 'purged vault: attachment files removed from disk',
      expected: '0 files left',
      actual: `delete ${delVault.ok}, purge ${purgeVault.ok ? 'ok' : purgeVault.text.slice(0, 80)}; assets left ${afterVaultPurge.length}, vault dir entries ${vaultDirLeft.length}`,
      ok: purgeVault.ok && afterVaultPurge.length === 0,
      severity: 'medium',
    })

    const failed = checks.filter((c) => c.ok === false)
    return {
      summary: `Uploaded PNG ${png.length} B + PDF ${pdf.length} B to ${V}. PDF-only token: FTS matches ${ftsHits}, token in any snippet ${tokenInSnippet} (REST returned ${restHits.length} vector-only result(s); a nonsense query returned ${nonsenseHits.length}). Non-member download ${memberNoShare.status}, anon ${anon.status}. After purging the linking note the PDF answers ${afterPurge.status} and ${afterPurgeDisk.length} files remain. ${failed.length} failed checks.`,
      checks,
      data: {
        vaultId: V,
        uploads: { png: pngMeta, pdf: pdfMeta, svg: upSvg.json, html: upHtml.json, empty: empty.json, dup: dup.json },
        headers: { png: dlPng.headers, pdf: dlPdf.headers, svg: svgGet?.headers, html: htmlGet?.headers },
        search: { rest: restSearch.json, mcp: mcpSearch.json ?? mcpSearch.text, nonsense: nonsense.json, control: controlSearch.json, ftsHits },
        disk: { before, afterPurgeDisk, afterVaultPurge, vaultDirLeft },
        traversal,
        mcpAssetTools: assetTools,
      },
    }
  },
}
export default test
