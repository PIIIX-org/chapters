# Current System State

## Typography
- **Faces**: Geist Variable (primary UI face), Geist Mono Variable (mono face).
- **Base**: `14px` size, `1.45` line height.
- **Heading Scale**: `font-display` inherits `font-sans`. No distinct display face scale rendered.

## Palette
- **Default**: Dark mode (`--background: #0b0e14`, `--card: #12161e`)
- **Secondary**: Light mode (`--background: #f5f6f8`, `--card: #ffffff`)
- **Roles**: Primary (`#5b8def` dark / `#2f6fe0` light), Accent (`#3fb8ae` dark / `#1f7770` light), Success (`#4cc38a`), Warning (`#e6b455`), Destructive (`#f26d6d`).
- **Collaborator Inks**: Vermillion, Indigo, Plum, Ochre, Forest, Teal.

## Geometry and Interactions
- **Target Sizes**: Interactive elements (buttons, inputs) fall into `size-8` (32px) and `size-9` (36px).
- **Shell Layout**: Topbar is `44px`, rail is `52px`, context pane is `264px`, inspector is `320px`.
- **Under 44px Net**: Standard interactive targets are under the 44px touch net.

## Performance Read
- **Shell Weight**: `index-*.css` is ~77.8KB (13.7KB gzipped).
- **LCP Path**: Entry bundle blocks LCP. No lazy chunk optimizations extracted.
