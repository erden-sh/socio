/**
 * A light shimmer across a label while something runs (the running turn's
 * status line, its trace's "Thinking" and "Working"), instead of bouncing
 * dots. Still, in the muted color, when the reader asks for reduced
 * motion.
 */
export const shimmer =
    'animate-shimmer bg-[linear-gradient(90deg,var(--muted-foreground)_0%,var(--muted-foreground)_40%,var(--foreground)_50%,var(--muted-foreground)_60%,var(--muted-foreground)_100%)] bg-size-[250%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted-foreground';
