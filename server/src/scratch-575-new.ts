// Scratch PR for #575 (fails-before proof (a)); never merged. A new module:
// its test cannot load on the base commit, which the check reports as
// "suite failed to load", not as a failing test.
export function scratch575(): number {
  return 575
}
