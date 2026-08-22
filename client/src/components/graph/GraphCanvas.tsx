// Stub for unit 1c, which mounts the real community-cluster graph renderer
// here. This file exists now so the lazy() code-split boundary in
// HomePage.tsx is real from this commit (spec decision 9): the graph chunk
// must build and load separately from the initial bundle, not just be
// planned for later.
export default function GraphCanvas() {
  return (
    <div data-testid="graph-canvas" className="flex h-full w-full items-center justify-center bg-background">
      <p className="text-muted-foreground">The graph renders here.</p>
    </div>
  )
}
