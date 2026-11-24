import type { AttachmentRef } from '../media-types.js';

/**
 * Steering messages (CB-151): what the person sends while their Dot's turn
 * runs. They wait in the conversation's queue, on the server, until the
 * turn's next safe point (its tool calls done, before its next model
 * round), where the Dot reads them as the person's message; one the turn
 * ends before starts the next turn. Until then the person may edit or
 * cancel it. One with attachments (CB-223), and those queued after it, go
 * when the turn ends, as the next turn's messages: a turn's own round
 * only takes text.
 */

/** A queued message as the chat shows it. */
export interface QueuedMessage {
    /** The message's id in the conversation, once delivered. */
    id: string;
    /** Empty when it only carries attachments. */
    text: string;
    /** Files sent with it (CB-223): references, never bytes. */
    attachments?: AttachmentRef[];
    createdAt: number;
    updatedAt: number;
}

/**
 * Someone else's queued message in a room, as its admins see it (CB-215):
 * they may cancel it, never edit it. Its author by name; its files by
 * count only (they are the author's until it is sent).
 */
export interface OthersQueuedMessage {
    id: string;
    text: string;
    /** How many files it carries. */
    files: number;
    author: { name: string };
    /**
     * It won't go while this holds: its author may not send in the room now
     * (they left or were removed, say). It waits, and can be canceled.
     */
    held?: true;
    createdAt: number;
    updatedAt: number;
}

/** `GET /api/conversations/:id/steering`. */
export interface SteeringView {
    /**
     * The reader's own, oldest first: the order they are delivered in. In a
     * room (CB-215) each member has, sees and edits only their own.
     */
    messages: QueuedMessage[];
    /**
     * In a room, for its admins only (CB-215): everyone else's waiting
     * messages, oldest first, which they may cancel. Unset for anyone else.
     */
    others?: OthersQueuedMessage[];
    /** The most that may wait here now (Settings → General, CB-170). */
    limit: number;
    /**
     * The turn the server started with the person's queued messages, while
     * it runs (its run id): the chat follows it, as after a Stop (CB-170).
     */
    turn?: string;
    /**
     * A turn runs in the conversation now, whoever started it (CB-223): a
     * chat opened or reloaded during it shows it running, with Stop and
     * Queue, while it streams the rest.
     */
    running?: boolean;
}

/** The longest queued message, in characters (the composer's page link included). */
export const STEERING_MAX_CHARS = 8000;
/**
 * The most messages one person may have waiting in a conversation when
 * `STEERING_MAX_QUEUED` and Settings set none (CB-170).
 */
export const DEFAULT_STEERING_MAX_QUEUED = 5;
