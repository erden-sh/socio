import type { JobEntry } from './schedule-types.js';

/** Execute the fixed entry file, without Bun's package-script lookup. */
export function jobEntryCommand(entry: JobEntry): string {
    // `bun run` cannot load nested job directories with private ancestors.
    // Direct file execution keeps the private-home permissions intact.
    return entry === 'main.ts' ? 'bun ./main.ts' : 'bash main.sh';
}
