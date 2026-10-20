// Export -> import round trip, and whether the export is readable OKF.
//
// Fixture vault (admin): 8-level nested paths, a root bundle file, Persian +
// emoji + astral/combining/RTL text, every frontmatter family the OKF v0.2
// schema defines plus custom scalars (incl. YAML 1.1-ambiguous strings),
// wikilinks (plain/alias/anchor/broken/repo:/code:/in code), a rename with
// link refactoring, revisions (edit_note + revert_note), trash (incl. a
// path that was trashed and recreated), attachments uploaded through the
// UI's REST route and linked the way the editor links them, and a share.
//
// Exports: MCP export_vault, REST GET /api/vaults/:id/export, and a
// sessionless export link. Import: REST POST /api/import (the only import
// path), once per export. Diff against SQL ground truth + read_note.
// OKF: every exported file is read by (a) Bun's YAML 1.2 parser with a
// line-based fence split, (b) the pinned OKF reference parser
// (open-knowledge-format document.py, PyYAML), and validated against
// vendor/okf/schemas/concept.schema.json. Finally real OKF bundles
// (the spec repo's acme_retail sample) and crafted archives are imported.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Check, LabTest } from '../lib/context.ts'
import type { HistoryPage } from '../lib/mcp.ts'
import {
  assetRefs,
  assetSnapshot,
  bunYamlParse,
  canon,
  extractZip,
  firstByteDiff,
  getRaw,
  jsonDiff,
  loadOkfSchema,
  makePdf,
  makePng,
  noteSnapshot,
  okfReferenceParse,
  poll,
  postFile,
  readZip,
  sha256,
  splitFrontmatter,
  validateSchema,
  writeZip,
  type AssetInfo,
  type NoteRow,
  type ZipEntry,
} from '../lib/portability.ts'

const OKF_COMMIT = 'ad30107c31c06aec8a7d5636e0d1058118604e6f'
const ACME_FILES = [
  'index.md',
  'log.md',
  'attesters/index.md',
  'computations/index.md',
  'computations/gross-margin-period.md',
  'computations/revenue-ytd.md',
  'metrics/index.md',
  'metrics/gross-margin-legacy.md',
  'metrics/gross-margin.md',
  'metrics/revenue.md',
  'policies/index.md',
  'policies/margin-standard.md',
  'policies/revenue-recognition.md',
  'skills/index.md',
  'skills/run-on-bq.md',
  'tables/index.md',
  'tables/orders.md',
]

