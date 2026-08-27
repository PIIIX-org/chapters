const STEPS = ['Create account', 'Confirm your email', 'Admin approval', 'Sign in'] as const

export type AuthStep = (typeof STEPS)[number]

interface AuthStepsProps {
  current: AuthStep
}

/**
 * The whole route from stranger to signed-in, shown from the first screen.
 *
 * The point is step 3. Signup leaves an account `pending_approval` with an
 * unverified address, and login requires both settled — so there is a stretch
 * where the person has done everything they can and nothing appears to happen.
 * The login screen deliberately will not explain it (saying "pending approval"
 * there tells a stranger the address has an account here), so the only honest
 * place to say what is going on is here, before they get stuck in it.
 *
 * Not rendered on `/login`: that is the everyday sign-in page, and a returning
 * user does not need a four-step onboarding every morning.
 */
export function AuthSteps({ current }: AuthStepsProps) {
  const currentIndex = STEPS.indexOf(current)

  return (
    <ol
      aria-label="Getting in"
      className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      {STEPS.map((step, i) => {
        const done = i < currentIndex
        const active = i === currentIndex
        return (
          <li key={step} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden="true">→</span>}
            <span
              // aria-current, not colour alone: the step someone is on has to
              // reach a screen reader too.
              aria-current={active ? 'step' : undefined}
              className={active ? 'font-medium text-foreground' : done ? 'text-muted-foreground' : 'text-muted-foreground/60'}
            >
              {done && <span className="sr-only">Done: </span>}
              {step}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
