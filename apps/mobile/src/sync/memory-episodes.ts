import type { Episode, EpisodesState } from '@socio/shared/memory';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { readAnswer } from './outbox-answers';

// The person's episodes on Memories (the web's EpisodesSection,
// CB-180): what their socios kept of their own chats once those were
// compacted. Read online only, as the web reads them
// (`GET /api/memories/episodes?q=`), never kept on the phone: they are
// recalled in chats, not a list the person works through offline.
// Deleting is **online only and never queued or retried**:
// `DELETE /memories/episodes/:id` and `DELETE /memories/episodes` are hard
// deletes on the server, and "Delete all" removes whatever exists when it arrives, so a
// late one would take episodes the person never saw. Offline nothing is sent
// ("Needs a connection"). A request that went and got no answer is never sent
// again by itself.
// No React Native: tests/sync runs it under Node against a fake fetch.

/** The server's longest query (`z.string().max(300)`). */
export const EPISODE_QUERY_MAX = 300;
/** How long after the last keystroke the server is asked (the web's 250 ms). */
export const EPISODE_SEARCH_DELAY_MS = 250;

const EPISODES_PATH = '/api/memories/episodes';

/** The episodes' path, with the search when there is one. */
export function episodesPath(query: string): string {
    const words = query.trim().slice(0, EPISODE_QUERY_MAX);
    return words === '' ? EPISODES_PATH : `${EPISODES_PATH}?q=${encodeURIComponent(words)}`;
}

const isEpisode = (value: unknown): value is Episode => {
    const item = value as Partial<Episode> | null;
    return (
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.text === 'string' &&
        typeof item.threadId === 'string' &&
        typeof item.occurredAt === 'number' &&
        (item.kind === 'fact' || item.kind === 'summary')
    );
};

/** The person's episodes, newest first, or those matching `query`; rejects on no answer, a refusal or another body. */
export async function readEpisodes(fetch: AuthedFetch, query: string, signal?: AbortSignal): Promise<EpisodesState> {
    const response = await fetch(episodesPath(query), signal === undefined ? {} : { signal });
    if (!response.ok) {
        throw new Error(`The episodes answered ${response.status}.`);
    }
    const body = (await readJson(response, signal)) as Partial<EpisodesState> | null;
    if (
        !Array.isArray(body?.episodes) ||
        !body.episodes.every(isEpisode) ||
        typeof body.total !== 'number' ||
        typeof body.retentionDays !== 'number'
    ) {
        throw new Error('The episodes answered something else.');
    }
    return { episodes: body.episodes, total: body.total, retentionDays: body.retentionDays };
}

/** What an episode delete came to. */
export type EpisodeDeleteResult =
    /** The server took it (or the episode was already gone). */
    | { readonly outcome: 'done' }
    /** No connection: nothing was sent. */
    | { readonly outcome: 'offline' }
    /** It went and no answer came: it may have landed, and it is never sent again by itself. */
    | { readonly outcome: 'no-answer' }
    /** Refused, as `http-<status>`. */
    | { readonly outcome: 'refused'; readonly reason: string };

export interface EpisodeContext {
    /** The open scope's authedFetch. */
    readonly fetch: AuthedFetch;
    /** NetInfo's `isConnected`, false while the server is away too: false sends nothing; null (not known yet) tries. */
    readonly connected: boolean | null;
}

/** The words for a delete that didn't happen; any other refusal gets `EPISODE_DELETE_FALLBACK`. */
export const EPISODE_DELETE_COPY: Readonly<Record<string, string>> = {
    offline: 'Needs a connection',
    'no-answer': 'No answer from the workspace. Check before you try again.',
    'http-401': 'Sign in again to do this',
    'http-429': 'Too many tries. Wait a moment.',
};
export const EPISODE_DELETE_FALLBACK = 'Couldn’t delete. Try again.';

/** What a result says on screen, or null when it worked. */
export function episodeDeleteCopy(result: EpisodeDeleteResult): string | null {
    switch (result.outcome) {
        case 'done':
            return null;
        case 'offline':
        case 'no-answer':
            return EPISODE_DELETE_COPY[result.outcome]!;
        default:
            return EPISODE_DELETE_COPY[result.reason] ?? EPISODE_DELETE_FALLBACK;
    }
}

/** One delete: sent once, never queued, never retried. */
async function once(context: EpisodeContext, path: string, goneIsDone: boolean): Promise<EpisodeDeleteResult> {
    if (context.connected === false) {
        return { outcome: 'offline' };
    }
    let status: number;
    try {
        status = (await readAnswer(await context.fetch(path, { method: 'DELETE' }))).status;
    } catch {
        return { outcome: 'no-answer' };
    }
    if ((status >= 200 && status < 300) || (goneIsDone && status === 404)) {
        return { outcome: 'done' };
    }
    return { outcome: 'refused', reason: `http-${status}` };
}

/** Deletes one episode. A 404 is done: it is gone already (deleted elsewhere, or aged out). */
export const deleteEpisode = (context: EpisodeContext, id: string) =>
    once(context, `${EPISODES_PATH}/${encodeURIComponent(id)}`, true);

/** Deletes every episode the person has when it arrives. */
export const deleteAllEpisodes = (context: EpisodeContext) => once(context, EPISODES_PATH, false);
