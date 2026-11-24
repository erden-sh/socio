import type { MediaAttachmentsShape } from '../media/contract.js';

import type { TurnFile } from './contract.js';

const NOT_HERE = 'it isn’t one of the files shared in this conversation';

/**
 * Reads the files a Dot's board action asks to attach (`attachments`), for
 * the turn's person and conversation: only attachments a message of this
 * conversation carried, which that person may read (their own, or another
 * member's in a conversation they can read). Anything else is refused by
 * id, alike whether it is missing, elsewhere or someone else's, so ids
 * can't be probed. Repeated ids count once.
 */
export async function turnFiles(
    media: MediaAttachmentsShape,
    turn: { userId: string; threadId: string },
    ids: readonly string[],
): Promise<TurnFile[]> {
    const out: TurnFile[] = [];
    for (const id of new Set(ids)) {
        const row = await media.readable(turn.userId, id);
        if (!row || row.threadId !== turn.threadId || row.boundAt === null) {
            const gone = await media.withDeletedAttachment(id);
            const deletedHere =
                !row && gone?.deletedAt != null && gone.threadId === turn.threadId && gone.boundAt !== null;
            out.push(deletedHere ? { id, name: gone.name, reason: 'it was deleted' } : { id, reason: NOT_HERE });
            continue;
        }
        if (!media.file(row)) {
            out.push({ id, name: row.name, reason: 'it was deleted' });
            continue;
        }
        try {
            const { data } = await media.content(row);
            out.push({ id, name: row.name, data });
        } catch {
            out.push({
                id,
                name: row.name,
                reason: 'it could not be read right now',
            });
        }
    }
    return out;
}
