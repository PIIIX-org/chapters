#!/usr/bin/env python3
"""
generate_profile_assets.py
Forges custom, professional, non-pulsating animated SVG assets for Chapters (Elara):
- ZERO jumping/pulsating scale animations on dots, text, or cards.
- Perfectly aligned, rock-solid status LEDs.
- Rich, diverse, elegant animation techniques:
  * Fiber-optic dashed line flows (data streaming along graph edges and curves)
  * Perimeter border tracers (neon highlight gliding around winner columns & badges)
  * Linear shimmer / sheen glints (smooth high-tech sweeps across cards)
  * Oscilloscope / telemetry waveform flow
  * Viewport radar / laser beam sweeps
  * Crisp terminal cursor blinks
- 100% full geometry visibility at frame 0 (perfect for static PNG/QuickLook/GitHub camo renders).
- Accessible: respects @media (prefers-reduced-motion: reduce).
"""

import os

TARGET_DIR = "/Users/taha/Documents/chapters/assets"
BADGES_DIR = os.path.join(TARGET_DIR, "badges")
CHARTS_DIR = os.path.join(TARGET_DIR, "charts")

os.makedirs(BADGES_DIR, exist_ok=True)
os.makedirs(CHARTS_DIR, exist_ok=True)

# =========================================================================
# 1. SIGNATURE HERO SVG (1200 x 440) - OBSERVATORY FLIGHT DECK
# =========================================================================
hero_svg = '''<svg width="100%" height="440" viewBox="0 0 1200 440" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chapters Knowledge Engine Observatory Flight Deck">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#070A0F"/>
      <stop offset="50%" stop-color="#0A0E17"/>
      <stop offset="100%" stop-color="#070A0F"/>
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#121826" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#0B0F19" stop-opacity="0.95"/>
    </linearGradient>
    <linearGradient id="blueGlow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#5B8DEF"/>
      <stop offset="100%" stop-color="#3FB8AE"/>
    </linearGradient>
    <linearGradient id="sweepGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#3FB8AE" stop-opacity="0"/>
      <stop offset="85%" stop-color="#3FB8AE" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#3FB8AE" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="sheenGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">
      <path d="M 30 0 L 0 0 0 30" fill="none" stroke="#1C2433" stroke-width="0.7" stroke-opacity="0.45"/>
    </pattern>
    <style>
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Geist Mono", monospace; }
      .sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Geist", Helvetica, Arial, sans-serif; }
      
      /* Crisp terminal cursor blink - zero coordinate movement */
      @keyframes cursorBlink {
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }
      /* Fiber optic edge dash flow - simulated high speed data streaming */
      @keyframes flowDash {
        to { stroke-dashoffset: -28; }
      }
      /* Data packet glide - constant size, smooth coordinate travel */
      @keyframes travelPacket1 {
        0% { cx: 80; cy: 110; opacity: 0; }
        15% { opacity: 1; }
        50% { cx: 200; cy: 70; }
        85% { opacity: 1; }
        100% { cx: 310; cy: 120; opacity: 0; }
      }
      @keyframes travelPacket2 {
        0% { cx: 140; cy: 210; opacity: 0; }
        15% { opacity: 1; }
        55% { cx: 270; cy: 230; }
        85% { opacity: 1; }
        100% { cx: 380; cy: 190; opacity: 0; }
      }
      /* Radar sweep beam across topology viewport */
      @keyframes sweepScan {
        0% { transform: translateX(-100px); }
        100% { transform: translateX(560px); }
      }
      /* Shimmer sweep across HUD card */
      @keyframes hudSheen {
        0% { transform: translateX(-510px); }
        35%, 100% { transform: translateX(510px); }
      }
      
      .cursor-blink { animation: cursorBlink 1.1s infinite; }
      .flow-edge-blue { stroke-dasharray: 6 4; animation: flowDash 1.4s linear infinite; }
      .flow-edge-teal { stroke-dasharray: 5 3; animation: flowDash 1.8s linear infinite; }
      .packet-1 { animation: travelPacket1 3.5s infinite linear; }
      .packet-2 { animation: travelPacket2 4.2s infinite linear; }
      .sweep-beam { animation: sweepScan 7s infinite linear; }
      .hud-sheen-anim { animation: hudSheen 6s infinite ease-in-out; }
      
      @media (prefers-reduced-motion: reduce) {
        .cursor-blink, .flow-edge-blue, .flow-edge-teal, .packet-1, .packet-2, .sweep-beam, .hud-sheen-anim {
          animation: none !important;
        }
      }
    </style>
  </defs>

  <!-- Background Base -->
  <rect width="1200" height="440" fill="url(#bgGrad)"/>
  <rect width="1200" height="440" fill="url(#grid)"/>

  <!-- Top Aerospace Telemetry Status Header - Perfectly Aligned, Rock-Solid LED -->
  <rect x="0" y="0" width="1200" height="36" fill="#0B0F18" stroke="#1C2433" stroke-width="1"/>
  <circle cx="20" cy="18" r="4" fill="#2EC47C"/>
  <text x="32" y="22" class="mono" font-size="11" font-weight="600" fill="#2EC47C" letter-spacing="1">OBSERVATORY LIVE</text>
  <text x="175" y="22" class="mono" font-size="11" fill="#8B9BB4">|</text>
  <text x="190" y="22" class="mono" font-size="11" fill="#8B9BB4">HOST: <tspan fill="#E2E8F4">sohrab.contabo</tspan> [12 vCPUs AMD EPYC 7282 · 48GB RAM]</text>
  <text x="650" y="22" class="mono" font-size="11" fill="#8B9BB4">|</text>
  <text x="665" y="22" class="mono" font-size="11" fill="#8B9BB4">ENGINE: <tspan fill="#5B8DEF">pgvector 17.0</tspan> + <tspan fill="#3FB8AE">Tree-sitter WASM</tspan></text>
  <text x="980" y="22" class="mono" font-size="11" fill="#8B9BB4">SLO: <tspan fill="#2EC47C">15/15 PASS (100%)</tspan></text>

  <!-- Outer Border Frame -->
  <rect x="1" y="1" width="1198" height="438" fill="none" stroke="#1C2433" stroke-width="1.5"/>

  <!-- Left Main Display: Branding & Subtitle -->
  <g transform="translate(60, 75)">
    <!-- Category Pill -->
    <rect x="0" y="0" width="280" height="26" rx="3" fill="#161D2B" stroke="#1C2433" stroke-width="1"/>
    <circle cx="12" cy="13" r="3" fill="#3FB8AE"/>
    <text x="24" y="17" class="mono" font-size="10.5" font-weight="600" fill="#3FB8AE" letter-spacing="1">KNOWLEDGE ENGINE &amp; MCP SERVER</text>

    <!-- Main Title with blinking cursor -->
    <text x="0" y="70" class="sans" font-size="44" font-weight="800" fill="#E2E8F4" letter-spacing="-1">Chapters <tspan fill="url(#blueGlow)">/ Elara</tspan></text>
    <rect x="360" y="38" width="12" height="36" fill="#3FB8AE" class="cursor-blink"/>

    <!-- Subtitle Definition -->
    <text x="0" y="104" class="sans" font-size="17" font-weight="400" fill="#8B9BB4">
      The open-source, self-hostable second brain built for human teams
    </text>
    <text x="0" y="128" class="sans" font-size="17" font-weight="400" fill="#8B9BB4">
      and autonomous AI agent swarms.
    </text>

    <!-- Core Value Pills -->
    <g transform="translate(0, 155)">
      <rect x="0" y="0" width="145" height="30" rx="3" fill="#0F141F" stroke="#1C2433" stroke-width="1"/>
      <text x="14" y="19" class="mono" font-size="11" font-weight="600" fill="#E2E8F4">📄 OKF v0.2 Plain MD</text>

      <rect x="155" y="0" width="155" height="30" rx="3" fill="#0F141F" stroke="#1C2433" stroke-width="1"/>
      <text x="169" y="19" class="mono" font-size="11" font-weight="600" fill="#E2E8F4">🌲 Code Tree-sitter</text>

      <rect x="320" y="0" width="165" height="30" rx="3" fill="#0F141F" stroke="#1C2433" stroke-width="1"/>
      <text x="334" y="19" class="mono" font-size="11" font-weight="600" fill="#E2E8F4">⚡ Real-Time CRDT</text>
    </g>

    <!-- Live Telemetry Stats HUD Bar with Shimmer Sheen -->
    <g transform="translate(0, 215)">
      <clipPath id="hudClip">
        <rect x="0" y="0" width="510" height="90" rx="4"/>
      </clipPath>
      <rect x="0" y="0" width="510" height="90" rx="4" fill="url(#cardGrad)" stroke="#1C2433" stroke-width="1"/>
      
      <!-- Sheen sweep -->
      <g clip-path="url(#hudClip)">
        <rect x="0" y="0" width="220" height="90" fill="url(#sheenGrad)" class="hud-sheen-anim"/>
      </g>
      
      <!-- Stat 1: QPS -->
      <g transform="translate(25, 20)">
        <text x="0" y="14" class="mono" font-size="10" font-weight="600" fill="#8B9BB4" letter-spacing="1">SEARCH QPS</text>
        <text x="0" y="42" class="mono" font-size="24" font-weight="700" fill="#2EC47C">10.87</text>
        <text x="0" y="58" class="mono" font-size="9.5" fill="#8B9BB4">c=25 concurrency</text>
      </g>
      <line x1="145" y1="15" x2="145" y2="75" stroke="#1C2433" stroke-width="1"/>

      <!-- Stat 2: LOC/s -->
      <g transform="translate(165, 20)">
        <text x="0" y="14" class="mono" font-size="10" font-weight="600" fill="#8B9BB4" letter-spacing="1">AST INGESTION</text>
        <text x="0" y="42" class="mono" font-size="24" font-weight="700" fill="#5B8DEF">92,245</text>
        <text x="0" y="58" class="mono" font-size="9.5" fill="#8B9BB4">lines / second</text>
      </g>
      <line x1="295" y1="15" x2="295" y2="75" stroke="#1C2433" stroke-width="1"/>

      <!-- Stat 3: Memory Drift -->
      <g transform="translate(315, 20)">
        <text x="0" y="14" class="mono" font-size="10" font-weight="600" fill="#8B9BB4" letter-spacing="1">24H SOAK DRIFT</text>
        <text x="0" y="42" class="mono" font-size="24" font-weight="700" fill="#3FB8AE">+0.37</text>
        <text x="0" y="58" class="mono" font-size="9.5" fill="#8B9BB4">MB/hr (SLO &lt; 0.50)</text>
      </g>
      <line x1="420" y1="15" x2="420" y2="75" stroke="#1C2433" stroke-width="1"/>

      <!-- Stat 4: MCP Tools -->
      <g transform="translate(435, 20)">
        <text x="0" y="14" class="mono" font-size="10" font-weight="600" fill="#8B9BB4" letter-spacing="1">MCP TOOLS</text>
        <text x="0" y="42" class="mono" font-size="24" font-weight="700" fill="#E2E8F4">57</text>
        <text x="0" y="58" class="mono" font-size="9.5" fill="#8B9BB4">+ 20 prompts</text>
      </g>
    </g>
  </g>

  <!-- Right Visual: Interactive Knowledge Graph Simulation -->
  <g transform="translate(680, 75)">
    <clipPath id="viewportClip">
      <rect x="0" y="0" width="460" height="330" rx="4"/>
    </clipPath>

    <!-- Simulation Viewport Frame -->
    <rect x="0" y="0" width="460" height="330" rx="4" fill="url(#cardGrad)" stroke="#1C2433" stroke-width="1"/>
    
    <!-- Viewport Header -->
    <rect x="0" y="0" width="460" height="28" fill="#0E131F" stroke="#1C2433" stroke-width="1"/>
    <text x="16" y="18" class="mono" font-size="10.5" fill="#8B9BB4">TOPOLOGY: <tspan fill="#5B8DEF">LOUVAIN GRAPH</tspan> + <tspan fill="#3FB8AE">AST BRIDGES</tspan></text>
    <circle cx="350" cy="14" r="3.5" fill="#2EC47C"/>
    <text x="360" y="18" class="mono" font-size="10.5" fill="#2EC47C">LIVE STREAM</text>

    <!-- Radar Beam Sweep (clipped to viewport) -->
    <g clip-path="url(#viewportClip)">
      <rect x="0" y="28" width="90" height="302" fill="url(#sweepGrad)" class="sweep-beam"/>
    </g>

    <!-- Connecting Edges with Animated Flow Dashes -->
    <line x1="80" y1="110" x2="200" y2="70" stroke="#5B8DEF" stroke-width="1.8" class="flow-edge-blue"/>
    <line x1="200" y1="70" x2="310" y2="120" stroke="#5B8DEF" stroke-width="1.8" class="flow-edge-blue"/>
    <line x1="80" y1="110" x2="140" y2="210" stroke="#5B8DEF" stroke-width="1.8" class="flow-edge-blue"/>
    <line x1="140" y1="210" x2="270" y2="230" stroke="#5B8DEF" stroke-width="1.8" class="flow-edge-blue"/>

    <line x1="200" y1="70" x2="210" y2="160" stroke="#3FB8AE" stroke-width="1.5" class="flow-edge-teal"/>
    <line x1="310" y1="120" x2="380" y2="190" stroke="#3FB8AE" stroke-width="1.5" class="flow-edge-teal"/>
    <line x1="270" y1="230" x2="380" y2="190" stroke="#3FB8AE" stroke-width="1.5" class="flow-edge-teal"/>
    <line x1="140" y1="210" x2="210" y2="160" stroke="#3FB8AE" stroke-width="1.5" class="flow-edge-teal"/>

    <line x1="210" y1="160" x2="270" y2="230" stroke="#F59E0B" stroke-width="1.5" stroke-dasharray="2 3"/>
    <line x1="80" y1="110" x2="210" y2="160" stroke="#5B8DEF" stroke-width="1.2" stroke-opacity="0.5"/>

    <!-- Data Packets gliding smoothly along edges (fixed 3.5px size) -->
    <circle cx="0" cy="0" r="3.5" fill="#5B8DEF" class="packet-1"/>
    <circle cx="0" cy="0" r="3.5" fill="#3FB8AE" class="packet-2"/>

    <!-- Node 1: Architecture Note -->
    <circle cx="80" cy="110" r="16" fill="#161D2B" stroke="#5B8DEF" stroke-width="2"/>
    <text x="80" y="114" class="mono" font-size="9" font-weight="700" fill="#E2E8F4" text-anchor="middle">NOTE</text>
    <text x="80" y="138" class="mono" font-size="8.5" fill="#8B9BB4" text-anchor="middle">arch.md</text>

    <!-- Node 2: Vault Schema -->
    <circle cx="200" cy="70" r="20" fill="#161D2B" stroke="#5B8DEF" stroke-width="2.5"/>
    <text x="200" y="74" class="mono" font-size="9.5" font-weight="700" fill="#5B8DEF" text-anchor="middle">VAULT</text>
    <text x="200" y="102" class="mono" font-size="8.5" fill="#8B9BB4" text-anchor="middle">core/schema</text>

    <!-- Node 3: Tree-sitter Code Symbol -->
    <rect x="195" y="145" width="30" height="30" rx="3" fill="#161D2B" stroke="#3FB8AE" stroke-width="2"/>
    <text x="210" y="164" class="mono" font-size="9" font-weight="700" fill="#3FB8AE" text-anchor="middle">fn</text>
    <text x="210" y="188" class="mono" font-size="8.5" fill="#8B9BB4" text-anchor="middle">buildGraph()</text>

    <!-- Node 4: Knowledge Node -->
    <circle cx="310" cy="120" r="15" fill="#161D2B" stroke="#5B8DEF" stroke-width="2"/>
    <text x="310" y="124" class="mono" font-size="8.5" font-weight="700" fill="#E2E8F4" text-anchor="middle">OKF</text>
    <text x="310" y="146" class="mono" font-size="8.5" fill="#8B9BB4" text-anchor="middle">spec.md</text>

    <!-- Node 5: AI Agent Connection (MCP) -->
    <polygon points="380,172 396,200 364,200" fill="#161D2B" stroke="#F59E0B" stroke-width="2"/>
    <text x="380" y="194" class="mono" font-size="8.5" font-weight="700" fill="#F59E0B" text-anchor="middle">MCP</text>
    <text x="380" y="214" class="mono" font-size="8.5" fill="#8B9BB4" text-anchor="middle">Claude / Cursor</text>

    <!-- Node 6: CRDT Relay -->
    <circle cx="140" cy="210" r="14" fill="#161D2B" stroke="#2EC47C" stroke-width="2"/>
    <text x="140" y="214" class="mono" font-size="8.5" font-weight="700" fill="#2EC47C" text-anchor="middle">Yjs</text>
    <text x="140" y="234" class="mono" font-size="8.5" fill="#8B9BB4" text-anchor="middle">Hocuspocus</text>

    <!-- Node 7: Code Symbol Interface -->
    <rect x="255" y="215" width="30" height="30" rx="3" fill="#161D2B" stroke="#3FB8AE" stroke-width="2"/>
    <text x="270" y="234" class="mono" font-size="9" font-weight="700" fill="#3FB8AE" text-anchor="middle">type</text>
    <text x="270" y="258" class="mono" font-size="8.5" fill="#8B9BB4" text-anchor="middle">McpTool</text>

    <!-- Footer Legend in Simulation -->
    <rect x="10" y="285" width="440" height="35" rx="3" fill="#0A0E17" stroke="#1C2433" stroke-width="1"/>
    <circle cx="28" cy="302" r="4" fill="#5B8DEF"/>
    <text x="38" y="306" class="mono" font-size="9" fill="#8B9BB4">OKF Notes</text>

    <rect x="110" y="298" width="8" height="8" rx="1" fill="#3FB8AE"/>
    <text x="124" y="306" class="mono" font-size="9" fill="#8B9BB4">AST Symbols</text>

    <polygon points="215,298 221,308 209,308" fill="#F59E0B"/>
    <text x="227" y="306" class="mono" font-size="9" fill="#8B9BB4">MCP AI Agents</text>

    <circle cx="330" cy="302" r="4" fill="#2EC47C"/>
    <text x="340" y="306" class="mono" font-size="9" fill="#8B9BB4">CRDT Relay</text>
  </g>
</svg>
'''

