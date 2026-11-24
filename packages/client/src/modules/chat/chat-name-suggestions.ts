import { api } from '../../lib/api';

/** A pending name suggestion for a chat (CB-292). */
export interface NameSuggestion {
    threadId: string;
    suggestedName: string;
    trigger: 'unnamed' | 'drift';
    status: 'pending' | 'accepted' | 'rejected' | 'customized';
    suggestedAtMessageIndex: number;
    rejectedAtMessageIndex: number;
    createdAt: number;
    settledAt: number | null;
}

/** The inline card's view of a suggestion (null when none is pending). */
export type NameSuggestionView = { suggestion: NameSuggestion } | { suggestion: null };

/** Reads the pending suggestion for a chat. */
export function fetchNameSuggestion(threadId: string, signal?: AbortSignal) {
    return api<NameSuggestionView>(`/chats/${encodeURIComponent(threadId)}/name-suggestion`, 'GET', undefined, signal);
}

/** Accepts the suggested name, applying it. Returns the new title. */
export function acceptNameSuggestion(threadId: string) {
    return api<{ ok: true; title: string }>(
        `/chats/${encodeURIComponent(threadId)}/name-suggestion/accept`,
        'POST',
        {},
    );
}

/** Rejects the suggested name; starts the cooldown. */
export function rejectNameSuggestion(threadId: string) {
    return api<{ ok: true }>(`/chats/${encodeURIComponent(threadId)}/name-suggestion/reject`, 'POST', {});
}

/** Applies the reviewer's edited name. Returns the new title. */
export function customizeNameSuggestion(threadId: string, name: string) {
    return api<{ ok: true; title: string }>(
        `/chats/${encodeURIComponent(threadId)}/name-suggestion/customize`,
        'POST',
        { name },
    );
}
