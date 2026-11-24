// Dry run: what the next boot would migrate in DATABASE_PATH (or the file
// given), without writing to it. Exits 1 if this build would refuse it.
import { DatabaseSync } from 'node:sqlite';

import { planMigrations } from '@socio/data/migrate';

import { schemas } from './index.js';

const database = process.argv[2] ?? process.env.DATABASE_PATH ?? 'data/company-brain.sqlite';
try {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
        const steps = planMigrations(db, schemas, { strict: true });
        if (!steps.length) {
            console.log('Up to date: nothing to migrate.');
        }
        for (const step of steps) {
            console.log(
                `${step.module} ${step.version} (${step.name}): ${step.action === 'adopt' ? 'adopt, its objects already exist' : 'apply'}`,
            );
        }
    } finally {
        db.close();
    }
} catch (error) {
    console.error(`Migration check failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
}