with open(os.path.join(TARGET_DIR, "hero.svg"), "w") as f:
    f.write(hero_svg)
print("Generated animated assets/hero.svg")

# =========================================================================
# 2. REINVENTED TELEMETRY BADGES - STATIC LED + CALM LINEAR SHIMMER
# =========================================================================
badges = [
    {"filename": "badge-okf.svg", "domain": "FORMAT", "value": "OKF v0.2 · ISO 8601", "color": "#5B8DEF", "pip": "#2EC47C", "w": 225},
    {"filename": "badge-crdt.svg", "domain": "COLLAB", "value": "Yjs CRDT · 0.09ms p95", "color": "#2EC47C", "pip": "#2EC47C", "w": 235},
    {"filename": "badge-vector.svg", "domain": "VECTOR", "value": "pgvector 17 · 10.87 QPS", "color": "#5B8DEF", "pip": "#2EC47C", "w": 235},
    {"filename": "badge-mcp.svg", "domain": "AI MCP", "value": "57 Tools · 20 Prompts", "color": "#3FB8AE", "pip": "#3FB8AE", "w": 230},
    {"filename": "badge-ast.svg", "domain": "AST ENGINE", "value": "Tree-sitter · 92k LOC/s", "color": "#3FB8AE", "pip": "#3FB8AE", "w": 240},
    {"filename": "badge-security.svg", "domain": "SECURITY", "value": "21/21 Vectors Blocked", "color": "#2EC47C", "pip": "#2EC47C", "w": 235},
    {"filename": "badge-tests.svg", "domain": "TEST SUITE", "value": "15/15 Plans Verified", "color": "#2EC47C", "pip": "#2EC47C", "w": 225},
    {"filename": "badge-license.svg", "domain": "LICENSE", "value": "MIT Open Source", "color": "#E2E8F4", "pip": "#5B8DEF", "w": 195}
]

