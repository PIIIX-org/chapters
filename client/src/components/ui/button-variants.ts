import { cva } from 'class-variance-authority'

/**
 * `default` is the human accent: a primary button is a person committing to
 * something. `bg-accent` (AI) is never a button colour.
 */
export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent text-sm font-medium whitespace-nowrap outline-none select-none transition-colors duration-100 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        outline:
          'border-border bg-card text-foreground hover:border-input hover:bg-muted aria-expanded:bg-muted aria-pressed:bg-muted',
        secondary:
          'bg-muted text-foreground hover:bg-input/60 aria-expanded:bg-input/60',
        ghost:
          'text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/30',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 gap-1.5 px-3',
        xs: 'h-6 gap-1 rounded-sm px-2 text-xs [&_svg:not([class*="size-"])]:size-3',
        sm: 'h-7 gap-1 px-2.5 text-[13px] [&_svg:not([class*="size-"])]:size-3.5',
        lg: 'h-9 gap-2 px-4',
        icon: 'size-8',
        'icon-xs': 'size-6 rounded-sm [&_svg:not([class*="size-"])]:size-3',
        'icon-sm': 'size-7 [&_svg:not([class*="size-"])]:size-3.5',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)
