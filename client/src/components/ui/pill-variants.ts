import { cva } from 'class-variance-authority'

/**
 * Tones carry meaning, not decoration: `human` is the person accent, `ai` the
 * AI/MCP accent (never a hover colour), the rest are semantic status.
 */
export const pillVariants = cva(
  'inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border px-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        live: 'border-success/40 bg-success/10 text-success',
        idle: 'border-warning/40 bg-warning/10 text-warning',
        error: 'border-destructive/40 bg-destructive/10 text-destructive',
        human: 'border-primary/40 bg-primary/10 text-primary',
        ai: 'border-accent/40 bg-accent/10 text-accent',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)