for b in badges:
    w = b["w"]
    h = 28
    svg = f'''<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{b['domain']}: {b['value']}">
  <defs>
    <linearGradient id="bg_{b['domain'].replace(' ','_')}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#121826"/>
      <stop offset="100%" stop-color="#0A0E17"/>
    </linearGradient>
    <linearGradient id="badgeSheen" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="badgeClip">
      <rect width="{w}" height="{h}" rx="3"/>
    </clipPath>
    <style>
      .mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }}
      @keyframes sheenSweep {{
        0% {{ transform: translateX(-{w}px); }}
        30%, 100% {{ transform: translateX({w}px); }}
      }}
      .badge-sheen {{ animation: sheenSweep 5s infinite ease-in-out; }}
      @media (prefers-reduced-motion: reduce) {{
        .badge-sheen {{ animation: none !important; }}
      }}
    </style>
  </defs>
  <rect width="{w}" height="{h}" rx="3" fill="url(#bg_{b['domain'].replace(' ','_')})" stroke="#1C2433" stroke-width="1"/>
  
  <!-- Subtle linear shimmer sheen (zero pulse, zero dot movement) -->
  <g clip-path="url(#badgeClip)">
    <rect x="0" y="0" width="{w//2}" height="{h}" fill="url(#badgeSheen)" class="badge-sheen"/>
  </g>

  <!-- Perfectly aligned static indicator pip -->
  <circle cx="12" cy="{h/2}" r="3" fill="{b['pip']}"/>
  <text x="22" y="{h/2 + 3.8}" class="mono" font-size="10" font-weight="700" fill="#8B9BB4" letter-spacing="0.5">{b['domain']}</text>
  <line x1="{len(b['domain'])*6.8 + 26}" y1="5" x2="{len(b['domain'])*6.8 + 26}" y2="{h-5}" stroke="#1C2433" stroke-width="1"/>
  <text x="{len(b['domain'])*6.8 + 34}" y="{h/2 + 3.8}" class="mono" font-size="10.5" font-weight="600" fill="{b['color']}">{b['value']}</text>
</svg>'''
    path = os.path.join(BADGES_DIR, b["filename"])
    with open(path, "w") as f:
        f.write(svg)
    print(f"Generated badge: {path}")

