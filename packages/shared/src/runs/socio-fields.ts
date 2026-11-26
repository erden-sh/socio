/**
 * Socio's own fields on AG-UI events and messages: a RUN_ERROR's
 * `errorDetail` (the agent's to the runner, never a client's), and a
 * transcript message's `author` and `at`.
 *
 * AG-UI 1.0's client takes off every top-level field the protocol doesn't
 * define, in the browser and on the server alike (`runAgent`, a replay), so
 * these travel in `metadata`, which it keeps, and only there. Readers prefer
 * `metadata` and fall back to the top level, where a server from before 1.0
 * wrote them (records and responses a client kept from then).
 */

import type { MessageAuthor } from '../types.js';

type Fields = Record<string, unknown>;

const metadataOf = (value: unknown): Fields | undefined => {
    const metadata = value && typeof value === 'object' ? (value as { metadata?: unknown }).metadata : undefined;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Fields) : undefined;
};

/**
 * `target` with `fields` set in its `metadata` (with what it held). A field
 * whose value is undefined is left out.
 */
export function withSocioFields<T extends object>(target: T, fields: Fields): T {
    const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    if (!Object.keys(given).length) {
        return target;
    }
    return {
        ...target,
        metadata: { ...metadataOf(target), ...given },
    };
}

/** A Socio field of an event or message: its `metadata` copy, else its top-level one. */
export function socioField(source: unknown, name: string): unknown {
    const metadata = metadataOf(source);
    if (metadata && metadata[name] !== undefined) {
        return metadata[name];
    }
    // What a server from before AG-UI 1.0 wrote: top level only. Kept for
    // records stored then; nothing writes it there now.
    return source && typeof source === 'object' ? (source as Fields)[name] : undefined;
}

/**
 * `source` without the named Socio fields, in either place; the same object
 * when it has none. Its `metadata` goes when nothing else is left in it.
 */
export function withoutSocioFields<T extends object>(source: T, names: readonly string[]): T {
    const fields = source as Fields;
    const metadata = metadataOf(source);
    if (!names.some((name) => name in fields || (metadata && name in metadata))) {
        return source;
    }
    const rest: Fields = { ...fields };
    for (const name of names) {
        delete rest[name];
    }
    if (metadata) {
        const kept = { ...metadata };
        for (const name of names) {
            delete kept[name];
        }
        if (Object.keys(kept).length) {
            rest.metadata = kept;
        } else {
            delete rest.metadata;
        }
    }
    return rest as T;
}

/**
 * A RUN_ERROR's operator detail, as an agent writes it for the runner
 * (`LocalAgentRunner` keeps it in `agent_runs.errorDetail` and takes it off
 * the event, so no client gets it). In `metadata`, and at the top level for
 * the server's own reader (the Dot agent's failure log, `dots/dot-agent.ts`):
 * neither copy ever leaves the server.
 */
export const errorDetailFields = (detail: string) => ({
    errorDetail: detail,
    metadata: { errorDetail: detail },
});

/** Who wrote a transcript message (CB-66), as the server says: `metadata.author`, else the top level. */
export const messageAuthor = (message: unknown): MessageAuthor | undefined => {
    const author = socioField(message, 'author');
    return author && typeof author === 'object' ? (author as MessageAuthor) : undefined;
};

/** When a transcript message was written (CB-72): `metadata.at`, else the top level. */
export const messageAt = (message: unknown): number | undefined => {
    const at = socioField(message, 'at');
    return typeof at === 'number' ? at : undefined;
};
