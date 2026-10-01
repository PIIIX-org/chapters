import { cva } from 'class-variance-authority'

/**
 * `default` is the human accent: a primary button is a person committing to
 * something. `bg-accent` (AI) is never a button colour.
 */
export const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center rounded-md border border-transparent text-sm font-medium whitespace-nowrap outline-none select-none transition-all duration-100 cursor-pointer focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.96] active:translate-y-[0.5px] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 after:absolute after:inset-y-1/2 after:inset-x-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:min-w-[44px] after:min-h-[44px] after:content-[''] md:after:hidden",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90 hover:brightness-105 hover:shadow-xs active:bg-primary/95',
        outline:
          'border-border bg-card text-foreground hover:border-foreground/25 hover:bg-muted hover:text-foreground hover:shadow-xs active:bg-muted/80 aria-expanded:bg-muted aria-pressed:bg-muted',
        secondary:
          'bg-muted/80 text-foreground border border-border/40 hover:bg-muted hover:border-border/70 hover:text-foreground active:bg-muted/90 aria-expanded:bg-muted',
        ghost:
          'text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/80 aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground',
        destructive:
          'bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20 hover:border-destructive/40 hover:text-destructive active:bg-destructive/30 focus-visible:border-destructive/40 focus-visible:ring-destructive/30',
        link: 'text-primary underline-offset-4 hover:underline active:opacity-80',
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