# =========================================================================
# 3. CHART 1: QPS CONCURRENCY SCALING LADDER - ANIMATED STREAM & SHEEN
# =========================================================================
chart_qps_svg = '''<svg width="100%" height="380" viewBox="0 0 900 380" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Query Throughput Scaling Comparison: pgvector vs ChromaDB under concurrency">
  <defs>
    <linearGradient id="cardBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0E1422"/>
      <stop offset="100%" stop-color="#070A0F"/>
    </linearGradient>
    <linearGradient id="pgGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#2EC47C"/>
      <stop offset="100%" stop-color="#5B8DEF"/>
    </linearGradient>
    <linearGradient id="chromaGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#D97706"/>
    </linearGradient>
    <linearGradient id="qpsSheen" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <style>
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Geist Mono", monospace; }
      .sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Geist", Helvetica, Arial, sans-serif; }
      
      /* Fiber optic data stream along the performance curve */
      @keyframes flowCurve {
        to { stroke-dashoffset: -36; }
      }
      /* Shimmer sweep across winning badges */
      @keyframes winSheen {
        0% { transform: translateX(-100px); }
        40%, 100% { transform: translateX(120px); }
      }
      
      .curve-stream {
        stroke-dasharray: 8 4;
        animation: flowCurve 1.5s linear infinite;
      }
      .sheen-badge {
        animation: winSheen 4.5s infinite ease-in-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .curve-stream, .sheen-badge {
          animation: none !important;
        }
      }
    </style>
  </defs>

  <rect width="900" height="380" rx="4" fill="url(#cardBg)" stroke="#1C2433" stroke-width="1"/>

  <!-- Chart Header -->
  <g transform="translate(30, 25)">
    <text x="0" y="16" class="sans" font-size="18" font-weight="700" fill="#E2E8F4">Vector Query Throughput Under Concurrency (QPS)</text>
    <text x="0" y="36" class="mono" font-size="11.5" fill="#8B9BB4">
      Contabo VPS <tspan fill="#5B8DEF">sohrab</tspan> (12 vCPUs AMD EPYC 7282, 48GB RAM) · Reciprocal Rank Fusion (BM25 + 384d Cosine)
    </text>
  </g>

  <!-- Legend -->
  <g transform="translate(550, 28)">
    <rect x="0" y="2" width="14" height="14" rx="2" fill="url(#pgGrad)"/>
    <text x="20" y="14" class="mono" font-size="11" font-weight="600" fill="#E2E8F4">pgvector (In-Engine)</text>

    <rect x="175" y="2" width="14" height="14" rx="2" fill="url(#chromaGrad)"/>
    <text x="195" y="14" class="mono" font-size="11" font-weight="600" fill="#8B9BB4">ChromaDB (HTTP)</text>
  </g>

  <!-- Chart Canvas Area (Left 140 to 860, Y from 90 to 290) -->
  <g transform="translate(40, 85)">
    <!-- Y Axis Gridlines (0, 3, 6, 9, 12 QPS) -->
    <line x1="80" y1="0" x2="820" y2="0" stroke="#1C2433" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="70" y="4" class="mono" font-size="10" fill="#8B9BB4" text-anchor="end">12 QPS</text>

    <line x1="80" y1="50" x2="820" y2="50" stroke="#1C2433" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="70" y="54" class="mono" font-size="10" fill="#8B9BB4" text-anchor="end">9 QPS</text>

    <line x1="80" y1="100" x2="820" y2="100" stroke="#1C2433" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="70" y="104" class="mono" font-size="10" fill="#8B9BB4" text-anchor="end">6 QPS</text>

    <line x1="80" y1="150" x2="820" y2="150" stroke="#1C2433" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="70" y="154" class="mono" font-size="10" fill="#8B9BB4" text-anchor="end">3 QPS</text>

    <line x1="80" y1="200" x2="820" y2="200" stroke="#1C2433" stroke-width="1.5"/>
    <text x="70" y="204" class="mono" font-size="10" fill="#8B9BB4" text-anchor="end">0 QPS</text>

    <!-- Concurrency Group 1: c = 1 worker -->
    <g transform="translate(130, 0)">
      <!-- 100% full geometry always visible -->
      <rect x="0" y="174.5" width="38" height="25.5" rx="2" fill="url(#pgGrad)"/>
      <text x="19" y="166" class="mono" font-size="11" font-weight="700" fill="#2EC47C" text-anchor="middle">1.53</text>

      <rect x="44" y="177.7" width="38" height="22.3" rx="2" fill="url(#chromaGrad)"/>
      <text x="63" y="169" class="mono" font-size="11" font-weight="600" fill="#F59E0B" text-anchor="middle">1.34</text>

      <text x="41" y="222" class="mono" font-size="11" font-weight="600" fill="#E2E8F4" text-anchor="middle">c = 1</text>
      <text x="41" y="236" class="mono" font-size="9.5" fill="#8B9BB4" text-anchor="middle">worker</text>
    </g>

    <!-- Concurrency Group 2: c = 5 workers -->
    <g transform="translate(320, 0)">
      <rect x="0" y="117.2" width="38" height="82.8" rx="2" fill="url(#pgGrad)"/>
      <text x="19" y="108" class="mono" font-size="11" font-weight="700" fill="#2EC47C" text-anchor="middle">4.97</text>

      <rect x="44" y="112.7" width="38" height="87.3" rx="2" fill="url(#chromaGrad)"/>
      <text x="63" y="104" class="mono" font-size="11" font-weight="600" fill="#F59E0B" text-anchor="middle">5.24</text>

      <text x="41" y="222" class="mono" font-size="11" font-weight="600" fill="#E2E8F4" text-anchor="middle">c = 5</text>
      <text x="41" y="236" class="mono" font-size="9.5" fill="#8B9BB4" text-anchor="middle">workers</text>
    </g>

    <!-- Concurrency Group 3: c = 10 workers -->
    <g transform="translate(510, 0)">
      <rect x="0" y="53.4" width="38" height="146.6" rx="2" fill="url(#pgGrad)"/>
      <text x="19" y="44" class="mono" font-size="12" font-weight="700" fill="#2EC47C" text-anchor="middle">8.80</text>

      <rect x="44" y="88.7" width="38" height="111.3" rx="2" fill="url(#chromaGrad)"/>
      <text x="63" y="80" class="mono" font-size="11" font-weight="600" fill="#F59E0B" text-anchor="middle">6.68</text>

      <!-- Advantage Callout with Shimmer Sheen -->
      <g>
        <clipPath id="win10Clip">
          <rect x="-5" y="12" width="92" height="18" rx="3"/>
        </clipPath>
        <rect x="-5" y="12" width="92" height="18" rx="3" fill="#161D2B" stroke="#2EC47C" stroke-width="1"/>
        <g clip-path="url(#win10Clip)">
          <rect x="-5" y="12" width="40" height="18" fill="url(#qpsSheen)" class="sheen-badge"/>
        </g>
        <text x="41" y="24" class="mono" font-size="9.5" font-weight="700" fill="#2EC47C" text-anchor="middle">+31.7% WIN</text>
      </g>

      <text x="41" y="222" class="mono" font-size="11" font-weight="600" fill="#E2E8F4" text-anchor="middle">c = 10</text>
      <text x="41" y="236" class="mono" font-size="9.5" fill="#8B9BB4" text-anchor="middle">workers</text>
    </g>

    <!-- Concurrency Group 4: c = 25 workers -->
    <g transform="translate(700, 0)">
      <rect x="0" y="18.9" width="38" height="181.1" rx="2" fill="url(#pgGrad)"/>
      <text x="19" y="10" class="mono" font-size="12" font-weight="700" fill="#2EC47C" text-anchor="middle">10.87</text>

      <rect x="44" y="52.9" width="38" height="147.1" rx="2" fill="url(#chromaGrad)"/>
      <text x="63" y="44" class="mono" font-size="11" font-weight="600" fill="#F59E0B" text-anchor="middle">8.83</text>

      <!-- Advantage Callout with Shimmer Sheen -->
      <g>
        <clipPath id="win25Clip">
          <rect x="-5" y="-18" width="92" height="18" rx="3"/>
        </clipPath>
        <rect x="-5" y="-18" width="92" height="18" rx="3" fill="#161D2B" stroke="#2EC47C" stroke-width="1"/>
        <g clip-path="url(#win25Clip)">
          <rect x="-5" y="-18" width="40" height="18" fill="url(#qpsSheen)" class="sheen-badge"/>
        </g>
        <text x="41" y="-6" class="mono" font-size="9.5" font-weight="700" fill="#2EC47C" text-anchor="middle">+23.1% WIN</text>
      </g>

      <text x="41" y="222" class="mono" font-size="11" font-weight="600" fill="#E2E8F4" text-anchor="middle">c = 25</text>
      <text x="41" y="236" class="mono" font-size="9.5" fill="#8B9BB4" text-anchor="middle">workers</text>
    </g>

    <!-- Base Telemetry Line Curve (Always 100% visible) -->
    <path d="M 149 174.5 Q 339 117.2, 529 53.4 T 719 18.9" fill="none" stroke="#164E36" stroke-width="2.5" stroke-linecap="round"/>
    <!-- Animated Fiber-Optic Data Stream along Curve -->
    <path d="M 149 174.5 Q 339 117.2, 529 53.4 T 719 18.9" fill="none" stroke="#2EC47C" stroke-width="2.5" stroke-linecap="round" class="curve-stream"/>
    
    <!-- Line Marker Dots - Fixed Geometry, Clean Solid Status -->
    <circle cx="149" cy="174.5" r="3.5" fill="#070A0F" stroke="#2EC47C" stroke-width="2"/>
    <circle cx="339" cy="117.2" r="3.5" fill="#070A0F" stroke="#2EC47C" stroke-width="2"/>
    <circle cx="529" cy="53.4" r="3.5" fill="#070A0F" stroke="#2EC47C" stroke-width="2"/>
    <circle cx="719" cy="18.9" r="4" fill="#2EC47C" stroke="#E2E8F4" stroke-width="1.5"/>
  </g>

  <!-- Architectural Callout Bottom Strip -->
  <rect x="30" y="325" width="840" height="38" rx="3" fill="#0A0E17" stroke="#1C2433" stroke-width="1"/>
  <circle cx="48" cy="344" r="3.5" fill="#2EC47C"/>
  <text x="62" y="348" class="mono" font-size="9" fill="#8B9BB4">
    <tspan fill="#E2E8F4" font-weight="700">Root Cause Discovery:</tspan> pgvector executes in shared memory with zero IPC; ChromaDB bottlenecks on Docker bridge HTTP JSON serialization.
  </text>
</svg>
'''

