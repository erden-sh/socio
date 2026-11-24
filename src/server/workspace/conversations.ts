import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import { LIVE, live, unstamped } from '@socio/data/soft-delete';
import type { ModelChoice } from '@socio/shared/inference';
import type { RoomAction, RoomDecision, RoomDenial, RoomRole, RoomViewer } from '@socio/shared/rooms/rooms';
import type { CallReceipt, Conversation, DeleteBlocker } from '@socio/shared/types';

import type { AccessChanges } from './access-changes.js';
import {
    DELETE_BLOCKED,
    type ConversationAccessCheck,
    type ConversationsShape,
    type ConversationWithStamps,
    type SocioReader,
    type SociosShape,
    type SpacesShape,
} from './contract.js';
import { choiceOf, choiceText } from './rows.js';

/**
 * The filter for the chat lists: archived chats are left
 * out of `conversations` and every surface built on it (the sidebar, the
 * Dots' latest chat, the palette, Home). Lookups by id don't use it.
 */
export const UNARCHIVED = 'archivedAt IS NULL';
/**
 * Private chats and legacy Telegram topics (CB-207): what
 * the owner-only readers (`requireOwnedThread`, calls) answer for. Rooms
 * reach a person through their membership (`roomAccess`, CB-208); a
 * room's sentinel owner matches no person.
 */
export const PRIVATE_KIND = "kind = 'private'";

/** A Telegram conversation's details, as a `Conversation` carries them. */
type TelegramInfo = NonNullable<Conversation['telegram']>;

/**
 * What the Conversations slice asks of the one room access rule
 * (`RoomAccess`, rooms/access.ts, CB-208), which the workspace builds and
 * hands in.
 */
export interface RoomRule {
    /** The rooms a person is an active member of, with their role. */
    viewerRooms(userId: string): Array<{ roomId: string; role: RoomRole }>;
    /** The room's people now (CB-181): active members and invites that still work. */
    people(roomId: string): string[];
    /** The room's active socios, in the order they were added (CB-206). */
    socios(roomId: string): string[];
    /** What the rule knows of the person, for this conversation. */
    viewer(thread: Conversation, userId: string): RoomViewer;
    decide(thread: Conversation, userId: string, action: RoomAction, check?: ConversationAccessCheck): RoomDecision;
}

/**
 * The `Conversations` slice: conversations, their calls and captures, and the
 * tasks bound to them, on the workspace's connection. Moved from
 * `WorkspaceStore` as it was. The access rules, the Telegram links, the
 * computers, the task threads, the socios and the Spaces come in prepared.
 */
