import type { Migration, SchemaSet } from './migrate.js';

/**
 * The newest migration of each module from before the expand/contract rule
 * (CB-108): those ran only under stop-first deploys and are not checked.
 * Never raise a number here; a module that isn't listed (a new one) is
 * checked from its first migration.
 */
export const CONTRACT_BASELINE: Readonly<Record<string, number>> = {
    core: 7,
    workspace: 15,
    'schedule-tasks': 2,
    auth: 3,
    'agent-grants': 1,
    pages: 9,
    computers: 2,
    channels: 1,
    inference: 2,
    web: 1,
    spaces: 0,
    telegram: 1,
    learning: 3,
    runs: 4,
    chat: 7,
    memories: 1,
    issues: 13,
    dispatch: 3,
    approvals: 4,
    data: 9,
    media: 4,
    apps: 5,
    schedules: 8,
    domains: 2,
    notifications: 2,
    'chat-skills': 3,
    operations: 3,
    'mcp-connections': 1,
    'change-counters': 1,
};

/**
 * What only a contract migration may do: remove or rename something the
 * previous release still uses, delete its rows, or tighten what it may
 * write (a unique index on an existing table, a trigger that refuses).
 */
const CONTRACT_ONLY: readonly { pattern: RegExp; what: string }[] = [
    { pattern: /\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER|COLUMN)\b/i, what: 'DROP' },
    { pattern: /\bRENAME\b/i, what: 'RENAME' },
    { pattern: /\bDELETE\s+FROM\b/i, what: 'DELETE FROM' },
    { pattern: /\bCREATE\s+UNIQUE\s+INDEX\b/i, what: 'CREATE UNIQUE INDEX' },
    { pattern: /\bRAISE\s*\(/i, what: 'a refusing trigger (RAISE)' },
];

const source = (migration: Migration) => (typeof migration.up === 'string' ? migration.up : String(migration.up));

/**
 * Breaches of the expand/contract rule in `sets`, one line each; empty
 * when every migration newer than the baseline follows it.
 */
export function contractViolations(
    sets: readonly SchemaSet[],
    baseline: Readonly<Record<string, number>> = CONTRACT_BASELINE,
): string[] {
    const found: string[] = [];
    for (const set of sets) {
        const from = baseline[set.id] ?? 0;
        for (const migration of set.migrations ?? []) {
            if (migration.version <= from) {
                continue;
            }
            const name = `${set.id} ${migration.version} (${migration.name})`;
            if (migration.phase === 'contract') {
                if (migration.readersFrom === undefined) {
                    found.push(
                        `${name}: a contract migration names readersFrom, the oldest ${set.id} version a build must know to run on it (its own version if no older build may).`,
                    );
                }
                continue;
            }
            if (migration.compatible?.trim()) {
                continue;
            }
            const text = source(migration);
            for (const { pattern, what } of CONTRACT_ONLY) {
                if (pattern.test(text)) {
                    found.push(
                        `${name}: ${what} is a contract change. Ship it as phase 'contract' a release after the code stopped using what it removes, or say why it is compatible.`,
                    );
                }
            }
        }
    }
    return found;
}