with open(os.path.join(CHARTS_DIR, "benchmark-qps-throughput.svg"), "w") as f:
    f.write(chart_qps_svg)
print("Generated animated assets/charts/benchmark-qps-throughput.svg")

# =========================================================================
# 4. CHART 2: TAIL LATENCY & MEMORY FORENSICS - LIVE WAVEFORM & SHEEN
# =========================================================================
chart_latency_memory_svg = '''<svg width="100%" height="320" viewBox="0 0 900 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tail Latency and Memory Drift Telemetry Comparison">
  <defs>
    <linearGradient id="cardBg2" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0E1422"/>
      <stop offset="100%" stop-color="#070A0F"/>
    </linearGradient>
    <linearGradient id="barSheen" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="pgBarClip">
      <rect x="0" y="24" width="142" height="24" rx="2"/>
    </clipPath>
    <clipPath id="waveClip">
      <rect x="0" y="0" width="365" height="22" rx="2"/>
    </clipPath>
    <style>
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Geist Mono", monospace; }
      .sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Geist", Helvetica, Arial, sans-serif; }
      
      /* Smooth bar sheen glint */
      @keyframes barGlint {
        0% { transform: translateX(-150px); }
        35%, 100% { transform: translateX(160px); }
      }
      /* Live oscilloscope waveform travel */
      @keyframes waveStream {
        to { stroke-dashoffset: -80; }
      }
      
      .bar-glint-anim { animation: barGlint 5s infinite ease-in-out; }
      .wave-line {
        stroke-dasharray: 20 8 4 8;
        animation: waveStream 2s linear infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .bar-glint-anim, .wave-line {
          animation: none !important;
        }
      }
    </style>
  </defs>

  <rect width="900" height="320" rx="4" fill="url(#cardBg2)" stroke="#1C2433" stroke-width="1"/>

  <!-- Left Card: Tail Latency (p95 and p99 at c=10) -->
  <g transform="translate(30, 25)">
    <rect x="0" y="0" width="405" height="270" rx="3" fill="#0A0E17" stroke="#1C2433" stroke-width="1"/>
    
    <text x="20" y="28" class="sans" font-size="15" font-weight="700" fill="#E2E8F4">Tail Latency at c=10 Workers</text>
    <text x="20" y="46" class="mono" font-size="10.5" fill="#8B9BB4">Lower is better · Real Contabo Telemetry</text>

    <!-- p95 Comparison -->
    <g transform="translate(20, 75)">
      <text x="0" y="14" class="mono" font-size="11" font-weight="600" fill="#E2E8F4">p95 Latency</text>
      
      <!-- pgvector bar: 1,425 ms (width 142px) with sheen -->
      <rect x="0" y="24" width="142" height="24" rx="2" fill="#2EC47C"/>
      <g clip-path="url(#pgBarClip)">
        <rect x="0" y="24" width="60" height="24" fill="url(#barSheen)" class="bar-glint-anim"/>
      </g>
      <text x="150" y="41" class="mono" font-size="11" font-weight="700" fill="#2EC47C">1,425 ms (pgvector)</text>

      <!-- Chroma bar: 2,620 ms (width 262px) -->
      <rect x="0" y="54" width="262" height="24" rx="2" fill="#F59E0B" fill-opacity="0.85"/>
      <text x="270" y="71" class="mono" font-size="11" font-weight="600" fill="#F59E0B">2,620 ms (Chroma)</text>
      
      <text x="0" y="96" class="mono" font-size="10" font-weight="700" fill="#2EC47C">★ pgvector has 84% lower p95 tail latency</text>
    </g>

    <!-- p99 Comparison -->
    <g transform="translate(20, 185)">
      <text x="0" y="12" class="mono" font-size="11" font-weight="600" fill="#E2E8F4">p99 Latency</text>
      
      <rect x="0" y="20" width="143" height="20" rx="2" fill="#2EC47C"/>
      <text x="150" y="35" class="mono" font-size="10.5" font-weight="700" fill="#2EC47C">1,435 ms</text>

      <rect x="0" y="44" width="302" height="20" rx="2" fill="#F59E0B" fill-opacity="0.85"/>
      <text x="310" y="59" class="mono" font-size="10.5" font-weight="600" fill="#F59E0B">3,028 ms</text>

      <text x="0" y="78" class="mono" font-size="9.5" font-weight="700" fill="#2EC47C">★ pgvector is 111% faster on extreme tail</text>
    </g>
  </g>

  <!-- Right Card: Memory Drift & Endurance -->
  <g transform="translate(465, 25)">
    <rect x="0" y="0" width="405" height="270" rx="3" fill="#0A0E17" stroke="#1C2433" stroke-width="1"/>
    
    <text x="20" y="28" class="sans" font-size="15" font-weight="700" fill="#E2E8F4">V8 Heap &amp; Soak Stability</text>
    <text x="20" y="46" class="mono" font-size="10.5" fill="#8B9BB4">24-Hour Continuous Workload (TP-15)</text>

    <!-- Memory Metric 1: App Drift Under Load -->
    <g transform="translate(20, 75)">
      <text x="0" y="14" class="mono" font-size="11" font-weight="600" fill="#E2E8F4">App Container Memory Drift Under Load</text>
      <text x="0" y="38" class="mono" font-size="22" font-weight="700" fill="#2EC47C">+3.13 MB</text>
      <text x="140" y="38" class="mono" font-size="13" font-weight="600" fill="#8B9BB4">(pgvector: 574MB → 577MB)</text>

      <text x="0" y="62" class="mono" font-size="16" font-weight="700" fill="#EF4444">+152.7 MB</text>
      <text x="140" y="62" class="mono" font-size="13" font-weight="600" fill="#EF4444">(Chroma HTTP buffer retention)</text>
    </g>

    <line x1="20" y1="150" x2="385" y2="150" stroke="#1C2433" stroke-width="1"/>

    <!-- Live Oscilloscope Telemetry Waveform Strip -->
    <g transform="translate(20, 160)" clip-path="url(#waveClip)">
      <rect x="0" y="0" width="365" height="22" rx="2" fill="#070A0F" stroke="#1C2433" stroke-width="0.8"/>
      <!-- Streaming waveform -->
      <path d="M 0 11 L 80 11 L 88 4 L 96 18 L 104 11 L 220 11 L 228 5 L 236 17 L 244 11 L 365 11" fill="none" stroke="#2EC47C" stroke-width="1.6" class="wave-line"/>
    </g>

    <!-- Memory Metric 2: 24-hr Soak Forensics -->
    <g transform="translate(20, 192)">
      <g transform="translate(0, 12)">
        <text x="0" y="14" class="mono" font-size="10" fill="#8B9BB4">DRIFT RATE:</text>
        <text x="95" y="14" class="mono" font-size="11" font-weight="700" fill="#2EC47C">0.374 MB/hr</text>
        <text x="210" y="14" class="mono" font-size="9.5" fill="#8B9BB4">(SLO &lt; 0.50 MB/hr)</text>
      </g>

      <g transform="translate(0, 32)">
        <text x="0" y="14" class="mono" font-size="10" fill="#8B9BB4">LEAKED FDs:</text>
        <text x="95" y="14" class="mono" font-size="11" font-weight="700" fill="#2EC47C">0 Descriptors</text>
        <text x="210" y="14" class="mono" font-size="9.5" fill="#8B9BB4">(Exact 24 Baseline)</text>
      </g>

      <g transform="translate(0, 52)">
        <text x="0" y="14" class="mono" font-size="10" fill="#8B9BB4">LEAKED DBs:</text>
        <text x="95" y="14" class="mono" font-size="11" font-weight="700" fill="#2EC47C">0 Connections</text>
        <text x="210" y="14" class="mono" font-size="9.5" fill="#8B9BB4">(Clean Cooldown)</text>
      </g>
    </g>
  </g>
</svg>
'''

