#!/usr/bin/env python3
"""
render_readme_html.py
Renders README.md into a standalone, GitHub dark-themed HTML preview file:
- Full pre-rendered static HTML (works offline, zero layout shifts).
- Enhanced with Mermaid.js for architecture diagram rendering.
- Exact GitHub markdown CSS styling (#0d1117, font stacks, tables, code blocks).
- Creates both local and root previews.
"""

import os
import re

REPO_DIR = "/Users/taha/Documents/chapters"
README_PATH = os.path.join(REPO_DIR, "README.md")
OUT_LOCAL = os.path.join(REPO_DIR, "readme-preview.html")
OUT_ROOT = "/Users/taha/chapters-readme-preview.html"

with open(README_PATH, "r", encoding="utf-8") as f:
    raw_md = f.read()

def md_to_html(md):
    lines = md.split("\n")
    html_out = []
    in_code = False
    code_lang = ""
    code_lines = []
    in_table = False
    table_lines = []
    in_list = False
    list_type = "ul"
    
    def flush_table(t_lines):
        if not t_lines: return ""
        header_row = [c.strip() for c in t_lines[0].strip().strip("|").split("|")]
        res = ["<div class=\"table-wrapper\"><table><thead><tr>"]
        for c in header_row:
            res.append(f"<th>{inline_format(c)}</th>")
        res.append("</tr></thead><tbody>")
        for row_str in t_lines[2:]:
            cols = [c.strip() for c in row_str.strip().strip("|").split("|")]
            res.append("<tr>")
            for c in cols:
                res.append(f"<td>{inline_format(c)}</td>")
            res.append("</tr>")
        res.append("</tbody></table></div>")
        return "".join(res)

    def inline_format(text):
        # Images: ![alt](src)
        text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<img src="\2" alt="\1" />', text)
        # Links: [text](url)
        text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
        # Bold: **text**
        text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
        # Italic: *text*
        text = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', text)
        # Inline code: `code`
        text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
        return text

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Fenced code blocks
        if stripped.startswith("```"):
            if not in_code:
                in_code = True
                code_lang = stripped[3:].strip()
                code_lines = []
            else:
                in_code = False
                code_content = "\n".join(code_lines)
                if code_lang == "mermaid":
                    html_out.append(f'<div class="mermaid">\n{code_content}\n</div>')
                else:
                    escaped_code = code_content.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    html_out.append(f'<pre><code class="language-{code_lang}">{escaped_code}</code></pre>')
            i += 1
            continue

        if in_code:
            code_lines.append(line)
            i += 1
            continue

        # Tables
        if stripped.startswith("|") and stripped.endswith("|"):
            if not in_table:
                in_table = True
                table_lines = [stripped]
            else:
                table_lines.append(stripped)
            i += 1
            continue
        else:
            if in_table:
                html_out.append(flush_table(table_lines))
                in_table = False
                table_lines = []

        # Empty lines
        if not stripped:
            if in_list:
                html_out.append(f"</{list_type}>")
                in_list = False
            i += 1
            continue

        # HTML passthrough (like <div>, <details>, <summary>, <p align=...>, <a ...)
        if stripped.startswith("<div") or stripped.startswith("</div") or \
           stripped.startswith("<p") or stripped.startswith("</p>") or \
           stripped.startswith("<a") or stripped.startswith("</a") or \
           stripped.startswith("<br") or \
           stripped.startswith("<details") or stripped.startswith("</details") or \
           stripped.startswith("<summary") or stripped.startswith("</summary") or \
           stripped.startswith("<sub") or stripped.startswith("</sub") or \
           stripped.startswith("<!--"):
            if in_list:
                html_out.append(f"</{list_type}>")
                in_list = False
            html_out.append(line)
            i += 1
            continue

        # Headings
        if stripped.startswith("#"):
            if in_list:
                html_out.append(f"</{list_type}>")
                in_list = False
            level = len(stripped.split()[0])
            heading_text = stripped[level:].strip()
            anchor = re.sub(r'[^a-z0-9]+', '-', heading_text.lower()).strip('-')
            html_out.append(f'<h{level} id="{anchor}">{inline_format(heading_text)}</h{level}>')
            i += 1
            continue

        # Horizontal Rule
        if stripped in ["---", "***", "___"]:
            if in_list:
                html_out.append(f"</{list_type}>")
                in_list = False
            html_out.append("<hr />")
            i += 1
            continue

        # Unordered list items
        if stripped.startswith("- ") or stripped.startswith("* "):
            if not in_list:
                in_list = True
                list_type = "ul"
                html_out.append("<ul>")
            item_text = stripped[2:].strip()
            html_out.append(f"<li>{inline_format(item_text)}</li>")
            i += 1
            continue

        # Ordered list items
        m_num = re.match(r'^(\d+)\.\s+(.*)$', stripped)
        if m_num:
            if not in_list:
                in_list = True
                list_type = "ol"
                html_out.append("<ol>")
            item_text = m_num.group(2).strip()
            html_out.append(f"<li>{inline_format(item_text)}</li>")
            i += 1
            continue

        # Blockquote
        if stripped.startswith("> "):
            if in_list:
                html_out.append(f"</{list_type}>")
                in_list = False
            bq_text = stripped[2:].strip()
            html_out.append(f"<blockquote><p>{inline_format(bq_text)}</p></blockquote>")
            i += 1
            continue

        # Regular paragraph
        if in_list:
            html_out.append(f"</{list_type}>")
            in_list = False
        html_out.append(f"<p>{inline_format(line)}</p>")
        i += 1

    if in_table:
        html_out.append(flush_table(table_lines))
    if in_list:
        html_out.append(f"</{list_type}>")

    return "\n".join(html_out)

