/** Class names joined, the false and empty ones left out. Write each name in full: Tailwind finds them in the source. */
export const cx = (...names: readonly (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');