with open(os.path.join(CHARTS_DIR, "benchmark-latency-memory.svg"), "w") as f:
    f.write(chart_latency_memory_svg)
print("Generated animated assets/charts/benchmark-latency-memory.svg")

# =========================================================================
# 5. CHART 3: MASTER TEST MATRIX (1000 x 480) - AUTOMATED VERIFICATION SCAN
# =========================================================================
chart_matrix_svg = '''<svg width="100%" height="480" viewBox="0 0 1000 480" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chapters Master Test Suite Execution Matrix (TP-01 to TP-15)">
  <defs>
    <linearGradient id="matrixBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0E1422"/>
      <stop offset="100%" stop-color="#070A0F"/>
    </linearGradient>
    <linearGradient id="scanBeamGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#2EC47C" stop-opacity="0"/>
      <stop offset="70%" stop-color="#2EC47C" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#2EC47C" stop-opacity="0.25"/>
    </linearGradient>
    <clipPath id="matrixGridClip">
      <rect x="30" y="80" width="940" height="370" rx="3"/>
    </clipPath>
    <style>
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Geist Mono", monospace; }
      .sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Geist", Helvetica, Arial, sans-serif; }
      
      /* Continuous automated test sweep line across all 15 suites */
      @keyframes matrixSweep {
        0% { transform: translateX(0); }
        100% { transform: translateX(1000px); }
      }
      .matrix-scanner {
        animation: matrixSweep 6.5s infinite linear;
      }
      @media (prefers-reduced-motion: reduce) {
        .matrix-scanner { animation: none !important; }
      }
    </style>
  </defs>

  <rect width="1000" height="480" rx="4" fill="url(#matrixBg)" stroke="#1C2433" stroke-width="1"/>

  <!-- Header -->
  <g transform="translate(30, 24)">
    <text x="0" y="16" class="sans" font-size="18" font-weight="700" fill="#E2E8F4">Master Test Suite Matrix: 15 / 15 Plans Verified (100% SLO Compliance)</text>
    <text x="0" y="36" class="mono" font-size="11.5" fill="#8B9BB4">
      Automated Continuous Telemetry Runs against Contabo Dedicated Production VPS
    </text>
  </g>

  <!-- 15 Test Plan Cards in 5 Columns x 3 Rows - Static clean LEDs, zero jumpy scale -->
  <g transform="translate(30, 80)">
'''

