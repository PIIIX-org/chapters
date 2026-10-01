import fs from 'fs';

const defects = [
  {
    id: "DEF-01",
    batch: "Batch A",
    subsystem: "Shell & Layout",
    severity: "HIGH",
    title: "Shell Rail Occlusion of Main Dashboard Content",
    element: "AppShell & Content Containers",
    proofImage: "15-shell-rail-state.png",
    codeRef: "client/src/components/shell/AppShell.tsx",
    relatedFiles: ["client/src/components/shell/AppShell.tsx", "client/src/pages/vault/NoteView.tsx", "client/src/pages/VaultsPage.tsx"],
    symptom: "Floating navigation rail (fixed at left 10px, 44px wide) physically overlays and occludes the left boundary of dashboard cards, note title bars, and context panel triggers when container padding is less than 64px.",
    rootCause: "In AppShell.tsx, <main> container lacked standardized left clearance (pl-0), while individual pages applied disparate left margins. In NoteView.tsx, leftPad hardcoded pl-16 (64px) which failed to account for desktop ContextPanel drawer offsets.",
    remediation: "Standardize left padding across dashboard views to pl-[72px] sm:pl-20. Reposition desktop ContextPanel to left-[68px]. In NoteView.tsx, dynamically adjust leftPad to pl-[320px] when context panel is open, and pl-20 when collapsed.",
    diff: `// NoteView.tsx
- const leftPad = shell?.sidebarExpanded ? 'pl-[264px]' : 'pl-16'
+ const leftPad = shell?.contextOpen
+   ? 'pl-[320px]'
+   : shell?.sidebarExpanded
+     ? 'pl-[264px]'
+     : 'pl-20'

// AppShell.tsx
- <aside data-shell-panel="context" className="... left-2.5 ...">
+ <aside data-shell-panel="context" className="... left-[68px] max-md:left-0 ...">`,
    verification: "Verify visual clearance in both expanded and collapsed rail states across desktop and tablet breakpoints. Check that note title and breadcrumbs do not clip behind the floating CH button."
  },
  {
    id: "DEF-02",
    batch: "Batch A",
    subsystem: "Code Viewer / Repositories",
    severity: "MEDIUM",
    title: "Repository Top Action Bar / Status Pill Collision",
    element: "Repository Header Action Bar",
    proofImage: "63-code-viewer-syntax-highlighting.png",
    codeRef: "client/src/pages/RepositoryPage.tsx:357",
    relatedFiles: ["client/src/pages/RepositoryPage.tsx"],
    symptom: "Repository action controls ('Index', 'Sync', 'Settings') overlap with the shell's top right '• SYNCED' status badge on viewports between 1024px and 1280px width.",
    rootCause: "Top action bar in RepositoryPage.tsx had right padding restricted to pr-16 (64px), failing to clear TopBar's absolute-positioned status badge.",
    remediation: "In RepositoryPage.tsx:357, expand right padding from pr-16 to pr-52 (208px), providing a 48px clearance buffer from the SYNCED indicator.",
    diff: `// RepositoryPage.tsx:357
- <div className="flex items-center gap-2 pr-16">
+ <div className="flex items-center gap-2 pr-52">`,
    verification: "Test viewports at 1024px, 1152px, and 1280px widths to confirm at least 32px clearance between the last action button and the status pill."
  },
  {
    id: "DEF-03",
    batch: "Batch A",
    subsystem: "Mobile Shell (375px)",
    severity: "HIGH",
    title: "Mobile 375px Shell Layout Breakdown & Horizontal Overflow",
    element: "Navigation Rail & BottomBar",
    proofImage: "82-responsive-mobile-vaults-375x812.png",
    codeRef: "client/src/components/shell/Rail.tsx:146",
    relatedFiles: ["client/src/components/shell/Rail.tsx", "client/src/components/shell/BottomBar.tsx", "client/src/pages/VaultsPage.tsx"],
    symptom: "On 375px mobile screens, floating rail cards render over content, desktop margins cause horizontal body scroll (bodyScrollX: true), and header controls collide.",
    rootCause: "Collapsed rail cards in Rail.tsx were rendered without responsive hiding (max-md:hidden), and BottomBar.tsx retained desktop margin offsets (ml-[54px]) on mobile.",
    remediation: "Add max-md:hidden to collapsed rail nav cards in Rail.tsx so only the standalone CH logo appears as the mobile drawer toggle. Reclaim px-3 padding on mobile pages and remove desktop margin offsets in BottomBar.tsx.",
    diff: `// Rail.tsx:146, 163
- <div className="flex flex-col items-center gap-1">
+ <div className="flex flex-col items-center gap-1 max-md:hidden">

// BottomBar.tsx:48
- shell.sidebarExpanded ? 'md:ml-[256px] ml-[54px]' : 'ml-[54px] md:ml-[60px]'
+ shell.sidebarExpanded ? 'md:ml-[256px] ml-0' : 'ml-0 md:ml-[60px]'`,
    verification: "Audit 375x812 viewport in Playwright/DevTools; verify zero horizontal body scroll (window.scrollX === 0) and unobstructed page headers."
  },
  {
    id: "DEF-08",
    batch: "Batch A",
    subsystem: "Mobile Note Editor",
    severity: "HIGH",
    title: "Duplicate Overlapping 'OFFLINE' Badge on Mobile Note Editor",
    element: "CollabStatusLine Pill",
    proofImage: "adv-11-soft-keyboard-clipping.png",
    codeRef: "client/src/components/vault/CollabStatusLine.tsx:64",
    relatedFiles: ["client/src/components/vault/CollabStatusLine.tsx"],
    symptom: "Both shell TopBar and NoteView breadcrumb simultaneously render red 'OFFLINE' badges on mobile, colliding directly with warning text.",
    rootCause: "CollabStatusLine.tsx unconditionally rendered <Pill> badges regardless of screen size, duplicating the status badge already presented in the shell TopBar.",
    remediation: "Add hidden sm:inline-flex to <Pill> elements in CollabStatusLine.tsx. Shell TopBar owns the single status badge on mobile, leaving detail text clean and readable.",
    diff: `// CollabStatusLine.tsx:64
- <Pill tone={statusTone(status)}>
+ <Pill tone={statusTone(status)} className="hidden sm:inline-flex">`,
    verification: "Simulate offline state on 375px mobile screen. Confirm only one OFFLINE badge renders in the top bar, with no overlapping badges in the note bar."
  },
  {
    id: "DEF-09",
    batch: "Batch A",
    subsystem: "Shell Popovers",
    severity: "MEDIUM",
    title: "ScopePicker & NotificationBell Popover Collision",
    element: "ScopePicker Dropdown",
    proofImage: "17-shell-scope-picker-open.png",
    codeRef: "client/src/components/shell/ScopePicker.tsx:55",
    relatedFiles: ["client/src/components/shell/ScopePicker.tsx"],
    symptom: "Clicking NotificationBell or outside does not auto-dismiss an active ScopePicker menu, creating overlapping, conflicting dropdowns.",
    rootCause: "ScopePicker.tsx lacked a window pointerdown listener (which NotificationBell.tsx implemented), remaining open until explicitly clicked again.",
    remediation: "Add outside pointerdown event listener in ScopePicker.tsx (mirroring NotificationBell.tsx) with guards for open Radix dialog portals.",
    diff: `// ScopePicker.tsx
+ useEffect(() => {
+   if (!open) return
+   const onPointerDown = (e: PointerEvent) => {
+     const target = e.target as HTMLElement
+     if (wrapperRef.current?.contains(target) || target.closest('[role=\"dialog\"]')) return
+     setOpen(false)
+   }
+   window.addEventListener('pointerdown', onPointerDown)
+   return () => window.removeEventListener('pointerdown', onPointerDown)
+ }, [open])`,
    verification: "Open ScopePicker, click NotificationBell; verify ScopePicker dismisses cleanly and does not collide with the notification drawer."
  },
  {
    id: "DEF-16",
    batch: "Batch A",
    subsystem: "Touch Ergonomics & Mobile",
    severity: "HIGH",
    title: "Mobile Interactive Touch Targets Under 44px (WCAG 2.5.5)",
    element: "Button Base Variants",
    proofImage: "adv-12-touch-target-size-heatmap.png",
    codeRef: "client/src/components/ui/button-variants.ts:7",
    relatedFiles: ["client/src/components/ui/button-variants.ts"],
    symptom: "38 out of 39 interactive buttons on mobile measure between 26px and 32px height, violating the WCAG 2.5.5 minimum 44x44px target standard.",
    rootCause: "Button styles were designed solely for visual density without tactile hit-area expansion.",
    remediation: "Add centered invisible pseudo-element expansion to base button styles: relative after:absolute after:inset-y-1/2 after:inset-x-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:min-w-[44px] after:min-h-[44px] after:content-[''] md:after:hidden.",
    diff: `// button-variants.ts:7
- "inline-flex items-center justify-center ..."
+ "inline-flex items-center justify-center relative after:absolute after:inset-y-1/2 after:inset-x-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:min-w-[44px] after:min-h-[44px] after:content-[''] md:after:hidden ..."`,
    verification: "Measure interactive touch bounds via Chrome DevTools touch target heatmap; confirm all mobile button hit areas meet or exceed 44x44px without altering visual layout."
  },
  {
    id: "DEF-18",
    batch: "Batch A",
    subsystem: "Mobile Virtual Keyboard",
    severity: "MEDIUM",
    title: "Soft Keyboard Viewport Clipping in Note Editor",
    element: "Viewport Meta & CodeMirror Editor",
    proofImage: "adv-11-soft-keyboard-clipping.png",
    codeRef: "client/index.html:5",
    relatedFiles: ["client/index.html", "client/src/hooks/useCodeMirrorEditor.ts"],
    symptom: "Virtual keyboard popups reduce viewport height to 480px, obscuring the active typing caret under the soft keyboard.",
    rootCause: "Mobile browsers default to overlaying virtual keyboards without resizing layout viewport; CodeMirror lacked a visualViewport resize listener.",
    remediation: "Add interactive-widget=resizes-content to viewport meta tag in client/index.html:5. Attach a window.visualViewport resize listener in useCodeMirrorEditor.ts to scroll the active selection into view when the keyboard opens.",
    diff: `// client/index.html:5
- <meta name="viewport" content="width=device-width, initial-scale=1.0" />
+ <meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content" />

// useCodeMirrorEditor.ts
+ useEffect(() => {
+   const vv = window.visualViewport
+   if (!vv) return
+   const onResize = () => {
+     const view = viewRef.current
+     if (view && view.hasFocus) view.dispatch({ scrollIntoView: true })
+   }
+   vv.addEventListener('resize', onResize)
+   return () => vv.removeEventListener('resize', onResize)
+ }, [])`,
    verification: "Simulate 480px keyboard resize on mobile device/emulator; verify active cursor line auto-scrolls into visible upper pane."
  },
  {
    id: "DEF-04",
    batch: "Batch B",
    subsystem: "Backend & Mock Server",
    severity: "HIGH",
    title: "Mock Server HTTP 405 on Revision Diff Preview",
    element: "Revision Preview Endpoint",
    proofImage: "modal-09-revision-diff-dialog-real.png",
    codeRef: "client/mock/server.mjs:1803",
    relatedFiles: ["client/mock/server.mjs"],
    symptom: "Opening historical note version diff in offline/mock server mode crashes with HTTP 405 Method Not Allowed.",
    rootCause: "Mock server registered revision listing and purge routes, but omitted the individual revision GET handler (get('/vaults/:id/revisions/:revisionId')).",
    remediation: "Add get('/vaults/:id/revisions/:revisionId') route in client/mock/server.mjs returning full revision snapshots matching the production Fastify endpoint.",
    diff: `// client/mock/server.mjs:1803
+ server.get('/api/vaults/:id/revisions/:revisionId', (req, res) => {
+   const rev = revisions.find(r => r.id === req.params.revisionId && r.vaultId === req.params.id)
+   if (!rev) return res.status(404).json({ error: 'Revision not found' })
+   res.json(rev)
+ })`,
    verification: "Run client under mock server (npm --prefix client dev:mock); click 'View diff' on historical revision in note history drawer; confirm diff renders without 405 error."
  },
  {
    id: "DEF-05",
    batch: "Batch B",
    subsystem: "Repositories & Data Hydration",
    severity: "HIGH",
    title: "Raw Backend UUIDs Rendered in Repository Share List",
    element: "Repository Settings Share Table",
    proofImage: "flow-06-repo-settings-dialog.png",
    codeRef: "server/src/repositories/routes.ts:279",
    relatedFiles: ["server/src/repositories/routes.ts", "client/src/components/repositories/RepositoryShareList.tsx"],
    symptom: "Shared members list in Repository Settings renders raw UUIDs (e.g. 'd1b24e6e...') instead of user emails or names.",
    rootCause: "While vault shares hydrated user identities from the users table, server/src/repositories/routes.ts only joined teams, leaving direct user shares with unhydrated UUIDs.",
    remediation: "In server/src/repositories/routes.ts:279, add a join against users table when granteeType === 'user'. Update RepositoryShareList.tsx to display user badge and email.",
    diff: `// server/src/repositories/routes.ts:279
- const shares = await db.select().from(repositoryShares)...
+ const shares = await db.select({
+   id: repositoryShares.id,
+   granteeId: repositoryShares.granteeId,
+   granteeType: repositoryShares.granteeType,
+   granteeEmail: users.email,
+   granteeName: users.name,
+   access: repositoryShares.access,
+ }).from(repositoryShares)
+   .leftJoin(users, eq(repositoryShares.granteeId, users.id))...`,
    verification: "Open Repository Settings > Access tab; verify user entries display display name and email rather than raw hex UUIDs."
  },
  {
    id: "DEF-06",
    batch: "Batch B",
    subsystem: "Settings & Authentication",
    severity: "HIGH",
    title: "TOTP Two-Factor Authentication Missing Visual QR Code",
    element: "MFA Setup Modal",
    proofImage: "modal-03-settings-mfa-setup-flow.png",
    codeRef: "client/src/pages/settings/MfaSection.tsx:280",
    relatedFiles: ["client/src/pages/settings/MfaSection.tsx"],
    symptom: "MFA setup modal only displays plain text URI and raw base32 secret; users cannot scan with mobile authenticator apps.",
    rootCause: "QR code generator was deferred to prevent exceeding the initial shell bundle budget (< 300KB gzipped).",
    remediation: "Dynamically import qrcode on demand (const QRCode = await import('qrcode')) inside MfaSection.tsx to render a 192x192 SVG/canvas QR code from start.data.uri without adding bytes to the entry bundle.",
    diff: `// MfaSection.tsx
+ const [qrSvg, setQrSvg] = useState<string | null>(null)
+ useEffect(() => {
+   if (!start.data?.uri) return
+   void import('qrcode').then((QRCode) => {
+     QRCode.toString(start.data.uri, { type: 'svg', margin: 1, width: 192 }, (err, svg) => {
+       if (!err && svg) setQrSvg(svg)
+     })
+   })
+ }, [start.data?.uri])`,
    verification: "Run npm --prefix client test bundle.test.ts to verify bundle size remains under 300KB budget; initiate MFA setup to confirm 192x192 SVG QR renders and scans."
  },
  {
    id: "DEF-07",
    batch: "Batch B",
    subsystem: "MCP & Token Management",
    severity: "MEDIUM",
    title: "Action Button Text Truncation in MCP Tokens Table",
    element: "VaultMcpPanel Token Table",
    proofImage: "modal-04-settings-mcp-generate-modal.png",
    codeRef: "client/src/components/vault/VaultMcpPanel.tsx:71",
    relatedFiles: ["client/src/components/vault/VaultMcpPanel.tsx"],
    symptom: "Table action button is clipped to 'Rev' instead of 'Revoke' due to narrow table column width.",
    rootCause: "TableHead and TableCell for the actions column lacked fixed width or shrink-0, collapsing under flex constraints.",
    remediation: "Assign w-24 shrink-0 to action TableHead and TableCell in VaultMcpPanel.tsx:71,187, and add whitespace-nowrap to the Revoke Button.",
    diff: `// VaultMcpPanel.tsx:71, 187
- <TableHead className="w-0">
+ <TableHead className="w-24 shrink-0">
...
- <TableCell className="w-0">
+ <TableCell className="w-24 shrink-0">
- <Button size=\"xs\" variant=\"ghost\" ...>
+ <Button size=\"xs\" variant=\"ghost\" className=\"whitespace-nowrap\" ...>`,
    verification: "View MCP tokens table in Vault Settings; verify action button consistently displays full 'Revoke' label across all viewport widths."
  },
  {
    id: "DEF-20",
    batch: "Batch B",
    subsystem: "CRDT / Realtime Synchronization",
    severity: "MEDIUM",
    title: "Rapid Navigation Unpersisted Draft Loss",
    element: "useCollabDoc Teardown",
    proofImage: "adv-03-rapid-navigation-draft-race.png",
    codeRef: "client/src/hooks/useCollabDoc.ts:258",
    relatedFiles: ["client/src/hooks/useCollabDoc.ts", "client/src/hooks/useCollabDoc.test.tsx"],
    symptom: "Typing keystrokes and immediately navigating away (< 150ms) risks dropping unpersisted tail keystrokes upon component unmount.",
    rootCause: "In useCollabDoc.ts:258-270, unmounting invoked provider?.destroy() synchronously, closing the WebSocket (webSocket.close()) and clearing messageQueue = [] before outbound CRDT updates synced.",
    remediation: "On unmount, invoke provider.flushPendingUpdates?.(). If provider.hasUnsyncedChanges is true, clear awareness but defer provider.destroy() until onSynced fires or safety timeout (1000ms) elapses. Defer ydoc.destroy() correspondingly.",
    diff: `// useCollabDoc.ts:258
  return () => {
    cancelled = true
    if (retry) clearTimeout(retry)
    setAwareness(null)
+   if (provider) {
+     provider.flushPendingUpdates?.()
+     if (provider.hasUnsyncedChanges) {
+       const active = provider
+       const timer = setTimeout(() => active.destroy(), 1500)
+       active.on('synced', () => { clearTimeout(timer); active.destroy() })
+     } else {
+       provider.destroy()
+     }
+   }
  }`,
    verification: "Add unit test in useCollabDoc.test.tsx asserting that unmounting with hasUnsyncedChanges: true flushes pending updates and defers destroy until synced."
  },
  {
    id: "DEF-17",
    batch: "Batch C",
    subsystem: "Editor Drag-and-Drop",
    severity: "HIGH",
    title: "PDF File Drop Image Tag Generation",
    element: "imageDecorations Drop Handler",
    proofImage: "adv-13-pdf-drop-handling.png",
    codeRef: "client/src/hooks/imageDecorations.ts:138",
    relatedFiles: ["client/src/hooks/imageDecorations.ts", "client/src/hooks/imageDecorations.test.ts"],
    symptom: "Dropping a PDF document inserts ![name](...pdf) image markdown syntax, causing browsers to render broken <img> tags with 'Image not found' error widgets.",
    rootCause: "uploadAndInsertImage unconditionally prefixed markdown links with '!', treating all dropped files as image assets.",
    remediation: "Inspect MIME type and extension; only add '!' prefix for image assets (png|jpg|webp|svg|gif). For PDFs and other documents, generate standard clickable [name.pdf](url) markdown links.",
    diff: `// imageDecorations.ts:122, 138
+ const isImage = (file instanceof File && file.type.startsWith('image/')) ||
+   /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
+ const prefix = isImage ? '!' : ''
- const placeholder = \`![Uploading \${name}...]()\`
+ const placeholder = \`\${prefix}[Uploading \${name}...]()\`
...
- insert: \`![\${name}](/api/vaults/\${...})\`
+ insert: \`\${prefix}[\${name}](/api/vaults/\${...})\``,
    verification: "Run imageDecorations.test.ts; verify that dropping PDF inserts [document.pdf](...) and does not mount an ImageWidget."
  },
  {
    id: "DEF-12",
    batch: "Batch C",
    subsystem: "CodeMirror Autocomplete",
    severity: "MEDIUM",
    title: "Wikilink Autocomplete Dropdown Bounds Clipping",
    element: "useCodeMirrorEditor Autocomplete Facet",
    proofImage: "53-editor-wikilink-autocomplete.png",
    codeRef: "client/src/hooks/useCodeMirrorEditor.ts:164",
    relatedFiles: ["client/src/hooks/useCodeMirrorEditor.ts", "client/src/hooks/useCodeMirrorEditor.test.tsx"],
    symptom: "Wikilink completion dropdown renders off-screen or clips container boundaries when typing '[[' near the bottom of the editor.",
    rootCause: "CodeMirror defaults to calculating tooltip space against the full browser window (windowSpace) rather than the editor's scroll container bounds.",
    remediation: "Configure tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() }) from @codemirror/view and add maxHeight: 260px on .cm-tooltip-autocomplete.",
    diff: `// useCodeMirrorEditor.ts:164
+ tooltips({
+   tooltipSpace: (view) => {
+     const rect = view.scrollDOM.getBoundingClientRect()
+     return { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right }
+   },
+ }),
  autocompletion({ override: [wikilinkCompletions(wikilinkTargets)] }),`,
    verification: "Type '[[' on the last visible line of editor; verify dropdown flips upward above the cursor (.cm-tooltip-above) and does not extend beyond container."
  },
  {
    id: "DEF-14",
    batch: "Batch C",
    subsystem: "Accessibility (a11y)",
    severity: "MEDIUM",
    title: "Icon-Only Buttons Lacking Accessible Names (aria-label)",
    element: "ExpandableSearch & Toolbar Buttons",
    proofImage: "adv-10-a11y-axe-violations-overlay.png",
    codeRef: "client/src/components/shell/ExpandableSearch.tsx:78",
    relatedFiles: ["client/src/components/shell/ExpandableSearch.tsx", "client/src/components/vault/NoteRichToolbar.tsx"],
    symptom: "Automated a11y DOM audit (adv-10) highlighted buttons announcing generic 'button' without discernible text names.",
    rootCause: "ExpandableSearch.tsx wrapped <Kbd aria-hidden=\"true\">, stripping all accessible text; certain toolbar triggers lacked explicit labels.",
    remediation: "Add aria-label=\"Open command palette\" and title to the search shortcut trigger. Audit all icon-only toolbar buttons to guarantee 100% axe compliance.",
    diff: `// ExpandableSearch.tsx:78
  <button
    type="button"
    onClick={() => shell.openPalette()}
+   aria-label="Open command palette"
+   title="Open command palette"
    className="..."
  >
    <Kbd aria-hidden="true">{MOD_KEY_LABEL} K</Kbd>
  </button>`,
    verification: "Run axe audit test suite (npm --prefix client test axe.test.tsx); confirm zero button-name rule violations."
  },
  {
    id: "DEF-19",
    batch: "Batch C",
    subsystem: "FileTree & Hierarchy",
    severity: "MEDIUM",
    title: "Unconstrained Deep FileTree Horizontal Overflow",
    element: "FileTree Sidebar Navigation",
    proofImage: "adv-06-deep-hierarchy-filetree.png",
    codeRef: "client/src/components/vault/FileTree.tsx:40",
    relatedFiles: ["client/src/components/vault/FileTree.tsx", "client/src/pages/vault/VaultLayout.tsx:92"],
    symptom: "Deeply nested folder structures (6+ levels) clip titles abruptly in the 240px sidebar without horizontal scrolling or tooltips.",
    rootCause: "Sidebar container was hardcoded to vertical-only overflow (overflow-y-auto), and tree links lacked title attributes.",
    remediation: "Add title={note.path ? `${note.name} (${note.path})` : note.name} to NavLink and title={type} to Eyebrow. Update container to overflow-y-auto overflow-x-auto scrollbar-thin with min-w-full w-max on <nav>.",
    diff: `// FileTree.tsx:40
  <NavLink
    to={\`/vaults/\${vaultId}/notes/\${note.path}\`}
+   title={note.path ? \`\${note.name} (\${note.path})\` : note.name}
    className={...}
  >

// VaultLayout.tsx:92
- <div className="min-h-0 flex-1 overflow-y-auto p-2">
+ <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto p-2 scrollbar-thin">`,
    verification: "Create a 10-level nested hierarchy; verify hovering displays full path tooltip and container allows smooth horizontal scrolling."
  },
  {
    id: "DEF-11",
    batch: "Batch D",
    subsystem: "Graph Visualizer & Tools",
    severity: "MEDIUM",
    title: "Concept Pathfinding UI Unexposed in Graph Visualizer",
    element: "GraphCanvas Top Controls & Rail",
    proofImage: "24-graph-controls-zoom-fit.png",
    codeRef: "client/src/components/graph/GraphCanvas.tsx:600",
    relatedFiles: ["client/src/components/graph/GraphCanvas.tsx", "client/src/components/graph/GraphPathfinder.tsx"],
    symptom: "Dijkstra pathfinding backend tool (find_graph_path) and GraphPathfinder.tsx UI are hidden when viewing aggregated graphs or collapsed rail.",
    rootCause: "memberGraph evaluates to null on community graphs, hiding both rail button and inspector section; top action bar lacked a direct pathfinder trigger.",
    remediation: "Add direct 'Pathfinder' button with Route icon in canvas top action bar. Keep rail button permanently visible. Render full interactive pathfinder for member graphs or guidance state for un-drilled community clusters.",
    diff: `// GraphCanvas.tsx:600
  <div className={cn('pointer-events-auto absolute top-2.5 z-30 flex items-center gap-2 ...')}>
    {leadControl}
    <ColorModeToggle />
+   <Button
+     type="button"
+     variant="outline"
+     size="sm"
+     aria-label="Open Pathfinder"
+     onClick={() => { shell?.setPanelOpen('inspector', true); setPathfinderOpen(true) }}
+     className="h-8 gap-1.5 rounded-[var(--radius-md,4px)] border border-border bg-card/90 px-2.5 text-xs text-muted-foreground shadow-floating hover:bg-muted hover:text-foreground"
+   >
+     <Route className="size-3.5" aria-hidden="true" />
+     <span className="hidden sm:inline">Pathfinder</span>
+   </Button>
  </div>`,
    verification: "Click Pathfinder button in top controls; confirm Inspector opens directly to the Pathfinder section and path highlights on canvas."
  },
  {
    id: "DEF-13",
    batch: "Batch D",
    subsystem: "Vault Lifecycle & Safety",
    severity: "MEDIUM",
    title: "Missing Confirmation Guard on Vault Deletion",
    element: "VaultSettingsModal & VaultActions",
    proofImage: "46-vault-settings-modal-danger.png",
    codeRef: "client/src/components/vault/VaultSettingsModal.tsx:122",
    relatedFiles: ["client/src/components/vault/VaultSettingsModal.tsx", "client/src/components/shell/VaultActions.tsx"],
    symptom: "Vault settings modal lacked a Danger Zone, and inline row actions deleted vaults upon a single button click without typed title confirmation.",
    rootCause: "Deletion operations did not enforce typed confirmation of the vault name before unlocking destructive delete mutations.",
    remediation: "Add Danger Zone to VaultSettingsModal.tsx and guard inline delete with an input requiring the user to type the exact vault name (typedName === vault.name) before unlocking the Delete button.",
    diff: `// VaultSettingsModal.tsx
+ {vault.access === 'owner' && (
+   <section className="flex flex-col gap-2 border-t border-destructive/20 pt-3">
+     <h3 className="font-display text-base text-destructive">Danger zone</h3>
+     <p className="text-xs text-muted-foreground">Move this vault to trash...</p>
+     {confirmDelete ? (
+       <div className="flex flex-col gap-2 rounded border border-destructive/40 bg-destructive/5 p-2.5">
+         <p className="text-xs">To confirm, type <span className="font-mono font-bold">{vault.name}</span>:</p>
+         <Input value={typedName} onChange={(e) => setTypedName(e.target.value)} ... />
+         <Button variant="destructive" disabled={typedName !== vault.name} onClick={handleDelete}>Delete this vault</Button>
+       </div>
+     ) : (
+       <Button variant="destructive" size="xs" onClick={() => setConfirmDelete(true)}>Delete vault…</Button>
+     )}
+   </section>
+ )}`,
    verification: "Open Vault Settings > Danger zone; verify Delete button is disabled until exact vault title is typed into confirmation input."
  },
  {
    id: "DEF-15",
    batch: "Batch D",
    subsystem: "Vault Notes Browser",
    severity: "POLISH",
    title: "Tag Filter Empty State in Vault Browser",
    element: "VaultNotesPage Empty State",
    proofImage: "40-vault-notes-tag-filtering.png",
    codeRef: "client/src/pages/vault/VaultNotesPage.tsx:513",
    relatedFiles: ["client/src/pages/vault/VaultNotesPage.tsx", "client/src/pages/vault/VaultNotesPage.test.tsx"],
    symptom: "Filtering by a tag or search term with zero matches rendered a plain text box with no standard empty-state graphics, icon, or dedicated clear button.",
    rootCause: "Zero-result state was not connected to PanelState, and tag filtering was not exposed in the visual filter toolbar.",
    remediation: "Add frontmatter tag aggregation and dropdown in toolbar. Replace plain text box with PanelState (status=\"empty\", specific message e.g. 'No notes matched tag #xyz', and 'Clear filters' action button).",
    diff: `// VaultNotesPage.tsx:513
- <div className="p-8 text-center flex flex-col items-center gap-2">
-   <p className="text-sm text-muted-foreground">No notes match the current filter.</p>
-   {hasActiveFilters && <Button onClick={clearFilters}>Clear filters</Button>}
- </div>
+ <PanelState
+   status="empty"
+   title="No matching notes"
+   message={tagFilter !== 'all' ? \`No notes match tag #\${tagFilter}.\` : 'No notes match the current filter.'}
+   action={hasActiveFilters ? <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
+ />`,
    verification: "Select a tag filter that yields 0 notes; verify styled PanelState renders with 'Clear filters' action button which restores full list on click."
  },
  {
    id: "DEF-10",
    batch: "Batch D",
    subsystem: "Radix UI & Event Normalization",
    severity: "MEDIUM",
    title: "Synthetic Click Event Failure on Radix UI Tabs",
    element: "TabsTrigger Component Wrapper",
    proofImage: "flow-01-admin-overview-tab.png",
    codeRef: "client/src/components/ui/tabs.tsx:23",
    relatedFiles: ["client/src/components/ui/tabs.tsx", "client/src/components/ui/tabs.test.tsx"],
    symptom: "Radix UI Tabs ignore synthetic JavaScript .click() and assistive touch events because Radix only binds onMouseDown, onKeyDown, and onFocus.",
    rootCause: "Radix UI's TabsTrigger lacks an onClick listener, ignoring any click events not preceded by hardware mousedown.",
    remediation: "In Chapters' shared TabsTrigger wrapper, attach an onClick handler that checks if data-state !== 'active'; if not, dispatches mousedown to activate the tab, providing universal compatibility for assistive devices and automated test suites.",
    diff: `// tabs.tsx:23
  function TabsTrigger({ className, onClick, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
    return (
      <TabsPrimitive.Trigger
        data-slot="tabs-trigger"
        className={cn(...)}
+       onClick={(e) => {
+         onClick?.(e)
+         if (!e.defaultPrevented && e.currentTarget.getAttribute('data-state') !== 'active') {
+           e.currentTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
+         }
+       }}
        {...props}
      />
    )
  }`,
    verification: "Create tabs.test.tsx asserting that invoking element.click() or fireEvent.click() on a TabsTrigger switches the active tab."
  }
];

