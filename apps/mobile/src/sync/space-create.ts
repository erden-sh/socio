import type { SpaceCreateRequest } from '@socio/shared/spaces/create-input';
import type { Space } from '@socio/shared/types';

import type { AuthedFetch } from '../net/authed-fetch';

import { readAnswer } from './outbox-answers';
import type { WriteHold } from './session';
import type { NetworkSource } from './triggers';

// New Space (CB-410), the scope's `spaceCreate`: the web's create dialog's
// one request, `POST /api/spaces` with `{name, description, private}`
// (packages/client's WorkspaceDialog, src/server/workspace/workspace-routes.ts),
// online only, never through the outbox:
// - **Online only:** the server picks the Space's id and checks who may create
//   one (`spaceCreators`) and who it is for, and the Space is nothing on the
//   phone until the shell lists it: no page, memory or socio can go into it
//   before then. So it is refused before any request (`blocked()`) while NetInfo
//   says offline, the server is away (the scheduler's "Reconnecting…") or writes
//   wait (`writeHold`), and the form says "Needs a connection".
// - **One at a time** (`busy`), the wait for the list included, so a second tap
//   on Create can't make a second Space.
// - **201 answers the Space**; then the shell is pulled and the create resolves
//   once the Spaces list holds it (`listed`, awaited), so its screen opens on it.
// - **Refusals are told by status** (403: the permission; 400: the name), never
//   the server's text (10.2). A lost answer or a 5xx may still have made it:
//   the shell is pulled, and the form says to check the list first.
// No React Native: tests/sync runs it under Node against a fake fetch.

/** Why nothing can be sent now. */
export type SpaceCreateBlock = 'offline' | 'away' | 'sign-in' | 'update';

/** What a create came to. */
export type SpaceCreateOutcome =
    /** The server made it, and the Spaces list holds it (or a while passed). */
    | { readonly kind: 'done'; readonly space: Space }
    /** Nothing was sent (offline, away, a sign-in or an update). */
    | { readonly kind: 'blocked'; readonly reason: SpaceCreateBlock }
    /** Nothing was sent: a create is in flight. */
    | { readonly kind: 'busy' }
    /** Refused: its `code`, else `http-<status>`. */
    | { readonly kind: 'refused'; readonly reason: string }
    /** It went and no answer came, or the server failed: the Space may be there. */
    | { readonly kind: 'no-answer' };

export interface SpaceCreateOptions {
    readonly fetch: AuthedFetch;
    readonly network: NetworkSource;
    /** Whether the server is away (the scheduler's status). */
    readonly away: () => boolean;
    /** Why writes wait (session.ts's `writeHold`). */
    readonly hold: () => WriteHold;
    /** Pulls the shell; resolves once the Spaces list holds `spaceId` (or a while passed). */
    readonly listed: (spaceId: string) => Promise<void>;
    /** Pulls the shell, after an answer that may hide a Space made. */
    readonly refresh: () => void;
}

export interface SpaceCreate {
    /** Why nothing can be sent now, or null. */
    blocked(): SpaceCreateBlock | null;
    /** Whether a create is in flight. */
    busy(): boolean;
    /** Calls `listener` after each change of `blocked()` or `busy()`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Makes the Space, as the web's dialog does. */
    create(input: Pick<SpaceCreateRequest, 'name' | 'description' | 'private'>): Promise<SpaceCreateOutcome>;
    /** Stops listening to the network. */
    dispose(): void;
}

export const SPACES_PATH = '/api/spaces';

const isSpace = (value: unknown): value is Space =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id !== '' &&
    typeof (value as { name?: unknown }).name === 'string';

export function createSpaceCreate(options: SpaceCreateOptions): SpaceCreate {
    const { fetch, network, away, hold, listed, refresh } = options;
    const listeners = new Set<() => void>();
    let inFlight = false;
    let connected: boolean | null = null;
    const tell = () => {
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const unsubscribe = network.subscribe((next) => {
        if (next.connected !== null && next.connected !== connected) {
            connected = next.connected;
            tell();
        }
    });
    network
        .current()
        .then((next) => {
            if (connected === null && next.connected !== null) {
                connected = next.connected;
                tell();
            }
        })
        .catch(() => {});

    const blocked = (): SpaceCreateBlock | null => {
        if (connected === false) {
            return 'offline';
        }
        if (away()) {
            return 'away';
        }
        return hold();
    };

    const send = async (json: unknown): Promise<SpaceCreateOutcome> => {
        let answer;
        try {
            answer = await readAnswer(await fetch(SPACES_PATH, { method: 'POST', json }));
        } catch {
            refresh();
            return { kind: 'no-answer' };
        }
        if (answer.status >= 200 && answer.status < 300) {
            if (!isSpace(answer.body)) {
                refresh();
                return { kind: 'no-answer' };
            }
            await listed(answer.body.id).catch(() => {});
            return { kind: 'done', space: answer.body };
        }
        if (answer.status >= 500) {
            refresh();
            return { kind: 'no-answer' };
        }
        return { kind: 'refused', reason: answer.code ?? `http-${answer.status}` };
    };

    return {
        blocked,
        busy: () => inFlight,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async create(input) {
            const reason = blocked();
            if (reason !== null) {
                return { kind: 'blocked', reason };
            }
            if (inFlight) {
                return { kind: 'busy' };
            }
            inFlight = true;
            tell();
            try {
                return await send({
                    name: input.name.trim(),
                    description: input.description.trim(),
                    private: input.private === true,
                });
            } finally {
                inFlight = false;
                tell();
            }
        },
        dispose() {
            unsubscribe();
            listeners.clear();
        },
    };
}