test_plans = [
    # Row 1
    {"id": "TP-01", "name": "IR Retrieval Accuracy", "metric": "NDCG@10 1.37 / 1.15", "col": 0, "row": 0},
    {"id": "TP-02", "name": "AI Agent Navigation", "metric": "90% Goal · 3.0 Turns", "col": 1, "row": 0},
    {"id": "TP-03", "name": "Git Diff &amp; Ghost Purge", "metric": "0 Ghost Symbols", "col": 2, "row": 0},
    {"id": "TP-04", "name": "Chaos Crash Recovery", "metric": "0 Corrupt · 525ms RTO", "col": 3, "row": 0},
    {"id": "TP-05", "name": "Real-Time CRDT Stress", "metric": "20 Clients · 0.09ms", "col": 4, "row": 0},
    
    # Row 2
    {"id": "TP-06", "name": "Scale Volume Soak", "metric": "50k Notes · 35ms p50", "col": 0, "row": 1},
    {"id": "TP-07", "name": "Security Penetration", "metric": "21/21 Vectors Blocked", "col": 1, "row": 1},
    {"id": "TP-08", "name": "Embedding Resilience", "metric": "100% Parity · 0 Lost", "col": 2, "row": 1},
    {"id": "TP-09", "name": "Tree-sitter Torture", "metric": "92,245 LOC / sec", "col": 3, "row": 1},
    {"id": "TP-10", "name": "Context Window Budget", "metric": "1.52% MAPE Accuracy", "col": 4, "row": 1},

    # Row 3
    {"id": "TP-11", "name": "Noisy Neighbor QoS", "metric": "13k Flood · +1.7ms p50", "col": 0, "row": 2},
    {"id": "TP-12", "name": "Pathological Graph", "metric": "10k Edges in 0.65ms", "col": 1, "row": 2},
    {"id": "TP-13", "name": "Multilingual Search", "metric": "100% CJK/RTL · 0.64ms", "col": 2, "row": 2},
    {"id": "TP-14", "name": "Portability &amp; PITR", "metric": "100% OKF · 0 Loss", "col": 3, "row": 2},
    {"id": "TP-15", "name": "24H Memory Soak", "metric": "0.37 MB/hr · 0 Leaks", "col": 4, "row": 2},
]

for tp in test_plans:
    cx = tp["col"] * 190
    cy = tp["row"] * 120
    chart_matrix_svg += f'''
    <g transform="translate({cx}, {cy})">
      <rect x="0" y="0" width="180" height="105" rx="3" fill="#0A0E17" stroke="#1C2433" stroke-width="1"/>
      <!-- Static rock-solid green status pip -->
      <circle cx="16" cy="18" r="3.5" fill="#2EC47C"/>
      <text x="26" y="22" class="mono" font-size="11" font-weight="700" fill="#5B8DEF">{tp['id']}</text>
      <rect x="115" y="10" width="52" height="16" rx="2" fill="#161D2B"/>
      <text x="141" y="21" class="mono" font-size="8.5" font-weight="700" fill="#2EC47C" text-anchor="middle">PASSED</text>
      <text x="14" y="48" class="sans" font-size="11" font-weight="600" fill="#E2E8F4">{tp['name']}</text>
      <line x1="14" y1="62" x2="166" y2="62" stroke="#1C2433" stroke-width="1"/>
      <text x="14" y="82" class="mono" font-size="10.5" font-weight="700" fill="#3FB8AE">{tp['metric']}</text>
      <text x="14" y="96" class="mono" font-size="8.5" fill="#8B9BB4">SLO Verified</text>
    </g>
'''

chart_matrix_svg += '''
  </g>

  <!-- Automated Telemetry Continuous Sweep Beam -->
  <g clip-path="url(#matrixGridClip)">
    <rect x="-60" y="80" width="60" height="370" fill="url(#scanBeamGrad)" class="matrix-scanner"/>
  </g>
</svg>
'''

with open(os.path.join(CHARTS_DIR, "test-matrix-dashboard.svg"), "w") as f:
    f.write(chart_matrix_svg)
print("Generated animated assets/charts/test-matrix-dashboard.svg")

# =========================================================================
# 6. CHART 4: ARCHITECTURAL COMPETITOR MATRIX (1040 x 560) - PERIMETER TRACER
# =========================================================================
competitor_svg = '''<svg viewBox="0 0 1000 560" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Competitive Architectural Matrix: Chapters vs Alternatives">
  <defs>
    <linearGradient id="compBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0E1422"/>
      <stop offset="100%" stop-color="#070A0F"/>
    </linearGradient>
    <linearGradient id="highlightGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#12253B"/>
      <stop offset="100%" stop-color="#0C1726"/>
    </linearGradient>
    <linearGradient id="tagGlow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#5B8DEF"/>
      <stop offset="100%" stop-color="#2EC47C"/>
    </linearGradient>
    <linearGradient id="colSheen" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#5B8DEF" stop-opacity="0"/>
      <stop offset="50%" stop-color="#5B8DEF" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#5B8DEF" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="chaptersColClip">
      <rect x="290" y="0" width="175" height="395" rx="4"/>
    </clipPath>
    <style>
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Geist Mono", monospace; }
      .sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Geist", Helvetica, Arial, sans-serif; }
      
      /* Neon perimeter tracer gliding smoothly around Chapters column */
      @keyframes traceCol {
        to { stroke-dashoffset: -1140; }
      }
      /* Vertical column sheen glide */
      @keyframes sheenDown {
        0% { transform: translateY(-395px); }
        40%, 100% { transform: translateY(395px); }
      }
      
      .perimeter-tracer {
        stroke-dasharray: 100 470;
        animation: traceCol 6s linear infinite;
      }
      .col-sheen-anim {
        animation: sheenDown 6s infinite ease-in-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .perimeter-tracer, .col-sheen-anim {
          animation: none !important;
        }
      }
    </style>
  </defs>

  <rect width="1000" height="560" rx="4" fill="url(#compBg)" stroke="#1C2433" stroke-width="1"/>

  <!-- Header -->
  <g transform="translate(30, 24)">
    <text x="0" y="16" class="sans" font-size="18" font-weight="700" fill="#E2E8F4">Architectural Comparison Matrix: Chapters vs The Alternatives</text>
    <text x="0" y="36" class="mono" font-size="11.5" fill="#8B9BB4">
      Bridging the Gap Between Solitary Desktop Markdown, Closed Corporate Wikis, and Headless AST Scrapers
    </text>
  </g>

  <!-- Table Origin at (30, 75) -->
  <g transform="translate(30, 75)">
    <!-- Column Background for Chapters (Col 2: X=290, W=175, H=395) -->
    <rect x="290" y="0" width="175" height="395" rx="4" fill="url(#highlightGrad)" stroke="#1C2433" stroke-width="1.5"/>
    
    <!-- Vertical Sheen inside Chapters Column -->
    <g clip-path="url(#chaptersColClip)">
      <rect x="290" y="0" width="175" height="150" fill="url(#colSheen)" class="col-sheen-anim"/>
    </g>

    <!-- Animated Neon Perimeter Tracer around Chapters Column -->
    <rect x="290" y="0" width="175" height="395" rx="4" fill="none" stroke="#5B8DEF" stroke-width="2" class="perimeter-tracer"/>

    <!-- Table Header Row (Y=0, H=45) -->
    <rect x="0" y="0" width="940" height="45" fill="#0A0E17" stroke="#1C2433" stroke-width="1"/>
    
    <text x="18" y="27" class="mono" font-size="11" font-weight="700" fill="#8B9BB4">CAPABILITY / DIMENSION</text>
    
    <!-- Chapters Header Cell -->
    <rect x="295" y="6" width="165" height="32" rx="3" fill="url(#tagGlow)"/>
    <text x="377" y="26" class="sans" font-size="11.5" font-weight="800" fill="#070A0F" text-anchor="middle">★ CHAPTERS (ELARA)</text>

    <!-- Competitor Headers -->
    <text x="510" y="27" class="sans" font-size="11.5" font-weight="600" fill="#8B9BB4" text-anchor="middle">Obsidian</text>
    <text x="605" y="27" class="sans" font-size="11.5" font-weight="600" fill="#8B9BB4" text-anchor="middle">Swimm</text>
    <text x="700" y="27" class="sans" font-size="11.5" font-weight="600" fill="#8B9BB4" text-anchor="middle">Graphify</text>
    <text x="795" y="27" class="sans" font-size="11.5" font-weight="600" fill="#8B9BB4" text-anchor="middle">Outline</text>
    <text x="885" y="27" class="sans" font-size="11.5" font-weight="600" fill="#8B9BB4" text-anchor="middle">Notion</text>

    <!-- Row Generator -->
'''

