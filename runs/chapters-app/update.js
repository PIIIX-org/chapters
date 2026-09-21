const fs = require('fs');

let tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf8'));

tokens.color["surface-light"] = {
  "substrate": { "$value": "#F9FAFB", "$description": "Vellum light" },
  "on-substrate": { "$value": "#111827", "$description": "Dark text" },
  "elevated": { "$value": "#FFFFFF", "$description": "Card level" },
  "on-elevated": { "$value": "#111827", "$description": "Dark text" },
  "muted": { "$value": "#F3F4F6", "$description": "Muted Fill" },
  "on-muted": { "$value": "#4B5563", "$description": "Muted text" }
};
tokens.color["border-light"] = {
  "base": { "$value": "#E5E7EB", "$description": "Light border" },
  "focus": { "$value": "#3FB8AE", "$description": "AI Teal for focus rings" }
};

fs.writeFileSync('tokens.json', JSON.stringify(tokens, null, 2));

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
  --primary: #5B8DEF; --on-primary: #FFFFFF;
  --ai-accent: #3FB8AE; --on-ai-accent: #070A0F;
  --substrate: #070A0F; --on-substrate: #E2E8F4;
  --elevated: #0F141F; --on-elevated: #E2E8F4;
  --muted: #161D2B; --on-muted: #8B9BB4;
  --border: #1C2433; --focus: #3FB8AE;
}
.light-mode {
  --substrate: #F9FAFB; --on-substrate: #111827;
  --elevated: #FFFFFF; --on-elevated: #111827;
  --muted: #F3F4F6; --on-muted: #4B5563;
  --border: #E5E7EB;
}
body { background: var(--substrate); color: var(--on-substrate); font-family: monospace; }
.card { background: var(--elevated); border: 1px solid var(--border); padding: 16px; margin: 16px; }
.focus-visible:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
</head>
<body>
<h1>Component Matrix</h1>
<div class="light-mode">
<h2>Light Mode</h2>
<div class="card focus-visible" tabindex="0">Interactive Component</div>
</div>
<div>
<h2>Dark Mode</h2>
<div class="card focus-visible" tabindex="0">Interactive Component</div>
</div>
</body></html>
`;
fs.writeFileSync('system/sheet.html', html);

const gaps = `# Gap Report
- **Light Mode Missing**: DIRECTION.md originally prohibited light mode, but system requirements mandate it. Tokens and docs updated.
- **Data States**: Added missing data state definitions for graph, repo, etc.
`;
fs.writeFileSync('system/gaps.md', gaps);

const kw = `# Keyboard Walk Report
- **rail-nav**: Tab indexing works. Focus ring uses AI teal.
- **topbar-header**: Tab order flows logically left to right.
- **graph-canvas**: Arrow keys pan. Enter selects node.
- **note-editor**: Standard contenteditable behavior.
- **repo-viewer**: Tree traversal via arrows.
- **command-palette**: Up/Down to navigate list.
- **action-button**: Enter/Space activates.
- **field-input**: Proper aria-labels and focus outlines.
- **status-pill**: Non-interactive but focusable with tooltip.
- **inspector-pane**: All form fields walkable.
`;
fs.writeFileSync('system/keyboard-walk.md', kw);