export class SqliteConversations implements ConversationsShape {
    constructor(
        private db: DatabaseSync,
        private deps: {
            /** The one access rule with each person's room memberships (CB-208). */
            roomAccess: RoomRule;
            /** Who reads each Space (CB-181, `SpaceAccess.reads`). */
            spaceAccess: { reads(spaceId: string, reader: SocioReader): boolean };
            /** The Telegram conversations (`TelegramLinks`). */
            telegram: {
                teamThreadsForNow(userId: string): string[];
                teamThreadsFor(userId: string): Promise<string[]>;
                threadInfoNow(threadId: string): TelegramInfo | undefined;
                threadInfo(threadId: string): Promise<TelegramInfo | undefined>;
                threadInfos(threadIds: string[]): Promise<Map<string, TelegramInfo>>;
            };
            /** The socios' computers (`ComputerStore`): who acted on one. */
            computers: { usedBy(userId: string, dotId: string): boolean };
            /** The Scheduling context's task threads (`TaskThreadRepository`, CB-110). */
            taskThreads: {
                bind(taskId: string, threadId: string): Promise<void>;
                threadOf(taskId: string): Promise<string | undefined>;
                tasksOf(threadIds: readonly string[]): Promise<string[]>;
            };
            socios: Pick<SociosShape, 'dot'>;
            spaces: Pick<SpacesShape, 'readsSpace'>;
            changes: AccessChanges;
            /** The access rule's refusal (`RoomAccessError`), with its reason. */
            denied: (reason: RoomDenial) => Error;
        },
    ) {}
    /** The tasks bound to a Dot's conversations, deleted ones' too. */
    async dotThreadTaskIds(dotId: string): Promise<string[]> {
        const threads = this.db
            .prepare('SELECT id FROM thread_bindings WHERE dotId=?')
            .all(dotId)
            .map((row) => String(row.id));
        return this.deps.taskThreads.tasksOf(threads);
    }
    /**
     * Who reads a chat now (CB-181): a room's active members and live
     * invites; a private chat's owner (a Telegram DM too); null where Socio
     * can't name them all (a Telegram group or team topic) or the chat is
     * gone. Space access asks it afresh at every read.
     */
    chatReaders(threadId: string): string[] | null {
        const thread = this.thread(threadId);
        if (!thread) {
            return null;
        }
        if (thread.kind === 'room') {
            return this.deps.roomAccess.people(threadId);
        }
        const telegram = this.deps.telegram.threadInfoNow(threadId);
        if (telegram && telegram.kind !== 'dm') {
            return null;
        }
        return [thread.ownerId];
    }
    /**
     * The socio of a chat as a Space reader (CB-181): it reads a Space it
     * has that everyone reading the chat may read (`SpaceAccess.reads`).
     */
    socioReader(threadId: string, dotId?: string): SocioReader {
        const thread = this.thread(threadId);
        return {
            dotId: dotId ?? thread?.dotId ?? '',
            people: thread ? this.chatReaders(threadId) : [],
        };
    }
    /**
     * Where to find the page a chat is about (CB-181): a page's own chat
     * here, and what other modules add (the Ask panel's chats about a page,
     * `addChatPages`). Each answers a page id, or nothing.
     */
    private chatPages: Array<(threadId: string) => string | undefined> = [
        (threadId) => {
            const row = this.db.prepare('SELECT pageId FROM page_threads WHERE threadId=?').get(threadId);
            return row ? String(row.pageId) : undefined;
        },
    ];
    /** Adds a source of chats about a page (`chatPages`). */
    addChatPages(source: (threadId: string) => string | undefined) {
        if (!this.chatPages.includes(source)) {
            this.chatPages.push(source);
        }
    }
    /** The Space of the page a chat is about (deleted or not), if it is about one. */
    chatSpace(threadId: string): string | undefined {
        for (const source of this.chatPages) {
            const pageId = source(threadId);
            if (!pageId) {
                continue;
            }
            const row = this.db.prepare('SELECT spaceId FROM pages WHERE id=?').get(pageId);
            if (row) {
                return String(row.spaceId);
            }
        }
        return undefined;
    }
    /**
     * Whether a chat about a page is hidden from `userId` (CB-181): the
     * page's Space is one they may not read now. It is missing for them,
     * as a chat that isn't there, until they may read it again.
     */
    chatHidden(userId: string, threadId: string) {
        const spaceId = this.chatSpace(threadId);
        return spaceId !== undefined && !this.deps.spaces.readsSpace(userId, spaceId);
    }
    /** Whether the socio of `threadId` may read `spaceId` now (`socioReader`). */
    socioReads(threadId: string, spaceId: string, dotId?: string) {
        return this.deps.spaceAccess.reads(spaceId, this.socioReader(threadId, dotId));
    }
    /** The rooms a person is an active member of, by id, with their role. */
    private activeRooms(userId: string): Map<string, RoomRole> {
        return new Map(this.deps.roomAccess.viewerRooms(userId).map(({ roomId, role }) => [roomId, role]));
    }
    /**
     * A previous chat or computer action grants access to this socio's
     * shared area; an active room membership counts as a chat (CB-208).
     */
    usedDot(userId: string, dotId: string): boolean {
        if (this.deps.computers.usedBy(userId, dotId)) {
            return true;
        }
        const team = this.deps.telegram.teamThreadsForNow(userId);
        const rooms = [...this.activeRooms(userId).keys()];
        return !!this.db
            .prepare(
                `SELECT 1 FROM thread_bindings
      WHERE dotId=? AND (((ownerId=? OR id IN (SELECT value FROM json_each(?))) AND ${PRIVATE_KIND})
        OR (kind = 'room' AND id IN (SELECT value FROM json_each(?)))) LIMIT 1`,
            )
            .get(dotId, userId, JSON.stringify(team), JSON.stringify(rooms));
    }
    /**
     * The user's own conversations, team conversations they can see and the
     * rooms they are an active member of (CB-208), newest first; archived
     * ones are left out (`archivedConversations`). A pending invite lists
     * nothing: it gives no history.
     */
    async conversations(userId: string): Promise<Conversation[]> {
        const team = new Set(await this.deps.telegram.teamThreadsFor(userId));
        const rooms = this.activeRooms(userId);
        const rows = this.db
            .prepare(
                `SELECT * FROM thread_bindings WHERE (((ownerId=? OR id IN (SELECT value FROM json_each(?))) AND ${PRIVATE_KIND})
           OR (kind = 'room' AND id IN (SELECT value FROM json_each(?)))) AND ${LIVE} AND ${UNARCHIVED}
         ORDER BY createdAt DESC`,
            )
            .all(userId, JSON.stringify([...team]), JSON.stringify([...rooms.keys()]))
            .map(threadOf)
            // A chat about a page in a Space they may not read (CB-181).
            .filter((row) => !this.chatHidden(userId, row.id));
        // One Telegram query for the whole list, not one per row.
        const telegram = await this.deps.telegram.threadInfos(rows.map((row) => row.id));
        return rows.map((row) => this.describe(row, telegram.get(row.id), team.has(row.id), rooms.get(row.id)));
    }
    /**
     * The user's archived conversations, the last archived first (Account →
     * Archived chats): their own, and archived rooms they are an active
     * member of (CB-208). Team topics are never archived.
     */
    async archivedConversations(userId: string): Promise<Conversation[]> {
        const rooms = this.activeRooms(userId);
        const rows = this.db
            .prepare(
                `SELECT * FROM thread_bindings WHERE ((ownerId=? AND ${PRIVATE_KIND})
           OR (kind = 'room' AND id IN (SELECT value FROM json_each(?)))) AND ${LIVE} AND archivedAt IS NOT NULL
         ORDER BY archivedAt DESC, createdAt DESC`,
            )
            .all(userId, JSON.stringify([...rooms.keys()]))
            .map(threadOf)
            .filter((row) => !this.chatHidden(userId, row.id));
        const telegram = await this.deps.telegram.threadInfos(rows.map((row) => row.id));
        return rows.map((row) => this.describe(row, telegram.get(row.id), false, rooms.get(row.id)));
    }
    /**
     * Archives or unarchives a live conversation. The route
     * checks the owner, as for a rename. Archiving an archived chat keeps
     * its first date.
     */
    setArchived(id: string, archived: boolean, by: string, now = Date.now()) {
        this.db
            .prepare(
                archived
                    ? `UPDATE thread_bindings SET archivedAt=?, archivedBy=? WHERE id=? AND ${LIVE} AND archivedAt IS NULL`
                    : `UPDATE thread_bindings SET archivedAt=NULL, archivedBy=NULL WHERE id=? AND ${LIVE} AND archivedAt IS NOT NULL`,
            )
            .run(...(archived ? [now, by, id] : [id]));
        if (archived) {
            this.deps.changes.emit({ conversationId: id });
        }
        return this.thread(id);
    }
    private describe(
        row: Conversation,
        telegram: TelegramInfo | undefined,
        team = false,
        roomRole?: RoomRole,
    ): Conversation {
        const described: Conversation = roomRole ? { ...row, roomRole } : row;
        return telegram
            ? {
                  ...described,
                  source: 'telegram',
                  telegram,
                  ...(team ? { team: true } : {}),
              }
            : described;
    }
    /**
     * Whether `userId` may do `action` in a live conversation (CB-208,
     * `roomAllows`): its owner in a private chat, an observed reader of a
     * legacy topic for reading, a room's active member per role. Workspace
     * admins are not exempt. Undefined thread: it is missing.
     */
    access(
        userId: string,
        id: string,
        action: RoomAction,
        check?: ConversationAccessCheck,
    ): { thread?: Conversation; decision: RoomDecision } {
        const thread = this.thread(id);
        // A chat about a page in a Space they may not read is missing (CB-181).
        if (!thread || this.chatHidden(userId, id)) {
            return { decision: { allowed: false, reason: 'not_found' } };
        }
        return {
            thread,
            decision: this.deps.roomAccess.decide(thread, userId, action, check),
        };
    }
    /**
     * The socios that may answer in a live conversation (CB-206): a private
     * chat's or a legacy topic's own socio; a room's active socios, its lead
     * first. Empty when it is missing.
     */
    answeringSocios(id: string): string[] {
        const thread = this.thread(id);
        if (!thread) {
            return [];
        }
        if (thread.kind !== 'room') {
            return [thread.dotId];
        }
        const active = this.deps.roomAccess.socios(thread.id);
        return active.includes(thread.dotId)
            ? [thread.dotId, ...active.filter((dotId) => dotId !== thread.dotId)]
            : active;
    }
    /** Whether `dotId` may answer in the conversation (`answeringSocios`). */
    answers(id: string, dotId: string) {
        return this.answeringSocios(id).includes(dotId);
    }
    /** `access`, allowed or not. */
    allows(userId: string, id: string, action: RoomAction, check?: ConversationAccessCheck) {
        return this.access(userId, id, action, check).decision.allowed;
    }
    /**
     * Request boundary check by the one rule (CB-208): the conversation, if
     * `userId` may do `action` there (and it is this socio's); else a
     * `RoomAccessError` with the reason, `not_found` for anyone who can't
     * see it.
     */
    requireAccess(userId: string, id: string, action: RoomAction, dotId?: string): Conversation {
        const { thread, decision } = this.access(userId, id, action);
        if (!thread || (dotId && thread.dotId !== dotId)) {
            throw this.deps.denied('not_found');
        }
        if (!decision.allowed) {
            throw this.deps.denied(decision.reason);
        }
        return thread;
    }
    /**
     * A conversation this user may read (`roomAllows` `read`, CB-208): their
     * own, a team conversation they belong to, or a room they are an active
     * member of. A pending invite reads nothing.
     */
    async readableThread(
        userId: string,
        id: string,
        check?: Pick<ConversationAccessCheck, 'audit'>,
    ): Promise<Conversation | undefined> {
        const { thread, decision } = this.access(userId, id, 'read', check);
        if (!thread || !decision.allowed) {
            return undefined;
        }
        const telegram = await this.deps.telegram.threadInfo(id);
        if (thread.kind === 'room') {
            const role = this.deps.roomAccess.viewer(thread, userId).member?.role;
            return this.describe(thread, telegram, false, role);
        }
        return this.describe(thread, telegram, decision.via === 'legacy-topic');
    }
    /** Any live conversation by id, regardless of owner (internal use). */
    thread(id: string): Conversation | undefined {
        const row = this.db.prepare(`SELECT * FROM thread_bindings WHERE id=? AND ${LIVE}`).get(id);
        return row && threadOf(row);
    }
    /**
     * The person whose private chat a room was, for a room made from one: only
     * its owner converts it, and the row keeps who did (`createdBy`) and when.
     * Its person messages stored with no sender are theirs. Undefined for any
     * other conversation.
     */
    convertedFrom(id: string): { userId: string; at: number } | undefined {
        const row = this.db
            .prepare(
                `SELECT createdBy, convertedAt FROM thread_bindings WHERE id=? AND kind='room' AND convertedAt IS NOT NULL AND ${LIVE}`,
            )
            .get(id) as { createdBy: unknown; convertedAt: unknown } | undefined;
        return typeof row?.createdBy === 'string' && row.createdBy && typeof row.convertedAt === 'number'
            ? { userId: row.createdBy, at: row.convertedAt }
            : undefined;
    }
    /** A conversation by id, deleted or not, with its stamp (admin, tests). */
    withDeletedThread(id: string) {
        return this.db.prepare('SELECT * FROM thread_bindings WHERE id=?').get(id) as
            | ConversationWithStamps
            | undefined;
    }
    /** Ids of deleted conversations (the Runs view leaves their runs out). */
    deletedThreadIds(): string[] {
        return this.db
            .prepare('SELECT id FROM thread_bindings WHERE deletedAt IS NOT NULL')
            .all()
            .map((row) => String(row.id));
    }
    /** Sets a conversation's own model; null: its Dot's default. */
    setThreadInference(id: string, choice: ModelChoice | null) {
        this.db.prepare('UPDATE thread_bindings SET inference=? WHERE id=?').run(choiceText(choice), id);
        return this.thread(id);
    }
    bindThread(
        id: string,
        dotId: string,
        title: string,
        userId: string,
        inference: ModelChoice | null = null,
    ): Conversation {
        const dot = this.deps.socios.dot(dotId);
        if (!dot) {
            throw new Error('Socio not found.');
        }
        // A person's own Dot works only for them: nobody else owns its chats.
        if (dot.ownerId && dot.ownerId !== userId) {
            throw new Error('Socio not found.');
        }
        if (dot.archivedAt) {
            throw new Error('This socio is archived.');
        }
        const value: Conversation = {
            id,
            dotId,
            ownerId: userId,
            title,
            createdAt: Date.now(),
            kind: 'private',
            learningContainerId: dot.learningContainerId ?? null,
            inference,
        };
        this.db
            .prepare(
                'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId, inference) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(id, dotId, userId, title, value.createdAt, value.learningContainerId ?? null, choiceText(inference));
        return value;
    }
    isTitled(id: string): boolean {
        return !!(
            this.db.prepare('SELECT titled FROM thread_bindings WHERE id=?').get(id) as { titled: number } | undefined
        )?.titled;
    }
    /**
     * Records the automatic title; without a title, records the attempt only.
     * A chat its owner renamed keeps their title (CB-66).
     */
    setAutomaticTitle(id: string, title?: string) {
        this.db
            .prepare(
                'UPDATE thread_bindings SET titled=1, title=CASE WHEN renamed THEN title ELSE COALESCE(?, title) END WHERE id=?',
            )
            .run(title ?? null, id);
    }
    /**
     * The owner's own title for a live conversation (CB-66): marked renamed,
     * so a generated title never replaces it. The route checks the owner
     * and the length.
     */
    renameThread(id: string, title: string) {
        this.db
            .prepare(`UPDATE thread_bindings SET title=?, renamed=1, titled=1 WHERE id=? AND ${LIVE}`)
            .run(title, id);
        return this.thread(id);
    }
    /**
     * Internal lookup for code acting on an already-authorized thread (the
     * agent, page tools, voice compute). Request handlers must use
     * requireOwnedThread instead.
     */
    requireThread(id: string, dotId?: string): Conversation {
        const thread = this.thread(id);
        if (!thread || (dotId && thread.dotId !== dotId)) {
            throw new Error('Conversation does not belong to this socio and owner.');
        }
        return thread;
    }
    /**
     * Request boundary check for what only a private chat's owner does (a
     * call, a scheduled task, a capture, deletion): the thread exists, is
     * this user's private chat, and this Dot's. Never a room (CB-208:
     * `requireAccess` is the room rule).
     */
    requireOwnedThread(userId: string, id: string, dotId?: string): Conversation {
        const thread = this.thread(id);
        if (
            !thread ||
            thread.kind !== 'private' ||
            thread.ownerId !== userId ||
            (dotId && thread.dotId !== dotId) ||
            // About a page in a Space they may not read now (CB-181).
            this.chatHidden(userId, id)
        ) {
            throw new Error('Conversation does not belong to this socio and owner.');
        }
        return thread;
    }
    /** Request boundary check for a call: it belongs to one of the user's threads. */
    requireOwnedCall(userId: string, id: string): CallReceipt {
        const call = this.call(id);
        this.requireOwnedThread(userId, call.threadId);
        return call;
    }
    /** The user's call receipts, newest first. */
    callsFor(userId: string): CallReceipt[] {
        return this.db
            .prepare(
                `SELECT calls.* FROM calls JOIN thread_bindings ON thread_bindings.id=calls.threadId WHERE thread_bindings.ownerId=? AND ${live('thread_bindings')} ORDER BY calls.startedAt DESC`,
            )
            .all(userId) as unknown as CallReceipt[];
    }
    /** Runs a scheduled task's turns in the conversation. */
    async bindTask(taskId: string, threadId: string) {
        this.requireThread(threadId);
        await this.deps.taskThreads.bind(taskId, threadId);
    }
    /** Ids of the scheduled tasks bound to a conversation. */
    threadTasks(threadId: string): Promise<string[]> {
        return this.deps.taskThreads.tasksOf([threadId]);
    }
    /**
     * Deletes a web conversation (CB-64: hides it). Its run history, calls,
     * captures, review receipts and learning evidence are kept and read only
     * through it, so they are hidden with it; its tasks are stamped by
     * `ConversationAdmin.delete`. Telegram and page conversations are
     * refused (their channel re-creates them), and so is a conversation with
     * a call in progress. Pages it saved are kept.
     */
    async deleteThread(id: string, by: string, now = Date.now()) {
        if (!this.thread(id)) {
            throw new Error('Conversation not found.');
        }
        const blocked = await this.deleteBlocker(id);
        if (blocked) {
            throw new Error(DELETE_BLOCKED[blocked]);
        }
        // Behind another chain's unit of work, or in the caller's (CB-110).
        await transaction(this.db, 'delete conversation', () => {
            this.db
                .prepare(`UPDATE thread_bindings SET deletedAt=?, deletedBy=? WHERE id=? AND ${LIVE}`)
                .run(now, by, id);
        });
        this.deps.changes.emit({ conversationId: id });
    }
    /** Why deleteThread would refuse this live conversation, if it would. */
    async deleteBlocker(id: string): Promise<Exclude<DeleteBlocker, 'running'> | undefined> {
        if (await this.deps.telegram.threadInfo(id)) {
            return 'telegram';
        }
        if (this.db.prepare('SELECT 1 FROM page_threads WHERE threadId=?').get(id)) {
            return 'page';
        }
        if (this.db.prepare('SELECT 1 FROM calls WHERE threadId=? AND endedAt IS NULL').get(id)) {
            return 'call';
        }
        return undefined;
    }
    /** The conversation a scheduled task's turns run in. */
    taskThread(taskId: string): Promise<string | undefined> {
        return this.deps.taskThreads.threadOf(taskId);
    }
    /** Calls of live conversations; a deleted one's are kept, not listed. */
    calls(threadId?: string): CallReceipt[] {
        if (threadId) {
            this.requireThread(threadId);
        }
        return this.db
            .prepare(
                `SELECT * FROM calls WHERE ${threadId ? 'threadId=?' : 'threadId NOT IN (SELECT id FROM thread_bindings WHERE deletedAt IS NOT NULL)'} ORDER BY startedAt DESC`,
            )
            .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
    }
    createCall(threadId: string): CallReceipt {
        this.requireThread(threadId);
        const call: CallReceipt = {
            id: randomUUID(),
            threadId,
            startedAt: Date.now(),
            endedAt: null,
            status: 'connecting',
            transcript: '',
            error: null,
        };
        this.db
            .prepare(
                'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
            )
            .run(call.id, threadId, call.startedAt, call.status, '');
        return call;
    }
    call(id: string): CallReceipt {
        const call = this.calls().find((call) => call.id === id);
        if (!call) {
            throw new Error('Call not found.');
        }
        this.requireThread(call.threadId);
        return call;
    }
    setCall(id: string, status: CallReceipt['status'], transcript: string, error: string | null = null) {
        const call = this.call(id);
        if (call.endedAt) {
            return call;
        }
        this.db
            .prepare('UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?')
            .run(status, transcript, error, status === 'ended' || status === 'failed' ? Date.now() : null, id);
        return this.call(id);
    }
    saveLateTranscript(id: string, transcript: string) {
        this.call(id);
        return (
            this.db
                .prepare("UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL")
                .run(transcript, id).changes > 0
        );
    }
    anchorCall(id: string, anchor: string | undefined) {
        this.call(id);
        this.db.prepare('UPDATE calls SET anchorMessageId=? WHERE id=?').run(anchor ?? null, id);
    }
    setCallError(id: string, error: string | null) {
        this.call(id);
        this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
    }
    saveCapture(threadId: string, value: unknown) {
        this.requireThread(threadId);
        this.db
            .prepare('INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value')
            .run(threadId, JSON.stringify(value));
    }
    capture(threadId: string): unknown {
        this.requireThread(threadId);
        const row = this.db.prepare('SELECT value FROM captures WHERE threadId=?').get(threadId);
        return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
    }
}

/**
 * A `thread_bindings` row as a Conversation: no stamps, the model choice
 * parsed, `renamed` only when its owner renamed it (CB-66), and
 * `archivedAt` only while it is archived (who archived it stays inside:
 * only its owner can). The automatic-title flag stays inside the store.
 */
function threadOf(row: Record<string, unknown>): Conversation {
    const copy: Record<string, unknown> = unstamped(row);
    delete copy.titled;
    delete copy.renamed;
    delete copy.archivedAt;
    delete copy.archivedBy;
    // Who made or converted a room is the rooms module's to tell (CB-207).
    delete copy.createdBy;
    delete copy.convertedAt;
    return {
        ...(copy as unknown as Conversation),
        kind: row.kind === 'room' ? 'room' : 'private',
        inference: choiceOf(row.inference),
        ...(row.renamed ? { renamed: true } : {}),
        ...(typeof row.archivedAt === 'number' ? { archivedAt: row.archivedAt } : {}),
    };
}