rows = [
    {
        "y": 45,
        "label": "Open-Source &amp; Self-Hostable",
        "chapters": "✓ (MIT License)",
        "c_color": "#2EC47C",
        "obsidian": "⚠️ Local App",
        "swimm": "✕ Closed SaaS",
        "graphify": "✓ Open Source",
        "outline": "✓ Self-Host",
        "notion": "✕ Closed Cloud"
    },
    {
        "y": 95,
        "label": "Plain Markdown on Disk (Google OKF v0.2)",
        "chapters": "✓ Strict ISO 8601",
        "c_color": "#2EC47C",
        "obsidian": "⚠️ Generic MD",
        "swimm": "✕",
        "graphify": "✕",
        "outline": "✕ (DB Store)",
        "notion": "✕ (Locked DB)"
    },
    {
        "y": 145,
        "label": "Real-Time CRDT Multiplayer",
        "chapters": "✓ Yjs CRDT Relay",
        "c_color": "#2EC47C",
        "obsidian": "✕ Git Conflicts",
        "swimm": "✕ PR Workflow",
        "graphify": "✕ Single CLI",
        "outline": "✓ Real-Time",
        "notion": "✓ Cloud OT"
    },
    {
        "y": 195,
        "label": "Git Ingestion &amp; Tree-sitter AST Anchors",
        "chapters": "✓ [[repo:#symbol]]",
        "c_color": "#2EC47C",
        "obsidian": "✕",
        "swimm": "✓ IDE Plugin",
        "graphify": "✓ AST Index",
        "outline": "✕",
        "notion": "✕ (Dead Snippets)"
    },
    {
        "y": 245,
        "label": "Unified Note + Code Knowledge Graph",
        "chapters": "✓ Louvain + Dijkstra",
        "c_color": "#2EC47C",
        "obsidian": "⚠️ Notes Only",
        "swimm": "✕",
        "graphify": "⚠️ Code Only",
        "outline": "✕",
        "notion": "✕"
    },
    {
        "y": 295,
        "label": "Native 57-Tool Model Context Protocol",
        "chapters": "✓ 57 Tools · 20 Prompts",
        "c_color": "#2EC47C",
        "obsidian": "⚠️ Community",
        "swimm": "✕",
        "graphify": "⚠️ CLI Pipe",
        "outline": "✕",
        "notion": "⚠️ REST API"
    },
    {
        "y": 345,
        "label": "High-Throughput Vector Decoupling",
        "chapters": "✓ pgvector + Chroma",
        "c_color": "#2EC47C",
        "obsidian": "✕",
        "swimm": "✕",
        "graphify": "✕",
        "outline": "✕",
        "notion": "✕ (Cloud AI)"
    }
]

for r in rows:
    y = r["y"]
    competitor_svg += f'''
    <!-- Row at Y={y} -->
    <line x1="0" y1="{y}" x2="940" y2="{y}" stroke="#1C2433" stroke-width="1"/>
    <text x="18" y="{y+30}" class="sans" font-size="11.5" font-weight="600" fill="#E2E8F4">{r['label']}</text>
    
    <!-- Chapters Cell (Col 2) - Crisp steady text -->
    <text x="377" y="{y+30}" class="mono" font-size="11" font-weight="700" fill="{r['c_color']}" text-anchor="middle">{r['chapters']}</text>
    
    <!-- Competitor Cells -->
    <text x="510" y="{y+30}" class="mono" font-size="10" fill="#8B9BB4" text-anchor="middle">{r['obsidian']}</text>
    <text x="605" y="{y+30}" class="mono" font-size="10" fill="#8B9BB4" text-anchor="middle">{r['swimm']}</text>
    <text x="700" y="{y+30}" class="mono" font-size="10" fill="#8B9BB4" text-anchor="middle">{r['graphify']}</text>
    <text x="795" y="{y+30}" class="mono" font-size="10" fill="#8B9BB4" text-anchor="middle">{r['outline']}</text>
    <text x="885" y="{y+30}" class="mono" font-size="10" fill="#8B9BB4" text-anchor="middle">{r['notion']}</text>
'''

competitor_svg += '''
    <!-- Bottom Grid Closing Line -->
    <line x1="0" y1="395" x2="940" y2="395" stroke="#1C2433" stroke-width="1"/>
  </g>

  <!-- Bottom Synthesis Callout -->
  <rect x="30" y="495" width="940" height="40" rx="3" fill="#0A0E17" stroke="#1C2433" stroke-width="1"/>
  <circle cx="48" cy="515" r="4" fill="#2EC47C"/>
  <text x="62" y="519" class="mono" font-size="10" fill="#8B9BB4">
    <tspan fill="#E2E8F4" font-weight="700">The Living Second Brain Formula:</tspan> Obsidian's Markdown speed + Outline's team collaboration + Swimm's AST code-coupling + Graphify's agentic MCP navigation.
  </text>
</svg>
'''

with open(os.path.join(CHARTS_DIR, "competitive-matrix.svg"), "w") as f:
    f.write(competitor_svg)
print("Generated animated assets/charts/competitive-matrix.svg")

# =========================================================================
# 7. FOOTER SVG (960 x 80) - STREAMING FIBER ACCENT
# =========================================================================
footer_svg = '''<svg width="100%" height="80" viewBox="0 0 960 80" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Chapters Observatory Telemetry Footer">
  <defs>
    <style>
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      @keyframes footDash {
        to { stroke-dashoffset: -32; }
      }
      .foot-stream {
        stroke-dasharray: 8 8;
        animation: footDash 2s linear infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .foot-stream { animation: none !important; }
      }
    </style>
  </defs>
  <rect width="960" height="80" rx="3" fill="#0A0E17" stroke="#1C2433" stroke-width="1"/>
  
  <!-- Subtle top accent line streaming data -->
  <line x1="0" y1="1" x2="960" y2="1" stroke="#5B8DEF" stroke-width="1" class="foot-stream"/>

  <circle cx="28" cy="40" r="4" fill="#2EC47C"/>
  <text x="42" y="44" class="mono" font-size="11.5" font-weight="600" fill="#E2E8F4">CHAPTERS OBSERVATORY</text>
  <text x="210" y="44" class="mono" font-size="11" fill="#8B9BB4">|</text>
  <text x="225" y="44" class="mono" font-size="11" fill="#8B9BB4">FORGED WITH <tspan fill="#5B8DEF">git-a-profile</tspan> · <tspan fill="#3FB8AE">PIIIX.ORG</tspan></text>
  
  <text x="730" y="44" class="mono" font-size="11" fill="#2EC47C">● 100% REAL HARDWARE DATA</text>
</svg>
'''

with open(os.path.join(TARGET_DIR, "footer.svg"), "w") as f:
    f.write(footer_svg)
print("Generated animated assets/footer.svg")

print("All refined assets forged successfully.")
