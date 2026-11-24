/**
 * Where turns come from (CB-164): an open registry, not a fixed list.
 * A run stores its source as a key (`agent_runs.source`); a module that
 * adds a channel registers its key here (Telegram does in
 * `@socio/foundation/telegram/run-source`), and the Operations analytics turn the
 * entries into its `d_source` dimension. A key nobody registered still
 * shows, as itself, with kind `unknown`.
 */

/**
 * Who starts a source's turns: `human` (a person wrote, so its messages
 * count as use) or `automation` (a schedule), reported
 * apart. `unknown`: a key no module registered.
 */
export type RunSourceKind = 'human' | 'automation' | 'unknown';

/**
 * What starts an automation's turns, as runs record it (CB-185): used for
 * turns stored before runs recorded who started them.
 */
export type RunSourceActor = 'schedule' | 'agent' | 'system';

export interface RunSource {
    /** As stored in `agent_runs.source`: short, no spaces. */
    key: string;
    /** What admins read: "Telegram". */
    label: string;
    kind: Exclude<RunSourceKind, 'unknown'>;
    /** The channel it arrives on: `web`, `telegram`, `voice`, `schedule`… */
    channel: string;
    /** For an automation: what starts its turns. */
    actor?: RunSourceActor;
    /**
     * The source's chats, for turns that don't record their source (the
     * browser's and the channel's own turns take their chat's): a table
     * and its thread id column. A turn whose chat is in it is this source.
     */
    threads?: { table: string; column: string };
}

/** A source as analytics shows it: registered, or `unknown`. */
export type RunSourceView = Omit<RunSource, 'kind'> & { kind: RunSourceKind };

/** A turn with no source recorded, and in no source's chats, is the web app's. */
export const UNRECORDED_SOURCE = 'web';

const KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const IDENTIFIER = /^[A-Za-z_]\w{0,63}$/;
const registry = new Map<string, RunSource>();

/**
 * Adds a source, or replaces the one with its key (a module loaded twice).
 * Returns it, so a module can keep it as a constant.
 */
export function registerRunSource(source: RunSource): RunSource {
    if (!KEY.test(source.key)) {
        throw new Error(`A run source key must be short and plain: ${source.key}`);
    }
    if (source.threads && !(IDENTIFIER.test(source.threads.table) && IDENTIFIER.test(source.threads.column))) {
        throw new Error(`A run source's threads must name a table and a column.`);
    }
    const entry = Object.freeze({ ...source });
    registry.set(source.key, entry);
    return entry;
}

/** Every registered source, in the order they were registered. */
export function runSources(): RunSource[] {
    return [...registry.values()];
}

/** The source of `key`; one nobody registered shows as itself, `unknown`. */
export function runSource(key: string): RunSourceView {
    return registry.get(key) ?? { key, label: key, kind: 'unknown', channel: key };
}

// The app's own; modules add theirs.
registerRunSource({
    key: 'web',
    label: 'Web app',
    kind: 'human',
    channel: 'web',
});
registerRunSource({
    key: 'voice',
    label: 'Voice call',
    kind: 'human',
    channel: 'voice',
});
registerRunSource({
    key: 'scheduled',
    label: 'Schedule',
    kind: 'automation',
    channel: 'schedule',
    actor: 'schedule',
});