interface NoteSpec {
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

interface ReadNote {
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

interface ImportResult {
  vaultId: string
  imported: number
  skipped: string[]
  appliedShares: Array<{ granteeType: string; grantee: string; permission: string }>
  skippedShares: Array<{ granteeType: string; grantee: string; permission: string; reason?: string }>
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Frontmatter as the writer meant it: createNote adds `timestamp` when absent (store.ts:225-229). */
function withoutAutoTimestamp(intended: Record<string, unknown>, actual: Record<string, unknown>) {
  if ('timestamp' in intended) return actual
  const rest = { ...actual }
  delete rest.timestamp
  return rest
}

const test: LabTest = {
  name: 'export-roundtrip',
  description:
    'Vault with nesting/unicode/all frontmatter/links/attachments/revisions/trash -> MCP+REST export -> REST import; byte diff + OKF reference parser + schema.',
  async run(ctx) {
    const checks: Check[] = []
    const mcp = ctx.mcp('adminAccount')
    const admin = ctx.rest('admin')
    const member = ctx.rest('member')
    const base = ctx.baseUrl
    const src = await ctx.createVault('admin', ctx.uniq('rt-src'))
    const V = src.id
    ctx.log('source vault', V)

    // ---------------------------------------------------------- assets
    const assetFixtures = [
      { name: 'diagram.png', mime: 'image/png', bytes: makePng(16, 12, 7) },
      { name: 'invoice.pdf', mime: 'application/pdf', bytes: makePdf('Elara lab invoice quokkazanzibar7731') },
      { name: 'تصویر نمونه.png', mime: 'image/png', bytes: makePng(8, 8, 99) },
      { name: 'notes.txt', mime: 'text/plain', bytes: enc.encode('یادداشت متنی UTF-8 ✓\n') },
    ]
    const stored: Record<string, string> = {}
    for (const f of assetFixtures) {
      const r = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, f.name, f.bytes, f.mime)
      // Shape: server/src/notes/routes.ts:314-320.
      const body = r.json as { fileName?: string } | undefined
      if (r.status !== 200 || !body?.fileName) throw new Error(`upload ${f.name}: ${r.status} ${r.text.slice(0, 300)}`)
      stored[f.name] = body.fileName
    }
    const png = stored['diagram.png']!
    const pdf = stored['invoice.pdf']!
    checks.push({
      name: 'non-ASCII attachment name kept',
      expected: 'stored name still identifies "تصویر نمونه" (or the original name is recorded somewhere)',
      actual: stored['تصویر نمونه.png']!,
      ok: !/^attachment-\d+-/.test(stored['تصویر نمونه.png']!),
      severity: 'low',
      detail: { stored, code: 'server/src/notes/store.ts:1062-1072 sanitizeAssetFilename keeps only [a-z0-9-_]' },
    })

    // ----------------------------------------------------------- notes
    const intended: NoteSpec[] = []
    const deepSegs = ['concepts', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']
    for (let d = 2; d <= 8; d++) {
      intended.push({
        path: [...deepSegs.slice(0, d - 1), `deep-${d}`].join('/'),
        frontmatter: { type: 'concepts', title: `Depth ${d}` },
        body: `Note at depth ${d}.\n`,
      })
    }
    intended.push({ path: 'readme', frontmatter: { type: 'readme', title: 'Root bundle file' }, body: '# Root\n\nA one-segment path.\n' })
    const unicodeBody =
      [
        '# دانش‌نامه آزمایشی 🚀',
        '',
        'این یک یادداشت فارسی است با نیم‌فاصله و اعداد ۱۲۳۴۵۶۷۸۹۰.',
        'Arabic: مرحبا بالعالم — ي ك ة',
        'Emoji: 👨‍👩‍👧‍👦 🏳️‍🌈 👍🏽 🇮🇷',
        'Astral: 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𠜎',
        'Combining: e\u0301 vs é, RTL marks: \u200fسلام\u200e, NBSP:\u00a0end',
        'CJK: 漢字かなカナ 한국어',
        'Tab:\tafter tab, trailing spaces   ',
      ].join('\n') + '\r\nCRLF line\r\nlast line without newline'
    intended.push({
      path: 'concepts/unicode',
      frontmatter: {
        type: 'concepts',
        title: 'دانش‌نامه 🚀 آزمایشی',
        description: 'توضیح با نیم‌فاصله و ایموجی 🎉',
        tags: ['فارسی', 'emoji-🚀', 'ök'],
        'کلید': 'مقدار',
        rtl: '\u200fراست به چپ\u200e',
      },
      body: unicodeBody,
    })
    const allFm: Record<string, unknown> = {
      type: 'concepts',
      title: 'All frontmatter types',
      description: 'Every OKF v0.2 family plus custom scalars',
      resource: 'https://example.com/resource?id=1&x=y',
      tags: ['a', 'b c', 'ünï'],
      timestamp: '2026-01-02T03:04:05+03:30',
      stale_after: '2027-01-01T00:00:00Z',
      status: 'stable',
      generated: { by: 'human:lab', at: '2026-01-01T00:00:00Z', model: 'none' },
      sources: [
        {
          id: 's1',
          resource: 'repo:lab-pinned-repo/README.md',
          title: 'readme',
          hash: 'sha256:abc',
          last_modified: '2026-01-01T00:00:00.123Z',
          author: 'human:x',
          usage_count: 3,
          custom: 'kept',
        },
        { resource: 'https://example.com/doc' },
      ],
      verified: [
        { tier: 'human-reviewed', by: 'human:lab', at: '2026-01-01T00:00:00Z' },
        { tier: 'machine-confirmed', by: 'agent:ci' },
      ],
      usage_window: { from: '2026-01-01T00:00:00Z', to: '2026-12-31T23:59:59-05:00' },
      properties: { nested: { deep: [1, 'two', { three: 3 }] }, ratio: 1.5, flag: false },
      int: 42,
      float: 3.14159,
      negative: -7,
      zero: 0,
      big: 1e21,
      yes_bool: true,
      no_bool: false,
      nothing: null,
      list: [1, 'a', true, null],
      str_num: '007',
      str_bool: 'true',
      str_null: 'null',
      str_tilde: '~',
      yes_word: 'yes',
      no_word: 'no',
      on_word: 'on',
      country: 'NO',
      underscore_num: '1_000',
      sexagesimal: '1:20',
      date_only: '2026-01-01',
      multiline: 'line one\nline two\n',
      colon: 'key: value',
      hash: 'value # not a comment',
      lead: ' leading',
      trail: 'trailing ',
      empty: '',
      'key with space': 'v',
      'emoji🔑': '🔒',
      quote_mix: `it's "quoted"`,
      backslash: 'C:\\path\\to',
    }
    intended.push({ path: 'concepts/frontmatter-all', frontmatter: allFm, body: '# heading\n\nAll types.\n' })
    intended.push({
      path: 'concepts/verified-single',
      frontmatter: { type: 'concepts', verified: { tier: 'machine-confirmed', by: 'agent:ci', at: '2026-02-02T00:00:00Z' } },
      body: 'Bare verified mapping (OKF §5.2).\n',
    })
    intended.push({ path: 'concepts/old-name', frontmatter: { type: 'concepts', title: 'Will be renamed' }, body: 'rename me\n' })
    const linksBody = [
      '# Links',
      '- wikilink: [[concepts/unicode]]',
      '- alias: [[concepts/l2/l3/deep-4|Depth four]]',
      '- anchor: [[concepts/frontmatter-all#heading]]',
      '- broken: [[concepts/missing-target]]',
      '- renamed: [[concepts/old-name]]',
      '- repo: [[repo:lab-pinned-repo/README.md#intro]]',
      '- code: [[code:lab-pinned-repo/index.html]]',
      '- OKF markdown link: [unicode](/concepts/unicode.md)',
      `- image as the editor inserts it: ![diagram.png](/api/vaults/${V}/assets/${png})`,
      `- pdf as the editor inserts it: [invoice.pdf](/api/vaults/${V}/assets/${pdf})`,
      `- bundle-relative asset: ![rel](/assets/${png})`,
      '',
      '```ts',
      '[[concepts/in-code-block]]',
      '```',
      'inline `[[concepts/in-inline-code]]`',
      '<!-- [[concepts/in-comment]] -->',
      '',
    ].join('\n')
    intended.push({ path: 'concepts/links', frontmatter: { type: 'concepts', title: 'Links' }, body: linksBody })
    intended.push({ path: 'concepts/revised', frontmatter: { type: 'concepts', title: 'Revised' }, body: 'v1\n' })
    intended.push({ path: 'concepts/trashed-one', frontmatter: { type: 'concepts' }, body: 'goes to trash\n' })
    intended.push({ path: 'concepts/trashed-two', frontmatter: { type: 'concepts' }, body: 'first incarnation\n' })
    intended.push({
      path: 'concepts/triple-dash',
      frontmatter: { type: 'concepts', title: 'Q3 --- plan', description: 'before---after' },
      body: 'Body of the triple dash note.\n',
    })

    const createFailures: string[] = []
    for (const n of intended) {
      const r = await mcp.call('create_note', { vaultId: V, path: n.path, frontmatter: n.frontmatter, body: n.body })
      if (!r.ok) createFailures.push(`${n.path}: ${r.text.slice(0, 200)}`)
    }
    checks.push({
      name: 'fixture notes created (depth 2..8, root file, unicode, all frontmatter types)',
      expected: `${intended.length} created`,
      actual: `${intended.length - createFailures.length} created`,
      ok: createFailures.length === 0,
      severity: 'high',
      detail: createFailures,
    })
    const depth9 = await mcp.call('create_note', {
      vaultId: V,
      path: 'concepts/l2/l3/l4/l5/l6/l7/l8/deep-9',
      frontmatter: { type: 'concepts' },
      body: 'too deep',
    })
    checks.push({
      name: '9-segment path rejected (documented max depth 8)',
      expected: 'error',
      actual: depth9.ok ? 'created' : depth9.text.slice(0, 120),
      ok: !depth9.ok,
      severity: 'info',
    })
    const persianPath = await mcp.call('create_note', { vaultId: V, path: 'concepts/دانش', frontmatter: { type: 'concepts' }, body: 'x' })
    checks.push({
      name: 'Persian path segment',
      expected: 'documented limitation: slug-only segments (okf.ts:60) — rejected',
      actual: persianPath.ok ? 'created' : persianPath.text.slice(0, 120),
      ok: !persianPath.ok,
      severity: 'info',
    })
    // OKF v0.2 spec examples written verbatim (vendor/okf/SPEC.md §4.1, §5.2).
    const specVerified = await mcp.call('create_note', {
      vaultId: V,
      path: 'concepts/spec-verified',
      frontmatter: { type: 'concepts', verified: [{ by: 'human:ahormati', at: '2026-06-25T09:00:00Z' }, { by: 'process:finance-nightly', at: '2026-06-26T02:00:00Z' }] },
      body: 'SPEC §5.2 example\n',
    })
    if (specVerified.ok) await mcp.call('delete_note', { vaultId: V, path: 'concepts/spec-verified' })
    checks.push({
      name: 'OKF §5.2 `verified` exactly as the spec writes it ({by, at}, tier derived) is accepted',
      expected: 'created',
      actual: specVerified.ok ? 'created' : specVerified.text.slice(0, 160),
      ok: specVerified.ok,
      severity: 'medium',
      detail: { code: 'okf.ts:171 requires item.tier; vendor/okf/schemas/concept.schema.json:97 "required": ["tier"]; SPEC.md:383-407 has no tier field — consumers derive it' },
    })
    const freeType = await mcp.call('create_note', { vaultId: V, path: 'concepts/free-type', frontmatter: { type: 'BigQuery Table' }, body: 'x\n' })
    if (freeType.ok) await mcp.call('delete_note', { vaultId: V, path: 'concepts/free-type' })
    checks.push({
      name: 'OKF §4.1 free-text `type` ("BigQuery Table") is accepted',
      expected: 'created (types are not registered; consumers MUST tolerate unknown types)',
      actual: freeType.ok ? 'created' : freeType.text.slice(0, 160),
      ok: freeType.ok,
      severity: 'medium',
      detail: { code: 'okf.ts:79-88: type must be a slug equal to the first path segment' },
    })

    // rename (wikilink refactor), revisions, revert, trash
    const rename = await mcp.call('rename_note', { vaultId: V, from: 'concepts/old-name', toName: 'new-name' })
    for (const body of ['v2\n', 'v3\n']) await mcp.call('edit_note', { vaultId: V, path: 'concepts/revised', body })
    await mcp.call('edit_note', {
      vaultId: V,
      path: 'concepts/revised',
      frontmatter: { type: 'concepts', title: 'Revised title', status: 'draft' },
    })
    await mcp.call('edit_note', { vaultId: V, path: 'concepts/revised', body: 'v4 final\n' })
    // Collab writes record revisions asynchronously: wait for create + 4 edits.
    await poll(async () => {
      const page = await mcp.must<HistoryPage>('note_history', { vaultId: V, path: 'concepts/revised', limit: 100 }).catch(() => undefined)
      return page && page.revisions.length >= 5 ? true : undefined
    }, 20_000)
    // note_history is metadata only (#411): the bodies come from get_revision.
    const revs = await mcp.revisionsSince(V, 'concepts/revised')
    const v2 = revs.find((r) => r.body === 'v2\n')
    const revert = v2 ? await mcp.call('revert_note', { vaultId: V, path: 'concepts/revised', revisionId: v2.id }) : undefined
    await mcp.call('delete_note', { vaultId: V, path: 'concepts/trashed-one' })
    await mcp.call('delete_note', { vaultId: V, path: 'concepts/trashed-two' })
    await mcp.call('create_note', { vaultId: V, path: 'concepts/trashed-two', frontmatter: { type: 'concepts' }, body: 'second incarnation\n' })
    const share = await mcp.call('share_vault', { vaultId: V, granteeType: 'user', granteeId: ctx.env.users.member.id, permission: 'read' })
    await poll(async () => {
      const r = await mcp.call('read_note', { vaultId: V, path: 'concepts/revised' })
      return r.json && (r.json as ReadNote).body === 'v2\n' ? true : undefined
    }, 20_000)
    checks.push({
      name: 'fixture ops (rename, 4 edits, revert, trash, share)',
      expected: 'all ok',
      actual: JSON.stringify({ rename: rename.ok, revisions: revs.length, revert: revert?.ok ?? 'no v2 revision', share: share.ok }),
      ok: rename.ok && Boolean(revert?.ok) && share.ok,
      severity: 'high',
    })

    // ------------------------------------------ write fidelity (source)
    const finalIntended = new Map<string, NoteSpec>()
    for (const n of intended) if (n.path !== 'concepts/trashed-one') finalIntended.set(n.path, n)
    finalIntended.delete('concepts/old-name')
    finalIntended.set('concepts/new-name', { path: 'concepts/new-name', frontmatter: { type: 'concepts', title: 'Will be renamed' }, body: 'rename me\n' })
    finalIntended.set('concepts/links', {
      path: 'concepts/links',
      frontmatter: { type: 'concepts', title: 'Links' },
      body: linksBody.replace('[[concepts/old-name]]', '[[concepts/new-name]]'),
    })
    // revert_note restores the whole v2 revision (frontmatter as it was then + body).
    finalIntended.set('concepts/revised', { path: 'concepts/revised', frontmatter: { type: 'concepts', title: 'Revised' }, body: 'v2\n' })
    finalIntended.set('concepts/trashed-two', { path: 'concepts/trashed-two', frontmatter: { type: 'concepts' }, body: 'second incarnation\n' })

    const srcRead = new Map<string, ReadNote>()
    const fidelity: Array<Record<string, unknown>> = []
    for (const [path, want] of finalIntended) {
      const r = await mcp.call('read_note', { vaultId: V, path })
      // Shape: read_note returns { path, frontmatter, body } (mcp/server.ts:644).
      const got = r.json as ReadNote | undefined
      if (!r.ok || !got) {
        fidelity.push({ path, frontmatter: 'read failed', body: r.text.slice(0, 100) })
        continue
      }
      srcRead.set(path, got)
      const fmDiff = jsonDiff(want.frontmatter, withoutAutoTimestamp(want.frontmatter, got.frontmatter))
      const bodyAt = firstByteDiff(want.body, got.body)
      if (fmDiff.length || bodyAt >= 0) {
        fidelity.push({ path, frontmatterDiff: fmDiff, bodyFirstDiffByte: bodyAt, bodyGot: got.body.slice(0, 160) })
      }
    }
    const tripleDash = fidelity.find((f) => f.path === 'concepts/triple-dash')
    checks.push({
      name: 'write fidelity: read_note returns what was written (all fixture notes except triple-dash)',
      expected: '0 differences',
      actual: `${fidelity.filter((f) => f.path !== 'concepts/triple-dash').length} notes differ`,
      ok: fidelity.filter((f) => f.path !== 'concepts/triple-dash').length === 0,
      severity: 'high',
      detail: fidelity.filter((f) => f.path !== 'concepts/triple-dash'),
    })
    checks.push({
      name: 'frontmatter value containing "---" survives a save (title "Q3 --- plan")',
      expected: 'read_note frontmatter/body equal to what was written',
      actual: tripleDash ? JSON.stringify(tripleDash).slice(0, 280) : 'identical',
      ok: !tripleDash,
      severity: 'high',
      detail: { tripleDash, code: 'server/src/notes/okf.ts:231 /^---\\n([\\s\\S]*?)\\n?---\\n?([\\s\\S]*)$/ — `\\n?` lets the closing fence match mid-line' },
    })
    const linksRow = srcRead.get('concepts/links')
    checks.push({
      name: 'rename refactors [[concepts/old-name]] in other notes',
      expected: 'links note body contains [[concepts/new-name]]',
      actual: linksRow?.body.includes('[[concepts/new-name]]') ? 'refactored' : 'not refactored',
      ok: Boolean(linksRow?.body.includes('[[concepts/new-name]]')),
      severity: 'medium',
    })

    const srcRows = await noteSnapshot(null, [V])
    const srcLive = srcRows.filter((r) => !r.trashed)
    const srcTrash = srcRows.filter((r) => r.trashed)
    const srcAssets = await assetSnapshot(base, admin.cookie, V)
    const expectedLinks = [
      'code:lab-pinned-repo/index.html',
      'concepts/frontmatter-all',
      'concepts/l2/l3/deep-4',
      'concepts/missing-target',
      'concepts/new-name',
      'concepts/unicode',
      'repo:lab-pinned-repo/README.md',
    ]
    const srcLinks = srcLive.find((r) => r.path === 'concepts/links')?.links ?? []
    checks.push({
      name: 'wikilink edges extracted (plain, alias, anchor, broken, repo:, code:; none from code/comments)',
      expected: expectedLinks.join(', '),
      actual: srcLinks.join(', '),
      ok: canon(srcLinks) === canon(expectedLinks),
      severity: 'medium',
    })
    const dbVsFile = srcLive
      .filter((r) => srcRead.has(r.path))
      .filter((r) => canon(r.frontmatter) !== canon(srcRead.get(r.path)!.frontmatter) || r.body !== srcRead.get(r.path)!.body)
      .map((r) => r.path)
    checks.push({
      name: 'notes row (DB index) agrees with the file on disk (read_note) for every live note',
      expected: '0 disagreements',
      actual: `${dbVsFile.length}: ${dbVsFile.join(', ')}`,
      ok: dbVsFile.length === 0,
      severity: 'medium',
    })

    // --------------------------------------------------------- exports
    const mcpExport = await mcp.call('export_vault', { vaultId: V })
    // Shape: export_vault returns { vaultId, zipBase64, sizeBytes } (mcp/server.ts:1368-1372).
    const mcpPayload = mcpExport.json as { zipBase64?: string; sizeBytes?: number } | undefined
    const mcpZipBytes = mcpPayload?.zipBase64 ? new Uint8Array(Buffer.from(mcpPayload.zipBase64, 'base64')) : new Uint8Array(0)
    const restExport = await getRaw(base, `/api/vaults/${V}/export`, admin.cookie)
    const link = await admin.post<{ id: string; token: string }>(`/api/vaults/${V}/export-links`, {})
    const linkExport = link.json ? await getRaw(base, `/api/export-links/${link.json.token}`) : undefined
    const linkRevoke = link.json ? await admin.request('DELETE', `/api/vaults/${V}/export-links/${link.json.id}`) : undefined
    const linkAfterRevoke = link.json ? await getRaw(base, `/api/export-links/${link.json.token}`) : undefined
    const memberRestExport = await getRaw(base, `/api/vaults/${V}/export`, member.cookie)
    checks.push({
      name: 'exports available (MCP export_vault, REST export, export link without session)',
      expected: 'three zips',
      actual: `mcp ${mcpExport.ok ? `${mcpZipBytes.length} B` : mcpExport.text.slice(0, 80)}, rest ${restExport.status} ${restExport.bytes.length} B, link ${linkExport?.status} ${linkExport?.bytes.length} B`,
      ok: mcpExport.ok && restExport.status === 200 && linkExport?.status === 200,
      severity: 'high',
    })
    checks.push({
      name: 'revoked export link stops working',
      expected: '404 after DELETE',
      actual: `revoke ${linkRevoke?.status}, then ${linkAfterRevoke?.status}`,
      ok: linkAfterRevoke?.status === 404,
      severity: 'high',
    })
    checks.push({
      name: 'read-only member cannot export (export requires edit)',
      expected: '404',
      actual: String(memberRestExport.status),
      ok: memberRestExport.status === 404,
      severity: 'medium',
    })

    const restZip = readZip(restExport.bytes)
    const mcpZip = mcpZipBytes.length ? readZip(mcpZipBytes) : []
    const linkZip = linkExport?.status === 200 ? readZip(linkExport.bytes) : []
    const zipMap = (z: ZipEntry[]) => new Map(z.map((e) => [e.name, sha256(e.data)]))
    const restMap = zipMap(restZip)
    const sameAs = (other: ZipEntry[]) => {
      const m = zipMap(other)
      return [...new Set([...restMap.keys(), ...m.keys()])].filter((k) => restMap.get(k) !== m.get(k))
    }
    const mcpVsRest = sameAs(mcpZip)
    const linkVsRest = sameAs(linkZip)
    checks.push({
      name: 'MCP export == REST export == link export (entry names and bytes)',
      expected: '0 differing entries',
      actual: `mcp vs rest ${mcpVsRest.length}, link vs rest ${linkVsRest.length}`,
      ok: mcpVsRest.length === 0 && linkVsRest.length === 0,
      severity: 'medium',
      detail: { mcpVsRest, linkVsRest },
    })

    // Export vs source.
    const exportNames = restZip.map((e) => e.name).sort()
    const expectedNames = [
      ...srcLive.map((r) => `${r.path}.md`),
      ...srcAssets.map((a) => `assets/${a.fileName}`),
      'manifest.json',
    ].sort()
    const missingInExport = expectedNames.filter((n) => !exportNames.includes(n))
    const extraInExport = exportNames.filter((n) => !expectedNames.includes(n))
    checks.push({
      name: 'export contains every live note, every attachment, a manifest',
      expected: `${expectedNames.length} entries`,
      actual: `${exportNames.length} entries; missing ${missingInExport.length}, extra ${extraInExport.length}`,
      ok: missingInExport.length === 0 && extraInExport.length === 0,
      severity: 'high',
      detail: { missingInExport, extraInExport },
    })
    const exportDiff: Array<Record<string, unknown>> = []
    for (const e of restZip.filter((x) => x.name.endsWith('.md'))) {
      const path = e.name.replace(/\.md$/, '')
      const want = srcRead.get(path)
      const split = splitFrontmatter(dec.decode(e.data))
      if (!want || !split) {
        exportDiff.push({ path, problem: !want ? 'not a live source note' : 'no frontmatter fence' })
        continue
      }
      let fm: unknown
      try {
        fm = bunYamlParse(split.yaml)
      } catch (err) {
        exportDiff.push({ path, problem: `Bun.YAML: ${String(err).slice(0, 120)}` })
        continue
      }
      const d = jsonDiff(want.frontmatter, fm)
      const b = firstByteDiff(want.body, split.body)
      if (d.length || b >= 0) exportDiff.push({ path, frontmatterDiff: d, bodyFirstDiffByte: b })
    }
    checks.push({
      name: 'exported .md == read_note (frontmatter via independent YAML 1.2 parser, body byte-exact)',
      expected: '0 differing notes',
      actual: `${exportDiff.length}: ${exportDiff.map((x) => x.path).join(', ')}`,
      ok: exportDiff.length === 0,
      severity: 'high',
      detail: exportDiff,
    })
    const exportedAssets = restZip.filter((e) => e.name.startsWith('assets/'))
    const assetByteDiff = srcAssets.filter((a) => sha256(exportedAssets.find((e) => e.name === `assets/${a.fileName}`)?.data ?? new Uint8Array()) !== a.sha256)
    checks.push({
      name: 'exported attachments byte-identical to downloads',
      expected: '0 differing',
      actual: String(assetByteDiff.length),
      ok: assetByteDiff.length === 0,
      severity: 'high',
    })
    const trashInExport = srcTrash.filter((t) => exportNames.some((n) => n.includes(t.id) || n === `.trash/${t.id}.md`))
    checks.push({
      name: 'trash travels with the export',
      expected: `${srcTrash.length} trashed notes represented`,
      actual: `${trashInExport.length} represented (archive.ts:61 exports listNotes = live rows only)`,
      ok: trashInExport.length === srcTrash.length,
      severity: 'medium',
    })
    const srcRevTotal = srcRows.reduce((n, r) => n + r.revisions, 0)
    checks.push({
      name: 'revision history travels with the export',
      expected: `${srcRevTotal} revisions represented`,
      actual: `0 (no revision data in the archive format: archive.ts:58-81)`,
      ok: exportNames.some((n) => /revision|history/i.test(n)),
      severity: 'medium',
    })
    const manifestEntry = restZip.find((e) => e.name === 'manifest.json')
    // Shape: VaultManifest (export/archive.ts:24-28).
    const manifest = manifestEntry ? (JSON.parse(dec.decode(manifestEntry.data)) as { name: string; mergeable: boolean; shares: Array<{ email?: string; permission: string }> }) : undefined

    // ------------------------------------------- OKF conformance (export)
    const exportDir = mkdtempSync(join(tmpdir(), 'okf-export-'))
    extractZip(restZip, exportDir)
    const conceptSchema = loadOkfSchema('concept.schema.json')
    const schemaErrors: Array<Record<string, unknown>> = []
    for (const e of restZip.filter((x) => x.name.endsWith('.md'))) {
      const split = splitFrontmatter(dec.decode(e.data))
      if (!split) continue
      const errs = validateSchema(bunYamlParse(split.yaml), conceptSchema)
      if (errs.length) schemaErrors.push({ file: e.name, errors: errs })
    }
    checks.push({
      name: 'exported frontmatter validates against vendor/okf/schemas/concept.schema.json (YAML 1.2 reading)',
      expected: '0 schema errors',
      actual: `${schemaErrors.length} files with errors`,
      ok: schemaErrors.length === 0,
      severity: 'medium',
      detail: schemaErrors,
    })
    const ref = await okfReferenceParse(exportDir)
    const refDiffs: Array<Record<string, unknown>> = []
    const refSchemaErrors: Array<Record<string, unknown>> = []
    if (ref.docs) {
      for (const d of ref.docs) {
        const path = d.path.replace(/\.md$/, '')
        const want = srcRead.get(path)
        if (!d.ok || !d.frontmatter) {
          refDiffs.push({ file: d.path, parseError: d.error })
          continue
        }
        const errs = validateSchema(d.frontmatter, conceptSchema)
        if (errs.length) refSchemaErrors.push({ file: d.path, errors: errs })
        if (!want) continue
        const fmDiff = jsonDiff(want.frontmatter, d.frontmatter)
        // document.py uses splitlines(): CR/LF folded, trailing newline dropped.
        const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
        const bodyOk = norm(want.body) === norm(d.body ?? '')
        if (fmDiff.length || !bodyOk || d.validateError) {
          refDiffs.push({ file: d.path, frontmatterDiff: fmDiff, bodyEqualModuloNewlines: bodyOk, validateError: d.validateError })
        }
      }
    }
    checks.push({
      name: 'OKF reference parser (open-knowledge-format document.py) reads every exported note as written',
      expected: '0 notes misread',
      actual: ref.docs ? `${refDiffs.length} of ${ref.docs.length} misread (${ref.parser})` : `parser unavailable: ${ref.stderr.slice(0, 160)}`,
      ok: ref.docs ? refDiffs.length === 0 : null,
      severity: 'medium',
      detail: { refDiffs, refSchemaErrors },
    })
    const instanceBoundLinks = [...srcRead.values()].flatMap((n) => assetRefs(n.body).map((a) => ({ note: n.path, ...a })))
    checks.push({
      name: 'attachment links in the exported bundle resolve inside the bundle (OKF §6.1 bundle-relative)',
      expected: 'links point at bundle paths (e.g. /assets/x.png)',
      actual: `${instanceBoundLinks.length} links are instance API URLs /api/vaults/${V}/assets/... (editor form, client/src/hooks/imageDecorations.ts:141)`,
      ok: instanceBoundLinks.length === 0,
      severity: 'medium',
      detail: instanceBoundLinks,
    })
    checks.push({
      name: 'bundle declares okf_version (root index.md, OKF §12)',
      expected: 'optional: root index.md with okf_version',
      actual: exportNames.includes('index.md') ? 'present' : 'absent (no index.md files exported at all; Elara writes them on disk only)',
      ok: exportNames.includes('index.md'),
      severity: 'info',
    })

    // ---------------------------------------------------------- import
    const imports: Record<string, ImportResult | string> = {}
    for (const [label, bytes] of [
      ['rest', restExport.bytes],
      ['mcp', mcpZipBytes],
    ] as const) {
      // The round trip opts in to re-sharing (#621), so the manifest share check below measures it.
      const r = await postFile(base, '/api/import?applyShares=true', admin.cookie, 'vault-export.zip', bytes, 'application/zip')
      // Shape: export/routes.ts, POST /import.
      imports[label] = r.status === 200 ? (r.json as ImportResult) : `${r.status} ${r.text.slice(0, 300)}`
    }
    const imp = typeof imports.rest === 'object' ? imports.rest : undefined
    checks.push({
      name: 'REST /import accepts the REST and the MCP export',
      expected: 'both 200, 0 skipped',
      actual: JSON.stringify(Object.fromEntries(Object.entries(imports).map(([k, v]) => [k, typeof v === 'object' ? { imported: v.imported, skipped: v.skipped.length } : v]))),
      ok: Object.values(imports).every((v) => typeof v === 'object' && v.skipped.length === 0),
      severity: 'high',
      detail: imports,
    })

    const diffRows: Array<Record<string, unknown>> = []
    let impRows: NoteRow[] = []
    let impAssets: AssetInfo[] = []
    if (imp) {
      impRows = await noteSnapshot(null, [imp.vaultId])
      impAssets = await assetSnapshot(base, admin.cookie, imp.vaultId)
      const impLive = impRows.filter((r) => !r.trashed)
      const impRead = new Map<string, ReadNote>()
      for (const r of impLive) {
        const x = await mcp.call('read_note', { vaultId: imp.vaultId, path: r.path })
        if (x.ok) impRead.set(r.path, x.json as ReadNote)
      }
      const srcPaths = srcLive.map((r) => r.path)
      const impPaths = impLive.map((r) => r.path)
      const missing = srcPaths.filter((p) => !impPaths.includes(p))
      const extra = impPaths.filter((p) => !srcPaths.includes(p))
      diffRows.push({ aspect: 'live note paths', source: srcPaths.length, imported: impPaths.length, differences: missing.length + extra.length, detail: { missing, extra } })
      const fmDiffs: Array<Record<string, unknown>> = []
      const bodyDiffs: Array<Record<string, unknown>> = []
      const linkDiffs: Array<Record<string, unknown>> = []
      for (const p of srcPaths.filter((x) => impPaths.includes(x))) {
        const a = srcRead.get(p)
        const b = impRead.get(p)
        if (!a || !b) continue
        const d = jsonDiff(a.frontmatter, b.frontmatter)
        if (d.length) fmDiffs.push({ path: p, diff: d })
        const at = firstByteDiff(a.body, b.body)
        if (at >= 0) bodyDiffs.push({ path: p, firstDiffByte: at, srcLen: enc.encode(a.body).length, impLen: enc.encode(b.body).length })
        const la = srcLive.find((r) => r.path === p)!.links
        const lb = impLive.find((r) => r.path === p)!.links
        if (canon(la) !== canon(lb)) linkDiffs.push({ path: p, source: la, imported: lb })
      }
      diffRows.push({ aspect: 'frontmatter (deep equal)', source: srcPaths.length, imported: impRead.size, differences: fmDiffs.length, detail: fmDiffs })
      diffRows.push({ aspect: 'body (byte-exact)', source: srcPaths.length, imported: impRead.size, differences: bodyDiffs.length, detail: bodyDiffs })
      diffRows.push({
        aspect: 'wikilink edges (note_links)',
        source: srcLive.reduce((n, r) => n + r.links.length, 0),
        imported: impLive.reduce((n, r) => n + r.links.length, 0),
        differences: linkDiffs.length,
        detail: linkDiffs,
      })
      diffRows.push({
        aspect: 'revisions (note_revisions rows)',
        source: srcRows.reduce((n, r) => n + r.revisions, 0),
        imported: impRows.reduce((n, r) => n + r.revisions, 0),
        differences: srcRows.reduce((n, r) => n + r.revisions, 0) - impRows.reduce((n, r) => n + r.revisions, 0),
        detail: srcRows.map((r) => ({ path: r.path, trashed: r.trashed, source: r.revisions, imported: impRows.find((x) => x.path === r.path && !x.trashed)?.revisions ?? 0 })),
      })
      diffRows.push({ aspect: 'trash (soft-deleted notes)', source: srcTrash.length, imported: impRows.filter((r) => r.trashed).length, differences: srcTrash.length - impRows.filter((r) => r.trashed).length })
      const assetMatch = srcAssets.map((a) => {
        const sameBytes = impAssets.find((b) => b.sha256 === a.sha256)
        return { source: a.fileName, imported: sameBytes?.fileName ?? null, sameName: sameBytes?.fileName === a.fileName }
      })
      diffRows.push({
        aspect: 'attachments (bytes / file name)',
        source: srcAssets.length,
        imported: impAssets.length,
        differences: assetMatch.filter((m) => !m.imported || !m.sameName).length,
        detail: assetMatch,
      })
      const refStatus: Array<Record<string, unknown>> = []
      for (const [p, n] of impRead) {
        for (const ref of assetRefs(n.body)) {
          const g = await getRaw(base, `/api/vaults/${ref.vaultId}/assets/${encodeURIComponent(ref.fileName)}`, admin.cookie)
          const gImp = await getRaw(base, `/api/vaults/${imp.vaultId}/assets/${encodeURIComponent(ref.fileName)}`, admin.cookie)
          refStatus.push({ note: p, pointsAtVault: ref.vaultId === imp.vaultId ? 'imported' : ref.vaultId === V ? 'SOURCE' : ref.vaultId, fileName: ref.fileName, asLinked: g.status, inImportedVault: gImp.status })
        }
      }
      diffRows.push({
        aspect: 'attachment links resolvable inside the imported vault',
        source: instanceBoundLinks.length,
        imported: refStatus.filter((r) => r.pointsAtVault === 'imported' && r.asLinked === 200).length,
        differences: refStatus.filter((r) => !(r.pointsAtVault === 'imported' && r.asLinked === 200)).length,
        detail: refStatus,
      })
      const impShares = await ctx.docker.psqlRows<{ grantee_id: string; permission: string }>(
        `select grantee_id, permission from vault_shares where vault_id = '${imp.vaultId}'`,
      )
      diffRows.push({
        aspect: 'shares (manifest)',
        source: manifest?.shares.length ?? 0,
        imported: impShares.length,
        differences: Math.abs((manifest?.shares.length ?? 0) - impShares.length),
        detail: { manifest: manifest?.shares, imported: impShares, applied: imp.appliedShares, skipped: imp.skippedShares },
      })
      const vaultRow = await ctx.docker.psqlRows<{ name: string; mergeable: boolean }>(`select name, mergeable from vaults where id = '${imp.vaultId}'`)
      diffRows.push({ aspect: 'vault name', source: src.name, imported: vaultRow[0]?.name, differences: vaultRow[0]?.name === src.name ? 0 : 1 })

      const row = (aspect: string) => diffRows.find((r) => r.aspect === aspect)!
      const zero = (aspect: string) => row(aspect).differences === 0
      checks.push({ name: 'import: every live path present', expected: '0 missing/extra', actual: String(row('live note paths').differences), ok: zero('live note paths'), severity: 'high', detail: row('live note paths').detail })
      checks.push({ name: 'import: frontmatter deep-equal', expected: '0', actual: String(row('frontmatter (deep equal)').differences), ok: zero('frontmatter (deep equal)'), severity: 'high' })
      checks.push({ name: 'import: bodies byte-exact', expected: '0', actual: String(row('body (byte-exact)').differences), ok: zero('body (byte-exact)'), severity: 'high' })
      checks.push({ name: 'import: wikilink edges identical', expected: '0', actual: String(row('wikilink edges (note_links)').differences), ok: zero('wikilink edges (note_links)'), severity: 'medium' })
      checks.push({
        name: 'import: revision history preserved',
        expected: `${row('revisions (note_revisions rows)').source} revisions`,
        actual: `${row('revisions (note_revisions rows)').imported} revisions`,
        ok: zero('revisions (note_revisions rows)'),
        severity: 'medium',
      })
      checks.push({ name: 'import: trash preserved', expected: `${srcTrash.length} trashed`, actual: `${row('trash (soft-deleted notes)').imported} trashed`, ok: zero('trash (soft-deleted notes)'), severity: 'medium' })
      checks.push({
        name: 'import: attachments keep their file names (so links keep working)',
        expected: 'same names, same bytes',
        actual: JSON.stringify(assetMatch.map((m) => `${m.source} -> ${m.imported}`)).slice(0, 280),
        ok: zero('attachments (bytes / file name)'),
        severity: 'high',
        detail: { assetMatch, code: 'export/routes.ts:155 saveAsset() -> store.ts:1083 sanitizeAssetFilename() appends a new -<Date.now()>-<uuid6>' },
      })
      checks.push({
        name: 'import: attachment links in notes resolve within the imported vault',
        expected: `${instanceBoundLinks.length} links resolvable in the new vault`,
        actual: `${row('attachment links resolvable inside the imported vault').imported} resolvable`,
        ok: zero('attachment links resolvable inside the imported vault'),
        severity: 'high',
        detail: refStatus,
      })
      checks.push({ name: 'import: share to member re-created from manifest', expected: '1 share', actual: String(impShares.length), ok: impShares.length === (manifest?.shares.length ?? 0), severity: 'low' })
    }

    // ------------------------------- "---" corruption: one save makes it permanent
    const tdEdit = await mcp.call('edit_note', { vaultId: V, path: 'concepts/triple-dash', body: 'Edited body.\n' })
    type Row = { frontmatter: Record<string, unknown>; body: string }
    const tdRow = await poll(async () => {
      const rows = await ctx.docker.psqlRows<Row>(`select frontmatter, body from notes where vault_id = '${V}' and path = 'concepts/triple-dash' and deleted_at is null`)
      return rows[0]?.body === 'Edited body.\n' ? rows[0] : undefined
    }, 20_000)
    checks.push({
      name: 'after one body-only edit the "---" mis-parse is persisted into the DB row (permanent loss)',
      expected: 'row keeps title "Q3 --- plan" and description "before---after"',
      actual: `edit ${tdEdit.ok}; row frontmatter ${JSON.stringify(tdRow?.frontmatter ?? 'edit not observed')}`,
      ok: tdRow?.frontmatter.title === 'Q3 --- plan' && tdRow.frontmatter.description === 'before---after',
      severity: 'high',
    })

    // -------------------------------------- foreign OKF bundles / crafted
    const crafted: Record<string, unknown> = {}
    const acmeFiles: Array<{ name: string; data: Uint8Array }> = []
    for (const f of ACME_FILES) {
      const r = await fetch(`https://raw.githubusercontent.com/GoogleCloudPlatform/open-knowledge-format/${OKF_COMMIT}/bundles/acme_retail/${f}`).catch(() => undefined)
      if (r?.ok) acmeFiles.push({ name: f, data: new Uint8Array(await r.arrayBuffer()) })
    }
    if (acmeFiles.length === ACME_FILES.length) {
      const acmeConcepts = ACME_FILES.filter((f) => !/(^|\/)(index|log)\.md$/.test(f))
      const zip = writeZip([...acmeFiles, { name: 'manifest.json', data: enc.encode(JSON.stringify({ name: 'acme_retail (OKF sample)', mergeable: false, shares: [] })) }])
      const r = await postFile(base, '/api/import', admin.cookie, 'acme.zip', zip, 'application/zip')
      const res = r.json as ImportResult | undefined
      const acmeTypes = acmeFiles
        .filter((f) => acmeConcepts.includes(f.name))
        .map((f) => {
          const s = splitFrontmatter(dec.decode(f.data))
          const fm = s ? (bunYamlParse(s.yaml) as Record<string, unknown>) : {}
          return { file: f.name, type: fm.type }
        })
      crafted.acme = { status: r.status, result: res, types: acmeTypes }
      checks.push({
        name: 'import a real OKF v0.2 bundle (open-knowledge-format bundles/acme_retail)',
        expected: `${acmeConcepts.length} concepts imported`,
        actual: res ? `${res.imported} imported, ${res.skipped.length} skipped: ${res.skipped.slice(0, 3).join(' | ')}` : `${r.status} ${r.text.slice(0, 160)}`,
        ok: res ? res.imported === acmeConcepts.length : false,
        severity: 'high',
        detail: { result: res, acmeTypes, code: 'okf.ts:84 frontmatter.type must equal the first path segment slug; OKF types are free text (SPEC §4.1)' },
      })
      if (res?.vaultId) {
        const acmeRows = await noteSnapshot(null, [res.vaultId])
        const acmeLinks = acmeRows.reduce((n, x) => n + x.links.length, 0)
        const mdLinks = acmeFiles.reduce((n, f) => n + [...dec.decode(f.data).matchAll(/\]\((?:\.{0,2}\/)?[^)\s]+\.md\)/g)].length, 0)
        checks.push({
          name: 'OKF markdown links (§6.1) become graph edges on import',
          expected: `edges for the ${mdLinks} markdown .md links in the bundle`,
          actual: `${acmeLinks} note_links rows (Elara extracts only [[wikilinks]], okf.ts:241-253)`,
          ok: mdLinks === 0 || acmeLinks > 0,
          severity: 'medium',
        })
      }
    } else {
      checks.push({ name: 'import a real OKF v0.2 bundle', expected: 'sample fetched', actual: `${acmeFiles.length}/${ACME_FILES.length} files fetched`, ok: null, severity: 'info' })
    }

