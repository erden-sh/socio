import { isApprovalNote } from '@socio/shared/approvals';
import { voiceReceiptMessagePrefix } from '@socio/shared/voice/voice-receipt';

import { messageText } from '../turns/media-parts.js';

// Moved from `src/server/memory/asked.ts`.

/**
 * The text of a chat's newest message, for `askedToRemember`, when the
 * person typed it: never a note the server wrote into the chat (an
 * approval's or a job's, a voice call's receipt), whose words
 * quote what a socio wrote.
 */
export function personSaid(messages: readonly { role: string; id?: string; metadata?: unknown }[]): string | undefined {
    const newest = messages.findLast((message) => message.role === 'user');
    if (!newest) {
        return undefined;
    }
    const metadata = newest.metadata as { socioSource?: unknown } | undefined;
    if (
        metadata?.socioSource !== undefined ||
        isApprovalNote(newest) ||
        newest.id?.startsWith(voiceReceiptMessagePrefix)
    ) {
        return undefined;
    }
    return messageText((newest as { content?: unknown }).content);
}
