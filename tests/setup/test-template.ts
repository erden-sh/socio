import { rmSync } from 'node:fs';

import { prepareTestTemplate } from '../helpers/test-template-build.js';

/**
 * Vitest global setup: the migrated template every `testDatabase()` copies,
 * made once per run. The workers inherit its path through the environment.
 * Watch mode keeps it until restarted, so restart after editing a migration.
 */
export default function setup() {
    const directory = prepareTestTemplate();
    return () => rmSync(directory, { recursive: true, force: true });
}