const htmlContent = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chapters — Defect Remediation & Implementation Roadmap</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #070A0F;
      --bg-surface: #0E1420;
      --bg-surface-elevated: #151D2F;
      --bg-card: #1A243B;
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(56, 189, 248, 0.3);
      --text: #F1F5F9;
      --text-muted: #94A3B8;
      --text-dim: #64748B;
      --cyan: #38BDF8;
      --indigo: #6366F1;
      --purple: #A855F7;
      --emerald: #10B981;
      --amber: #F59E0B;
      --rose: #F43F5E;
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    body::before {
      content: "";
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: radial-gradient(circle at 50% 10%, rgba(99, 102, 241, 0.08), transparent 40%),
                  radial-gradient(circle at 90% 80%, rgba(56, 189, 248, 0.05), transparent 40%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      max-width: 1680px;
      margin: 0 auto;
      padding: 0 2rem;
      position: relative;
      z-index: 1;
    }

    header {
      padding: 3rem 0 2rem 0;
      border-bottom: 1px solid var(--border);
    }
    .badge-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: rgba(16, 185, 129, 0.1);
      color: var(--emerald);
      border: 1px solid rgba(16, 185, 129, 0.25);
    }
    .pulse-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 10px var(--emerald);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.2); }
      100% { opacity: 1; transform: scale(1); }
    }

    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-top: 1rem;
      flex-wrap: wrap;
      gap: 1.5rem;
    }
    h1 {
      font-size: 2.25rem;
      font-weight: 800;
      letter-spacing: -0.025em;
      background: linear-gradient(135deg, #FFF 30%, var(--cyan) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: var(--text-muted);
      margin-top: 0.5rem;
      font-size: 1rem;
      max-width: 850px;
    }

    .meta-bar {
      display: flex;
      gap: 1.5rem;
      align-items: center;
      background: var(--bg-surface);
      padding: 0.75rem 1.25rem;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      font-size: 0.825rem;
      font-family: var(--font-mono);
      flex-wrap: wrap;
    }
    .meta-item { display: flex; align-items: center; gap: 0.5rem; color: var(--text-dim); }
    .meta-item strong { color: var(--text); }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 1.25rem;
      margin: 2rem 0;
    }
    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      padding: 1.5rem;
      border-radius: var(--radius-lg);
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s, transform 0.2s;
    }
    .kpi-card:hover {
      border-color: var(--border-accent);
      transform: translateY(-2px);
    }
    .kpi-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, var(--cyan), var(--indigo));
    }
    .kpi-val {
      font-size: 2.25rem;
      font-weight: 800;
      font-family: var(--font-mono);
      color: #FFF;
      margin: 0.25rem 0;
    }
    .kpi-label {
      font-size: 0.85rem;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }
    .kpi-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.5rem;
    }

    /* Main Navigation Tabs */
    .tab-nav {
      display: flex;
      gap: 0.5rem;
      border-bottom: 1px solid var(--border);
      margin-top: 1.5rem;
      overflow-x: auto;
    }
    .tab-btn {
      background: none;
      border: none;
      color: var(--text-dim);
      font-family: var(--font-sans);
      font-size: 0.95rem;
      font-weight: 600;
      padding: 0.75rem 1.25rem;
      cursor: pointer;
      position: relative;
      transition: color 0.15s;
      white-space: nowrap;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active {
      color: var(--cyan);
    }
    .tab-btn.active::after {
      content: "";
      position: absolute;
      bottom: -1px; left: 0; right: 0; height: 2px;
      background: var(--cyan);
      box-shadow: 0 0 8px var(--cyan);
    }

    /* Filters Bar */
    .filter-section {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 1.25rem;
      margin: 1.5rem 0;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .filter-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .search-box {
      position: relative;
      flex: 1;
      min-width: 280px;
    }
    .search-input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 0.6rem 1rem 0.6rem 2.5rem;
      font-size: 0.875rem;
      color: var(--text);
      font-family: var(--font-sans);
      outline: none;
      transition: border-color 0.15s;
    }
    .search-input:focus { border-color: var(--cyan); }
    .search-icon {
      position: absolute;
      left: 0.85rem; top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      pointer-events: none;
    }

    .pill-group {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    .filter-pill {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.4rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.775rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .filter-pill:hover {
      color: var(--text);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .filter-pill.active {
      background: rgba(56, 189, 248, 0.12);
      color: var(--cyan);
      border-color: var(--cyan);
      font-weight: 600;
    }

    /* Defect Matrix Cards */
    .defect-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin: 1.5rem 0 3rem 0;
    }
    .defect-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 1.25rem 1.5rem;
      transition: border-color 0.2s, background-color 0.2s;
    }
    .defect-card:hover {
      border-color: rgba(255, 255, 255, 0.16);
    }
    .defect-card.completed {
      opacity: 0.75;
      border-color: rgba(16, 185, 129, 0.2);
    }

    .defect-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      cursor: pointer;
      user-select: none;
    }
    .defect-title-area {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      flex: 1;
    }
    .check-box-wrapper {
      padding-top: 0.25rem;
    }
    .item-checkbox {
      appearance: none;
      width: 20px; height: 20px;
      border: 2px solid var(--text-dim);
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      display: grid;
      place-content: center;
      transition: all 0.15s;
    }
    .item-checkbox:checked {
      background: var(--emerald);
      border-color: var(--emerald);
    }
    .item-checkbox:checked::before {
      content: "✓";
      color: #000;
      font-size: 13px;
      font-weight: 900;
    }

    .defect-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .badge {
      font-size: 0.7rem;
      padding: 0.2rem 0.55rem;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-weight: 700;
      text-transform: uppercase;
    }
    .badge-id { background: rgba(99, 102, 241, 0.15); color: #818CF8; border: 1px solid rgba(99, 102, 241, 0.3); }
    .badge-high { background: rgba(244, 63, 94, 0.15); color: #FDA4AF; border: 1px solid rgba(244, 63, 94, 0.3); }
    .badge-medium { background: rgba(245, 158, 11, 0.15); color: #FCD34D; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-polish { background: rgba(56, 189, 248, 0.15); color: #BAE6FD; border: 1px solid rgba(56, 189, 248, 0.3); }
    .badge-batch { background: rgba(255, 255, 255, 0.06); color: var(--text-muted); border: 1px solid var(--border); }

    .defect-desc {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-top: 0.4rem;
    }

    .toggle-icon {
      font-size: 1.25rem;
      color: var(--text-dim);
      transition: transform 0.2s;
    }
    .defect-card.expanded .toggle-icon {
      transform: rotate(180deg);
      color: var(--cyan);
    }

    /* Expandable Body */
    .defect-body {
      display: none;
      margin-top: 1.25rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--border);
      animation: fadeIn 0.15s ease-out;
    }
    .defect-card.expanded .defect-body {
      display: block;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }
    .detail-box {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 1rem 1.25rem;
    }
    .detail-box h4 {
      font-size: 0.8rem;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .detail-box p {
      font-size: 0.875rem;
      color: var(--text);
      line-height: 1.6;
    }

    .code-preview {
      background: #04060A;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 1rem;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: #E2E8F0;
      overflow-x: auto;
      margin: 0.75rem 0;
      line-height: 1.6;
    }
    .code-preview pre { margin: 0; }
    .code-del { color: #F87171; background: rgba(248, 113, 113, 0.1); display: block; }
    .code-add { color: #34D399; background: rgba(52, 211, 153, 0.1); display: block; }
    .code-comment { color: #64748B; font-style: italic; }

    .proof-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 1rem;
      padding: 0.75rem 1rem;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      font-size: 0.825rem;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .proof-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: var(--cyan);
      padding: 0.35rem 0.75rem;
      border-radius: 4px;
      font-size: 0.775rem;
      font-family: var(--font-mono);
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s;
    }
    .proof-btn:hover { background: rgba(56, 189, 248, 0.2); }

    /* Architecture & Roadmap View */
    .roadmap-view, .arch-view {
      display: none;
      margin: 2rem 0;
    }
    .roadmap-view.active, .arch-view.active {
      display: block;
    }

    .phase-timeline {
      display: flex;
      flex-direction: column;
      gap: 2rem;
      position: relative;
      margin-left: 1.5rem;
      padding-left: 2rem;
      border-left: 2px solid var(--border);
    }
    .phase-node {
      position: relative;
    }
    .phase-node::before {
      content: "";
      position: absolute;
      left: -2.6rem; top: 0.2rem;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--bg);
      border: 3px solid var(--cyan);
      box-shadow: 0 0 10px var(--cyan);
    }
    .phase-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 1.5rem;
    }
    .phase-card h3 {
      font-size: 1.25rem;
      font-weight: 700;
      color: #FFF;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .phase-card p {
      color: var(--text-muted);
      margin: 0.5rem 0 1rem 0;
      font-size: 0.925rem;
    }
    .item-tags {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    /* Lightbox Modal */
    .lightbox-modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.88);
      backdrop-filter: blur(8px);
      z-index: 9999;
      justify-content: center;
      align-items: center;
      padding: 2rem;
    }
    .lightbox-modal.active { display: flex; }
    .lightbox-content {
      max-width: 90vw;
      max-height: 90vh;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    }
    .lightbox-header {
      padding: 0.85rem 1.25rem;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .lightbox-img-wrap {
      overflow: auto;
      background: #000;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 1rem;
    }
    .lightbox-img-wrap img {
      max-width: 100%;
      max-height: 80vh;
      object-fit: contain;
      border-radius: 4px;
      border: 1px solid var(--border);
    }
    .close-btn {
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 1.5rem;
      cursor: pointer;
      line-height: 1;
    }
    .close-btn:hover { color: #FFF; }

    footer {
      border-top: 1px solid var(--border);
      padding: 2.5rem 0;
      margin-top: 4rem;
      color: var(--text-dim);
      font-size: 0.825rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }

    @media (max-width: 768px) {
      .container { padding: 0 1rem; }
      h1 { font-size: 1.75rem; }
      .detail-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <div class="container">
    <header>
      <div class="badge-pill">
        <span class="pulse-dot"></span>
        <span>Remediation Roadmap — 100% Approved</span>
      </div>
      <div class="title-row">
        <div>
          <h1>Defect Remediation & Implementation Roadmap</h1>
          <p class="subtitle">Architectural root-cause remediation plans for all 20 findings across Chapters platform visual, behavioral, concurrency, and accessibility audit suites.</p>
        </div>
        <div class="meta-bar">
          <div class="meta-item">Branch: <strong>dev</strong></div>
          <div class="meta-item">Status: <strong>Approved for Execution</strong></div>
          <div class="meta-item">Tests: <strong>889 Passing Baseline</strong></div>
          <div class="meta-item">Bundle: <strong>&lt; 300KB Budget Guarded</strong></div>
        </div>
      </div>
    </header>

    <!-- KPI Metric Cards -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Total Cataloged Defects</div>
        <div class="kpi-val" id="kpi-total">20</div>
        <div class="kpi-desc">Covering visual collisions, a11y, soft keyboards, CRDT sync, and APIs</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Remediation Batches</div>
        <div class="kpi-val">4</div>
        <div class="kpi-desc">A (Shell & Mobile), B (Data & Backends), C (Editor & Files), D (Graph & Polish)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Implementation Status</div>
        <div class="kpi-val" id="kpi-progress">0 / 20</div>
        <div class="kpi-desc" id="kpi-progress-desc">Track and mark checklist items live in your browser</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Architecture Rule</div>
        <div class="kpi-val" style="font-size: 1.35rem; line-height: 1.8;">Ponytail Dev</div>
        <div class="kpi-desc">Root-cause fixes over symptoms, zero bloat, shortest working diffs</div>
      </div>
    </div>

    <!-- Navigation Tabs -->
    <div class="tab-nav">
      <button class="tab-btn active" onclick="switchMainTab('matrix')">Defect Remediation Matrix (20)</button>
      <button class="tab-btn" onclick="switchMainTab('roadmap')">Execution Roadmap & Dependency Graph</button>
      <button class="tab-btn" onclick="switchMainTab('architecture')">Architecture & Verification Guardrails</button>
    </div>

    <!-- TAB 1: DEFECT MATRIX -->
    <div id="tab-matrix" class="tab-pane">
      <div class="filter-section">
        <div class="filter-row">
          <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="searchInput" class="search-input" placeholder="Search defects, symbols, code files, symptoms..." oninput="filterDefects()">
          </div>
          <div class="pill-group">
            <span style="font-size: 0.75rem; color: var(--text-dim); align-self: center; margin-right: 0.25rem;">BATCH:</span>
            <button class="filter-pill active" onclick="setBatchFilter('all', this)">All</button>
            <button class="filter-pill" onclick="setBatchFilter('Batch A', this)">Batch A (Shell & Mobile)</button>
            <button class="filter-pill" onclick="setBatchFilter('Batch B', this)">Batch B (Data & Sync)</button>
            <button class="filter-pill" onclick="setBatchFilter('Batch C', this)">Batch C (Editor & Files)</button>
            <button class="filter-pill" onclick="setBatchFilter('Batch D', this)">Batch D (Graph & Polish)</button>
          </div>
        </div>
        <div class="filter-row" style="padding-top: 0.5rem; border-top: 1px solid rgba(255,255,255,0.04);">
          <div class="pill-group">
            <span style="font-size: 0.75rem; color: var(--text-dim); align-self: center; margin-right: 0.25rem;">SEVERITY:</span>
            <button class="filter-pill active" onclick="setSeverityFilter('all', this)">All Severities</button>
            <button class="filter-pill" onclick="setSeverityFilter('HIGH', this)">High Severity</button>
            <button class="filter-pill" onclick="setSeverityFilter('MEDIUM', this)">Medium Severity</button>
            <button class="filter-pill" onclick="setSeverityFilter('POLISH', this)">Polish & Ergonomics</button>
          </div>
          <div style="font-size: 0.8rem; color: var(--text-dim);">
            Showing <strong id="visibleCount" style="color: var(--cyan);">20</strong> of 20 defects
          </div>
        </div>
      </div>

      <!-- Defect Cards List -->
      <div class="defect-list" id="defectList">
        <!-- Rendered via JS below -->
      </div>
    </div>

    <!-- TAB 2: ROADMAP & DEPENDENCY GRAPH -->
    <div id="tab-roadmap" class="roadmap-view">
      <div class="phase-timeline">
        <div class="phase-node">
          <div class="phase-card">
            <h3>Stage 1: Foundation — Shell, Rail & Mobile Geometry (Batch A)</h3>
            <p>Remediates fundamental layout collisions and mobile touch ergonomics. Establishes the 72px / 20px content clearance standard, isolates floating rail states, and applies invisible 44px touch targets across all mobile buttons.</p>
            <div class="item-tags">
              <span class="badge badge-id">DEF-01</span>
              <span class="badge badge-id">DEF-02</span>
              <span class="badge badge-id">DEF-03</span>
              <span class="badge badge-id">DEF-08</span>
              <span class="badge badge-id">DEF-09</span>
              <span class="badge badge-id">DEF-16</span>
              <span class="badge badge-id">DEF-18</span>
            </div>
          </div>
        </div>

        <div class="phase-node">
          <div class="phase-card">
            <h3>Stage 2: Core Data Integrity, Sync & Auth (Batch B)</h3>
            <p>Hardens data persistence and developer tooling. Eliminates WebSocket teardown draft drops on rapid note navigation, joins user rosters for repository shares, provides on-demand QR code generation for MFA, and finishes mock server revision diffing.</p>
            <div class="item-tags">
              <span class="badge badge-id">DEF-04</span>
              <span class="badge badge-id">DEF-05</span>
              <span class="badge badge-id">DEF-06</span>
              <span class="badge badge-id">DEF-07</span>
              <span class="badge badge-id">DEF-20</span>
            </div>
          </div>
        </div>

        <div class="phase-node">
          <div class="phase-card">
            <h3>Stage 3: Editor Experience & File Ergonomics (Batch C)</h3>
            <p>Polishes the CodeMirror 6 markdown workspace. Fixes document link formatting for dropped PDFs, bounds autocomplete tooltips within scroll containers, guarantees 100% accessible button names, and enables horizontal hierarchy navigation.</p>
            <div class="item-tags">
              <span class="badge badge-id">DEF-17</span>
              <span class="badge badge-id">DEF-12</span>
              <span class="badge badge-id">DEF-14</span>
              <span class="badge badge-id">DEF-19</span>
            </div>
          </div>
        </div>

        <div class="phase-node">
          <div class="phase-card">
            <h3>Stage 4: Knowledge Graph, Safety & Platform Polish (Batch D)</h3>
            <p>Exposes concept pathfinding directly on the knowledge graph canvas, guards destructive vault deletion with exact title confirmation, provides informative tag filter empty states, and normalizes synthetic click events on Radix UI tabs.</p>
            <div class="item-tags">
              <span class="badge badge-id">DEF-11</span>
              <span class="badge badge-id">DEF-13</span>
              <span class="badge badge-id">DEF-15</span>
              <span class="badge badge-id">DEF-10</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 3: ARCHITECTURE & VERIFICATION GUARDRAILS -->
    <div id="tab-architecture" class="arch-view">
      <div class="detail-grid" style="grid-template-columns: 1fr 1fr;">
        <div class="detail-box">
          <h4>⚡ Bundle Budget Guardrail (&lt; 300KB)</h4>
          <p>Chapters enforces a strict 300KB gzipped initial chunk budget in <code>client/src/bundle.test.ts</code>. Heavy dependencies (e.g. <code>qrcode</code>, canvas graph modules) are loaded dynamically via <code>await import(...)</code> on demand, ensuring zero byte penalty to initial page load.</p>
        </div>
        <div class="detail-box">
          <h4>🔄 CRDT Persistence & Graceful Flush</h4>
          <p>Realtime document synchronization relies on Yjs binary updates streamed through <code>HocuspocusProvider</code>. Fast unmounts flush buffered document edits and hold socket teardown until <code>hasUnsyncedChanges</code> resolves or safety timer expires, preventing tail keystroke loss.</p>
        </div>
        <div class="detail-box">
          <h4>📱 Mobile Touch Targets & Keyboard Standards</h4>
          <p>Tactile button sizes are elevated to the WCAG 2.5.5 standard (44x44px) using invisible pseudo-element expansion (<code>after:min-w-[44px] after:min-h-[44px]</code>) without altering desktop compact visual density. Mobile viewport resizing conforms to <code>interactive-widget=resizes-content</code>.</p>
        </div>
        <div class="detail-box">
          <h4>🧪 Testing & Verification Protocol</h4>
          <p>Every non-trivial fix leaves one runnable unit test behind in Vitest. No PR or commit is merged without passing all 889 existing tests, automated axe accessibility audits, and bundle threshold checks.</p>
        </div>
      </div>
    </div>

    <footer>
      <div>Chapters Audit Remediation Suite · Prepared for PIIX-org/chapters</div>
      <div style="font-family: var(--font-mono);">Document Generated: 2026-10-01</div>
    </footer>
  </div>

  <!-- Lightbox Modal -->
  <div id="lightbox" class="lightbox-modal" onclick="closeLightbox(event)">
    <div class="lightbox-content" onclick="event.stopPropagation()">
      <div class="lightbox-header">
        <span id="lightbox-title">Proof Screenshot</span>
        <button class="close-btn" onclick="closeLightbox()">&times;</button>
      </div>
      <div class="lightbox-img-wrap">
        <img id="lightbox-img" src="" alt="Proof capture">
      </div>
    </div>
  </div>

  <script>
    const defectsData = ${JSON.stringify(defects, null, 2)};

    let currentBatchFilter = 'all';
    let currentSeverityFilter = 'all';
    let searchQuery = '';

    // Storage for completed checklist
    const completedSet = new Set(JSON.parse(localStorage.getItem('chapters_remediation_completed') || '[]'));

    function renderDefects() {
      const container = document.getElementById('defectList');
      container.innerHTML = '';

      let visible = 0;

      defectsData.forEach(d => {
        const matchesBatch = currentBatchFilter === 'all' || d.batch === currentBatchFilter;
        const matchesSev = currentSeverityFilter === 'all' || d.severity === currentSeverityFilter;
        const q = searchQuery.toLowerCase();
        const matchesSearch = !q || 
          d.id.toLowerCase().includes(q) ||
          d.title.toLowerCase().includes(q) ||
          d.subsystem.toLowerCase().includes(q) ||
          d.codeRef.toLowerCase().includes(q) ||
          d.symptom.toLowerCase().includes(q) ||
          d.remediation.toLowerCase().includes(q);

        if (!matchesBatch || !matchesSev || !matchesSearch) return;

        visible++;
        const isDone = completedSet.has(d.id);

        const card = document.createElement('div');
        card.className = \`defect-card \${isDone ? 'completed' : ''}\`;
        card.id = \`card-\${d.id}\`;

        let sevBadgeClass = 'badge-medium';
        if (d.severity === 'HIGH') sevBadgeClass = 'badge-high';
        if (d.severity === 'POLISH') sevBadgeClass = 'badge-polish';

        // Format diff code
        const formattedDiff = d.diff
          .split('\\n')
          .map(line => {
            if (line.startsWith('+')) return \`<span class="code-add">\${escapeHtml(line)}</span>\`;
            if (line.startsWith('-')) return \`<span class="code-del">\${escapeHtml(line)}</span>\`;
            if (line.startsWith('//')) return \`<span class="code-comment">\${escapeHtml(line)}</span>\`;
            return escapeHtml(line);
          })
          .join('\\n');

        card.innerHTML = \`
          <div class="defect-header" onclick="toggleCard('\${d.id}')">
            <div class="defect-title-area">
              <div class="check-box-wrapper" onclick="event.stopPropagation()">
                <input type="checkbox" class="item-checkbox" id="chk-\${d.id}" \${isDone ? 'checked' : ''} onchange="toggleDone('\${d.id}', this.checked)" title="Mark as implemented">
              </div>
              <div>
                <div class="defect-title">
                  <span class="badge badge-id">\${d.id}</span>
                  <span>\${escapeHtml(d.title)}</span>
                  <span class="badge \${sevBadgeClass}">\${d.severity}</span>
                  <span class="badge badge-batch">\${d.batch}</span>
                </div>
                <div class="defect-desc">\${escapeHtml(d.symptom)}</div>
              </div>
            </div>
            <div class="toggle-icon">▼</div>
          </div>

          <div class="defect-body">
            <div class="detail-grid">
              <div class="detail-box">
                <h4>🔍 Root Cause Analysis</h4>
                <p>\${escapeHtml(d.rootCause)}</p>
              </div>
              <div class="detail-box">
                <h4>🛠️ Architectural Remediation Plan</h4>
                <p>\${escapeHtml(d.remediation)}</p>
              </div>
            </div>

            <div class="detail-box">
              <h4>📝 Planned Code Modification (Shortest Working Diff)</h4>
              <div class="code-preview"><pre>\${formattedDiff}</pre></div>
            </div>

            <div class="proof-row">
              <div>
                <span style="color: var(--text-dim); font-family: var(--font-mono);">Primary Target: </span>
                <code style="color: var(--cyan); font-size: 0.85rem;">\${escapeHtml(d.codeRef)}</code>
              </div>
              <button class="proof-btn" onclick="openLightbox('\${d.proofImage}', '\${d.id}: \${escapeHtml(d.title)}')">
                🖼️ View Proof Screenshot (\${d.proofImage})
              </button>
            </div>
            <div style="margin-top: 0.75rem; font-size: 0.825rem; color: var(--text-muted);">
              <strong>Verification Criteria: </strong>\${escapeHtml(d.verification)}
            </div>
          </div>
        \`;

        container.appendChild(card);
      });

      document.getElementById('visibleCount').textContent = visible;
      updateProgress();
    }

    function toggleCard(id) {
      const card = document.getElementById(\`card-\${id}\`);
      if (card) card.classList.toggle('expanded');
    }

    function toggleDone(id, isDone) {
      if (isDone) completedSet.add(id);
      else completedSet.delete(id);
      localStorage.setItem('chapters_remediation_completed', JSON.stringify(Array.from(completedSet)));
      const card = document.getElementById(\`card-\${id}\`);
      if (card) {
        if (isDone) card.classList.add('completed');
        else card.classList.remove('completed');
      }
      updateProgress();
    }

    function updateProgress() {
      const count = completedSet.size;
      document.getElementById('kpi-progress').textContent = \`\${count} / 20\`;
      const pct = Math.round((count / 20) * 100);
      document.getElementById('kpi-progress-desc').textContent = \`\${pct}% of planned defect remediations verified\`;
    }

    function setBatchFilter(batch, btn) {
      currentBatchFilter = batch;
      document.querySelectorAll('.filter-section .filter-row:first-child .filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDefects();
    }

    function setSeverityFilter(sev, btn) {
      currentSeverityFilter = sev;
      document.querySelectorAll('.filter-section .filter-row:last-child .filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDefects();
    }

    function filterDefects() {
      searchQuery = document.getElementById('searchInput').value;
      renderDefects();
    }

    function switchMainTab(tab) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');

      document.getElementById('tab-matrix').style.display = tab === 'matrix' ? 'block' : 'none';
      document.getElementById('tab-roadmap').style.display = tab === 'roadmap' ? 'block' : 'none';
      document.getElementById('tab-architecture').style.display = tab === 'architecture' ? 'block' : 'none';
    }

    function openLightbox(filename, title) {
      const modal = document.getElementById('lightbox');
      const img = document.getElementById('lightbox-img');
      const titleElem = document.getElementById('lightbox-title');
      titleElem.textContent = title;
      img.src = \`./chapters-audit-media/\${filename}\`;
      modal.classList.add('active');
    }

    function closeLightbox(e) {
      document.getElementById('lightbox').classList.remove('active');
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });

    // Initialize
    renderDefects();
  </script>
</body>
</html>`;

fs.writeFileSync('docs/remediation-plan-report.html', htmlContent, 'utf8');
console.log('Successfully generated docs/remediation-plan-report.html with 20 defect remediations!');