    const evil = writeZip([
      { name: 'manifest.json', data: enc.encode(JSON.stringify({ name: 'crafted', mergeable: true, shares: [{ granteeType: 'user', email: ctx.env.users.member.email, permission: 'edit' }] })) },
      { name: '../escape.md', data: enc.encode('---\ntype: escape\n---\nx') },
      { name: 'concepts/../../escape2.md', data: enc.encode('---\ntype: escape2\n---\nx') },
      { name: 'assets/../../../escape.png', data: makePng(2, 2, 1) },
      { name: 'assets/ok.png', data: makePng(2, 2, 2) },
      { name: 'concepts/mismatch.md', data: enc.encode('---\ntype: tables\n---\nwrong type') },
      { name: 'concepts/no-fence.md', data: enc.encode('no frontmatter at all') },
      { name: 'concepts/good.md', data: enc.encode('---\ntype: concepts\ntitle: good\n---\nfine\n') },
    ])
    const evilRes = await postFile(base, '/api/import', admin.cookie, 'crafted.zip', evil, 'application/zip')
    const evilJson = evilRes.json as ImportResult | undefined
    const escaped = await ctx.docker.appExec(['sh', '-c', 'ls -la /data/elara/escape* /data/elara/vaults/escape* /data/escape* 2>/dev/null; true'])
    crafted.evil = { status: evilRes.status, result: evilJson, escapedFiles: escaped.stdout }
    const evilShare = evilJson?.vaultId
      ? await ctx.docker.psqlRows<{ grantee_id: string; permission: string }>(`select grantee_id, permission from vault_shares where vault_id = '${evilJson.vaultId}'`)
      : []
    checks.push({
      name: 'crafted archive: traversal entries are not written outside the vault',
      expected: 'only concepts/good imported; no escape* files',
      actual: `${evilRes.status} imported=${evilJson?.imported} skipped=${evilJson?.skipped.length}; escape files: ${escaped.stdout.trim() || 'none'}`,
      ok: evilJson?.imported === 1 && escaped.stdout.trim() === '',
      severity: 'high',
      detail: evilJson,
    })
    checks.push({
      name: 'crafted archive manifest silently grants another user edit access to the imported vault',
      expected: 'no access granted unless the importer opts in (applyShares), and the share reported as skipped',
      actual: `${evilShare.length} share(s) created: ${JSON.stringify(evilShare)}`,
      ok: evilShare.length === 0 && evilJson?.skippedShares.some((s) => s.reason === 'not_requested') === true,
      severity: 'low',
      detail: { skippedShares: evilJson?.skippedShares, code: 'export/routes.ts importManifestShares grants manifest shares only with ?applyShares=true (#621)' },
    })
    const notZip = await postFile(base, '/api/import', admin.cookie, 'x.zip', enc.encode('not a zip'), 'application/zip')
    const noManifest = await postFile(base, '/api/import', admin.cookie, 'y.zip', writeZip([{ name: 'concepts/a.md', data: enc.encode('---\ntype: concepts\n---\n') }]), 'application/zip')
    checks.push({
      name: 'malformed archives rejected with 400',
      expected: '400 / 400',
      actual: `${notZip.status} / ${noManifest.status}`,
      ok: notZip.status === 400 && noManifest.status === 400,
      severity: 'low',
    })