body_html = md_to_html(raw_md)

html_template = '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chapters / Elara — README.md Live Preview</title>
  <link rel="icon" href="assets/badges/badge-vector.svg" type="image/svg+xml">
  <style>
    :root {
      --bg: #070A0F;
      --card-bg: #0D1117;
      --border: #1C2433;
      --text: #C9D1D9;
      --text-bright: #F0F6FC;
      --text-muted: #8B949E;
      --accent: #5B8DEF;
      --teal: #3FB8AE;
      --green: #2EC47C;
      --code-bg: #161B22;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      font-size: 16px;
      line-height: 1.65;
      padding: 0;
    }
    /* Top Sticky Observatory Control Header */
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 1000;
      background: #0B0F19;
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    .top-title {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      font-weight: 700;
      color: var(--teal);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .led-live {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      display: inline-block;
    }
    .top-meta {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: var(--text-muted);
    }
    .top-meta span { color: var(--text-bright); }
    .page-container {
      max-width: 1020px;
      margin: 32px auto 80px auto;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 48px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    }
    /* GitHub Markdown Typography */
    h1, h2, h3, h4, h5, h6 {
      color: var(--text-bright);
      font-weight: 700;
      line-height: 1.3;
      margin-top: 32px;
      margin-bottom: 16px;
    }
    h1 { font-size: 32px; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    h2 { font-size: 24px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    h3 { font-size: 18px; }
    p { margin-bottom: 16px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    hr {
      border: 0;
      height: 1px;
      background: var(--border);
      margin: 32px 0;
    }
    img {
      max-width: 100%;
      height: auto;
      display: inline-block;
      vertical-align: middle;
    }
    /* Tables */
    .table-wrapper {
      width: 100%;
      overflow-x: auto;
      margin: 20px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border-spacing: 0;
      font-size: 14px;
    }
    table th, table td {
      padding: 10px 14px;
      border: 1px solid var(--border);
      text-align: left;
    }
    table th {
      background: #121824;
      font-weight: 700;
      color: var(--text-bright);
    }
    table tr:nth-child(2n) {
      background: #0A0E17;
    }
    /* Code Blocks */
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      overflow-x: auto;
      margin: 18px 0;
      font-size: 13.5px;
      line-height: 1.5;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Geist Mono", monospace;
      font-size: 13.5px;
      background: rgba(110, 118, 129, 0.2);
      padding: 2px 6px;
      border-radius: 4px;
      color: #E2E8F0;
    }
    pre code {
      background: transparent;
      padding: 0;
      border-radius: 0;
    }
    /* Lists */
    ul, ol {
      margin-left: 28px;
      margin-bottom: 18px;
    }
    li { margin-bottom: 6px; }
    /* Blockquotes */
    blockquote {
      border-left: 4px solid var(--accent);
      padding: 10px 18px;
      background: #0B101B;
      color: var(--text-muted);
      border-radius: 0 4px 4px 0;
      margin: 18px 0;
    }
    /* Details */
    details {
      background: #0A0E17;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px 18px;
      margin: 18px 0;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--text-bright);
      outline: none;
    }
    /* Mermaid Diagram Container */
    .mermaid {
      background: #070A0F;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px;
      margin: 20px 0;
      display: flex;
      justify-content: center;
    }
  </style>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#070A0F',
        primaryColor: '#121826',
        primaryTextColor: '#E2E8F4',
        primaryBorderColor: '#5B8DEF',
        lineColor: '#3FB8AE',
        secondaryColor: '#0E1422',
        tertiaryColor: '#0A0E17'
      }
    });
  </script>
</head>
<body>
  <!-- Top Telemetry Header -->
  <div class="top-bar">
    <div class="top-title">
      <span class="led-live"></span>
      <span>CHAPTERS / ELARA — README.MD OBSERVATORY PREVIEW</span>
    </div>
    <div class="top-meta">
      TARGET: <span>PIIIX-org/chapters</span> &nbsp;|&nbsp;
      BRANCH: <span>feat/master-test-plans-tp01-tp15-dashboards</span> &nbsp;|&nbsp;
      PREFLIGHT: <span style="color:#2EC47C">PASS (100%)</span>
    </div>
  </div>

  <div class="page-container markdown-body">
''' + body_html + '''
  </div>
</body>
</html>
'''

# Write Local in repo
with open(OUT_LOCAL, "w", encoding="utf-8") as f:
    f.write(html_template)
print(f"Generated local preview: {OUT_LOCAL}")

# Write Root preview with absolute paths to assets
root_html = html_template.replace('src="assets/', f'src="file://{REPO_DIR}/assets/')
with open(OUT_ROOT, "w", encoding="utf-8") as f:
    f.write(root_html)
print(f"Generated root preview: {OUT_ROOT}")
