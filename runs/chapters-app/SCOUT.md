# Scout Positioning & Classification

## Positioning
- **Closest Family**: Control Room
- **Evidence**: Dark default background `#0b0e14`, monospace UI pairings (`Geist Mono`), tight structural geometry (`44px` topbar, `32px` inputs), utility-driven interface.
- **Choice vs. Accident**: Accident. The user states the UI was quickly built for beta testing functionality and is now approaching MVP. It is a functional skeleton, not a designed position.
- **Human Question**: Is the current "Control Room" aesthetic a deliberate choice for the MVP, or purely a side-effect of rapid development?

## Proposed Classification: Reposition
- **Evidence**: The system is a raw beta skeleton with numerous missing structural states and an unrefined typographic and interaction scale. It requires elevation to an authentic, high-craft MVP.
- **Consequence**: Runs Loop 1 in full with `CURRENT.md` as an input constraint.

## Absence Sweep
- **Data States**: The 9 data states (empty, loading, partial, error, permission denied, offline, stale, conflict, bulk) are absent across views (notes, repos, graph, team, admin).
- **Structural Omissions**: No custom 404, no skip link, no back navigation out of a flow, no form validation, no legal links, no cookie consent.

## Draft Survival List (Unconfirmed)
- Product Name
- Dark mode as default
- Geist and Geist Mono font pairings
- Core shell geometry (rail and context panes)
- Collaborator ink hues

## Limits on Measurement
- Viewports could not be reached dynamically.
- Pages behind authentication could not be fully swept.
- Static code sweep could not reliably confirm absence of dynamic React fallbacks (e.g. suspense boundaries might exist but not handle specific data states).
- Could not reach specific error or offline states deliberately.
