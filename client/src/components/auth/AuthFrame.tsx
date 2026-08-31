import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader } from '../ui/card.js'
import { Eyebrow } from '../ui/eyebrow.js'
import { AuthSteps, type AuthStep } from './AuthSteps.js'

interface AuthFrameProps {
  /** Mono machine label above the title — what part of the door this is. */
  eyebrow: string
  title: string
  /** Onboarding pages show where the person is on the route in. */
  step?: AuthStep
  children: ReactNode
}

/**
 * The one wrapper every auth page shares: centred 360px card on the canvas,
 * dotted-grid backdrop, wordmark, mono eyebrow, optional steps indicator.
 * These pages render outside the shell — before sign-in there is no shell —
 * so the frame is the whole viewport and carries the page's `main` landmark.
 */
export function AuthFrame({ eyebrow, title, step, children }: AuthFrameProps) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6">
      {/* The spec's sanctioned backdrop: dotted grid in the hairline colour,
          drawn behind the card, invisible to assistive tech. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:24px_24px]"
      />
      <main className="relative flex w-[360px] max-w-full flex-col gap-4">
        <p className="flex items-center gap-2.5">
          {/* Same mark as the shell rail, so the door matches the house. */}
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-md bg-foreground font-mono text-[12px] font-semibold text-background"
          >
            Ch
          </span>
          <span className="text-sm font-medium text-foreground">Chapters</span>
        </p>
        <Card className="w-full">
          <CardHeader>
            <Eyebrow as="p">{eyebrow}</Eyebrow>
            <h1 className="text-xl leading-7 font-semibold text-foreground">
              {title}
            </h1>
          </CardHeader>
          <CardContent>
            {step && <AuthSteps current={step} />}
            {children}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