    const failed = checks.filter((c) => c.ok === false)
    return {
      summary:
        `Source vault ${V}: ${srcLive.length} live notes, ${srcTrash.length} trashed, ${srcRevTotal} revisions, ${srcAssets.length} attachments. ` +
        `Exports MCP/REST/link ${mcpVsRest.length + linkVsRest.length === 0 ? 'identical' : 'differ'}; ` +
        `import diff: ${diffRows.map((r) => `${r.aspect}=${r.differences}`).join('; ')}. ` +
        `OKF reference parser misread ${refDiffs.length} notes. ${failed.length} failed checks.`,
      checks,
      data: {
        sourceVaultId: V,
        importedVaultIds: Object.fromEntries(Object.entries(imports).map(([k, v]) => [k, typeof v === 'object' ? v.vaultId : null])),
        storedAssetNames: stored,
        diffTable: diffRows,
        writeFidelity: fidelity,
        exportEntries: restZip.map((e) => ({ name: e.name, bytes: e.data.length, method: e.method, utf8Flag: e.utf8Flag, sha256: sha256(e.data) })),
        exportSizes: { mcpBase64Chars: mcpPayload?.zipBase64?.length ?? 0, mcpZip: mcpZipBytes.length, restZip: restExport.bytes.length },
        exportVsSource: exportDiff,
        manifest,
        okfSchemaErrors: schemaErrors,
        okfReference: { parser: ref.parser, stderr: ref.stderr, diffs: refDiffs, schemaErrors: refSchemaErrors, docs: ref.docs?.map((d) => ({ path: d.path, ok: d.ok, validateError: d.validateError, trustTier: d.trustTier, isStale: d.isStale })) },
        exportedFrontmatterAll: dec.decode(restZip.find((e) => e.name === 'concepts/frontmatter-all.md')?.data ?? new Uint8Array()),
        exportedTripleDash: dec.decode(restZip.find((e) => e.name === 'concepts/triple-dash.md')?.data ?? new Uint8Array()),
        sourceRows: srcRows.map((r) => ({ path: r.path, trashed: r.trashed, revisions: r.revisions, links: r.links })),
        importedRows: impRows.map((r) => ({ path: r.path, trashed: r.trashed, revisions: r.revisions, links: r.links })),
        sourceAssets: srcAssets,
        importedAssets: impAssets,
        crafted,
      },
    }
  },
}
export default test
