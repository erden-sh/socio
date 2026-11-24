#!/usr/bin/env node
// Keeps released migrations as they shipped. A database records each
// migration's checksum when it runs it, and a later build that changes the
// migration makes every boot report "Migration … changed after it was
// applied" (v0.30.0's formatting pass did that to ten of them). The checksum
// hashes the compiled source (`String(up)` for a function migration), so
// this reads the server build, the code a database actually runs:
//
//   node scripts/released-migrations.mjs            check (run by the build)
//   node scripts/released-migrations.mjs --record   at a release (scripts/release.mjs)
//
// src/server/modules/released-migrations.json holds the checksum of every
// migration in the release package.json names. The check fails when one of
// them changed or is gone, and when the file is for another release. A
// migration not released yet isn't in it and can still change. To change
// what a released migration does, add a new one; for a change in form only,
// put the old checksum in the migration's `formerChecksums` and restore the
// entry here.
//
// --record adds the migrations the file doesn't have and sets its release
// to package.json's version; it never changes an entry.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LOCK = 'src/server/modules/released-migrations.json';

/** `module version` to checksum, for every migration of every set. */
export function checksums(schemas, checksum) {
    const out = {};
    for (const set of schemas) {
        for (const migration of set.migrations ?? []) {
            out[`${set.id} ${migration.version}`] = checksum(migration);
        }
    }
    return out;
}

/** What is wrong with the build against the file, one line each. */
export function problems(lock, current, version) {
    const lines = [];
    if (lock.release !== `v${version}`) {
        lines.push(
            `${LOCK} is for ${lock.release}, but package.json is ${version}: run node scripts/released-migrations.mjs --record after building the release.`,
        );
    }
    for (const [key, sum] of Object.entries(lock.checksums)) {
        if (!(key in current)) {
            lines.push(`Migration ${key} was released in ${lock.release} and is gone.`);
        } else if (current[key] !== sum) {
            lines.push(
                `Migration ${key} was released in ${lock.release} and changed (checksum ${sum}, now ${current[key]}). Add a new migration instead; if only its form changed, restore it.`,
            );
        }
    }
    return lines;
}

/** The file with the migrations it lacks, for `version`. */
export function record(lock, current, version) {
    const merged = { ...current, ...lock.checksums };
    const keys = Object.keys(merged).sort((a, b) => {
        const [am, av] = a.split(' ');
        const [bm, bv] = b.split(' ');
        return am === bm ? Number(av) - Number(bv) : am < bm ? -1 : 1;
    });
    return { release: `v${version}`, checksums: Object.fromEntries(keys.map((key) => [key, merged[key]])) };
}

async function main(argv) {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    const { schemas } = await import(pathToFileURL('dist/server/server/modules/index.js').href);
    const { migrationChecksum } = await import(
        pathToFileURL('dist/server/node_modules/@socio/data/dist/migrate.js').href
    );
    const current = checksums(schemas, migrationChecksum);
    if (argv.includes('--record')) {
        const changed = problems(lock, current, lock.release.slice(1));
        if (changed.length) {
            throw new Error(changed.join('\n'));
        }
        writeFileSync(LOCK, `${JSON.stringify(record(lock, current, version), null, 4)}\n`);
        return;
    }
    const found = problems(lock, current, version);
    if (found.length) {
        throw new Error(found.join('\n'));
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main(process.argv.slice(2)).then(
        // The server's modules may leave handles open; nothing else runs here.
        () => process.exit(0),
        (error) => {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        },
    );
}
