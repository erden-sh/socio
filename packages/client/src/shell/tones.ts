import type { Tone } from '../modules/types';

/**
 * A module's identity tile: a tinted square with the icon in the tone's
 * color, readable in light and dark. Literal class names, so Tailwind
 * finds them.
 */
export const toneTile: Record<Tone, string> = {
    mint: 'bg-primary/12 text-primary dark:bg-primary/20',
    sky: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
    amber: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
    violet: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
    emerald: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    orange: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
    slate: 'bg-slate-500/12 text-slate-700 dark:text-slate-300',
    indigo: 'bg-indigo-500/12 text-indigo-700 dark:text-indigo-300',
    rose: 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
};
