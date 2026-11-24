import { MAX_CHAT_TITLE } from '@socio/shared/types';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

// The name-suggestion card (CB-292, the web's NameSuggestionCard): a
// name the server proposes for a chat from what it is about, which applies
// only when the person accepts it or writes their own. Read as the chat
// opens; Accept, Not now and Customize are sent at once, online only, like
// Stop (a suggestion is the server's, and a stale one is refused with a 404,
// which just hides the card). The new title comes back with the next pull.
// Never the server's text: a failure says ours. No React Native here:
// tests/chat runs it under Node against a fake fetch.

export const SUGGESTED_NAME = 'Suggested name for this chat';
export const ACCEPT = 'Accept';
export const NOT_NOW = 'Not now';
export const CUSTOMIZE = 'Customize';
export const SUGGESTION_FAILED = 'Couldn’t save that. Check your connection and try again.';

export type SuggestionAction = 'accept' | 'reject' | 'customize';

const path = (threadId: string) => `/api/chats/${encodeURIComponent(threadId)}/name-suggestion`;

/** The pending suggested name for a chat, or null (none, or not readable). Throws when there's no answer. */
export async function readNameSuggestion(
    fetch: AuthedFetch,
    threadId: string,
    signal?: AbortSignal,
): Promise<string | null> {
    const response = await fetch(path(threadId), { signal });
    if (!response.ok) {
        return null;
    }
    const body = (await readJson(response, signal)) as { suggestion?: { suggestedName?: unknown } | null } | null;
    const name = body?.suggestion?.suggestedName;
    return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/**
 * Settles the suggestion: `done` when the server took it or has no suggestion
 * any more (404: someone settled it already), `failed` otherwise. A customized
 * name must be 1 to 80 characters, trimmed (`invalid` before sending).
 */
export async function settleNameSuggestion(
    fetch: AuthedFetch,
    threadId: string,
    action: SuggestionAction,
    name?: string,
): Promise<'done' | 'failed' | 'invalid'> {
    const title = name?.trim() ?? '';
    if (action === 'customize' && (title.length < 1 || title.length > MAX_CHAT_TITLE)) {
        return 'invalid';
    }
    try {
        const response = await fetch(`${path(threadId)}/${action}`, {
            method: 'POST',
            json: action === 'customize' ? { name: title } : {},
        });
        return response.ok || response.status === 404 ? 'done' : 'failed';
    } catch {
        return 'failed';
    }
}
