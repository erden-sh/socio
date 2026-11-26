import { EventType, type BaseEvent, type Message } from '@ag-ui/core';
import { Hono } from 'hono';

import {
    withPrivateResultsWithheld,
    withToolActors,
    withheldResult,
    withoutToolActors,
} from '@socio/foundation/context/room-context';
import type { AppEnv } from '@socio/foundation/http/app-env';
import {
    HISTORY_PAGE_CHARS,
    HISTORY_PAGE_RUNS,
    LIGHT_RESULT_CHARS,
    keepsWholeResult,
    lightToolResult,
    type HistoryMessage,
    type HistoryPage,
    type HistoryRun,
} from '@socio/shared/chat/chat-history';
import { legacyMediaJson, legacyMediaStream, wantsLegacyMedia } from '@socio/shared/media/legacy-media';
import type { TranscriptMention } from '@socio/shared/rooms/room-notices';
import { TraceTimes } from '@socio/shared/runs/trace-times';
import { turnFailureKind, type TurnFailure } from '@socio/shared/turn-failures';

import type { EventReplayShape } from '../replay/contract.js';
import type { NoticesShape, ReaderEventsShape, StreamsShape } from '../rooms/contract.js';
import type { HistoryRow, RunnerShape } from '../turns/contract.js';

import type { ChatHistoryShape, ConversationsShape, PeopleShape } from './contract.js';
import { conversationStream } from './conversation-stream.js';

/**
 * A chat's history for the browser's store (CB-136): its finished runs by
 * their sequence number, newest first on a cold open, then only what came
 * after the newest the browser has, or older ones as the reader scrolls up.
 * A private chat's owner reads it; in a room (CB-208) every active member
 * does (`roomAllows` `read`), with the raw results of turns that acted for
 * someone else withheld (CB-210 `withPrivateResultsWithheld`).
 * Its live stream (`/stream`, CB-212) goes on from the newest run the
 * reader has, by the same rule, and stays open across turns.
 */

/**
 * Why a stored run failed (CB-406): the kind of its RUN_ERROR's fixed text,
 * as the transcript words it (`turnProblems`), from the events the page
 * already read, so no other read. A run's events end at its first
 * RUN_ERROR (`replayableEvents`); undefined for a run with none, or whose
 * error is no fixed text.
 */
export function runFailure(events: readonly BaseEvent[]): TurnFailure | undefined {
    const error = events.find((event) => event.type === EventType.RUN_ERROR) as { message?: unknown } | undefined;
    return typeof error?.message === 'string' ? turnFailureKind(error.message) : undefined;
}

/** A run as the store keeps it: its messages, times and cut results. */
export async function historyRun(
    /** Rebuilds the run's messages from its stored events (`EventReplay`). */
    replay: EventReplayShape,
    threadId: string,
    row: HistoryRow,
    prev: number | null,
    /** The tools called so far on this page, by call id. */
    tools = new Map<string, string>(),
    /** In a room: what the reader may see of each run's messages. */
    visible: (messages: Message[]) => Message[] = (messages) => messages,
): Promise<HistoryRun> {
    const light: Record<string, number> = {};
    const messages = visible(await replay.messages(threadId, row.events)).map((message): Message => {
        if (message.role === 'assistant') {
            for (const call of message.toolCalls ?? []) {
                tools.set(call.id, call.function.name);
            }
        }
        if (
            message.role !== 'tool' ||
            typeof message.content !== 'string' ||
            message.content.length <= LIGHT_RESULT_CHARS ||
            keepsWholeResult(tools.get(message.toolCallId), message.content)
        ) {
            return message;
        }
        light[message.toolCallId] = message.content.length;
        return { ...message, content: lightToolResult(message.content) };
    });
    const failure = runFailure(row.events);
    const run: HistoryRun = {
        seq: row.seq,
        prev,
        runId: row.runId,
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        messages,
        times: new TraceTimes(row.events).snapshot(),
        light,
        size: 0,
        ...(failure ? { failure } : {}),
    };
    run.size = JSON.stringify(run).length;
    return run;
}

/**
 * A page of a conversation's history. `after`: the runs after it, up to a
 * page (`more` when there were others). Otherwise the newest before
 * `before` (or the newest of all), up to `HISTORY_PAGE_RUNS` runs or about
 * `HISTORY_PAGE_CHARS` characters, at least one.
 */
export async function historyPage(
    runner: RunnerShape,
    replay: EventReplayShape,
    threadId: string,
    range: { after?: number; before?: number },
    /** A room's reader: other people's private results are withheld. */
    roomReader?: string,
): Promise<HistoryPage> {
    const visible = roomReader === undefined ? undefined : readerView(runner, threadId, roomReader);
    const rows = runner.historyRows(threadId, {
        ...range,
        // One more than a page: whether others came after it.
        limit: HISTORY_PAGE_RUNS + (range.after === undefined ? 0 : 1),
    });
    const newest = range.after === undefined;
    // The newest page is cut from its newest run back; an `after` pull
    // from its oldest on.
    const ordered = newest ? [...rows].reverse() : rows;
    const tools = new Map<string, string>();
    const runs: HistoryRun[] = [];
    let chars = 0;
    let more = false;
    for (const [index, row] of ordered.entries()) {
        if (runs.length === HISTORY_PAGE_RUNS || (runs.length && chars >= HISTORY_PAGE_CHARS)) {
            more = true;
            break;
        }
        // The rows run back to back: the one before is the previous row.
        const before = newest ? ordered[index + 1] : ordered[index - 1];
        const prev = before ? before.seq : runner.runBefore(threadId, row.seq);
        const run = await historyRun(replay, threadId, row, prev, tools, visible);
        runs.push(run);
        chars += run.size;
    }
    if (newest) {
        runs.reverse();
    }
    return { runs, more: range.after !== undefined && more };
}

/**
 * The `ChatHistory` tag's shape over a runner (`contract.ts`): today's
 * `historyPage`, for the composition root's bridge.
 */
export const chatHistory = (runner: RunnerShape, replay: EventReplayShape): ChatHistoryShape => ({
    historyPage: (threadId, range, roomReader) => historyPage(runner, replay, threadId, range, roomReader),
});

/**
 * A room's messages as `reader` may see them: tool results
 * and approvals' notes of turns that acted for anyone else withheld, their
 * reasoning emptied, and whose turn each was (the server's stamp) left out.
 */
function readerView(runner: RunnerShape, threadId: string, reader: string) {
    const actors = runner.toolActors(threadId);
    return (messages: Message[]) =>
        withoutToolActors(withPrivateResultsWithheld(withToolActors(messages, actors), reader));
}

/** One tool call's whole result, as stored: what a cut preview stands for. */
export async function fullToolResult(
    runner: RunnerShape,
    replay: EventReplayShape,
    threadId: string,
    toolCallId: string,
    /** A room's reader: another person's private result is withheld. */
    roomReader?: string,
): Promise<string | undefined> {
    if (roomReader !== undefined) {
        const actor = runner.toolActors(threadId).get(toolCallId);
        if (actor !== undefined && actor !== roomReader) {
            const content = await fullToolResult(runner, replay, threadId, toolCallId);
            return content === undefined ? undefined : withheldResult('tool', content);
        }
    }
    for (const row of runner.rowsMentioning(threadId, toolCallId)) {
        const found = (await replay.messages(threadId, row.events)).find(
            (message) => message.role === 'tool' && message.toolCallId === toolCallId,
        );
        if (found && typeof found.content === 'string') {
            return found.content;
        }
    }
    return undefined;
}

/**
 * A room's page with whom each person's message mentions (CB-216, CB-416),
 * as the room's transcript gives them (`TranscriptMention`): the person's
 * name now (else the label picked), and whether it is the reader. Only
 * delivered (confirmed) mentions, as the transcript reads them; a message
 * that mentions nobody has no `mentions`. Older servers never send it.
 */
export function withMentions(
    page: HistoryPage,
    mentioned: ReadonlyMap<string, readonly { userId: string; label: string }[]>,
    names: ReadonlyMap<string, string>,
    reader: string,
): HistoryPage {
    if (!mentioned.size) {
        return page;
    }
    return {
        ...page,
        runs: page.runs.map((run) => {
            let added = 0;
            const messages = run.messages.map((message): HistoryMessage => {
                const rows = message.role === 'user' ? mentioned.get(message.id) : undefined;
                if (!rows?.length) {
                    return message;
                }
                const mentions: TranscriptMention[] = rows.map((mention) => ({
                    name: names.get(mention.userId) ?? mention.label,
                    you: mention.userId === reader,
                }));
                added += JSON.stringify(mentions).length + ',"mentions":'.length;
                return { ...message, mentions };
            });
            return added ? { ...run, messages, size: run.size + added } : run;
        }),
    };
}

const cursor = (value: string | undefined) =>
    value === undefined ? undefined : /^\d{1,15}$/.test(value) ? Number(value) : NaN;

/**
 * What a chat's history routes read: its conversations, the runner's turns,
 * the rooms' live streams and reader filter, and the replay of stored events.
 */
export interface HistoryRoutesDeps {
    readonly workspace: Pick<ConversationsShape, 'thread' | 'requireAccess' | 'requireOwnedThread'> &
        Pick<PeopleShape, 'users'>;
    readonly runner: RunnerShape;
    /** Whom a room's messages mention (CB-216), as its transcript reads them. */
    readonly roomNotices: Pick<NoticesShape, 'mentions'>;
    readonly roomStreams: StreamsShape;
    readonly readerEvents: ReaderEventsShape;
    readonly replay: EventReplayShape;
}

export function historyRoutes(platform: HistoryRoutesDeps) {
    const app = new Hono<AppEnv>();
    // Another user's thread is reported as missing, not forbidden. A room's
    // active members read it (CB-208); a legacy topic's history stays its
    // web transcript's.
    const owned = (userId: string, id: string) => {
        try {
            return platform.workspace.thread(id)?.kind === 'room'
                ? platform.workspace.requireAccess(userId, id, 'read')
                : platform.workspace.requireOwnedThread(userId, id);
        } catch {
            return undefined;
        }
    };
    const roomReader = (thread: { kind?: string }, userId: string) => (thread.kind === 'room' ? userId : undefined);
    app.get('/conversations/:id/history', async (c) => {
        const thread = owned(c.get('user').id, c.req.param('id'));
        if (!thread) {
            return c.json({ error: 'Conversation not found.' }, 404);
        }
        const after = cursor(c.req.query('after'));
        const before = cursor(c.req.query('before'));
        if (Number.isNaN(after) || Number.isNaN(before) || (after !== undefined && before !== undefined)) {
            return c.json({ error: 'Ask for runs after one run or before one, not both.' }, 400);
        }
        const reader = roomReader(thread, c.get('user').id);
        const history = await historyPage(platform.runner, platform.replay, thread.id, { after, before }, reader);
        // COMPAT(ag-ui-1.0): attachments as the pre-1.0 reference for a client
        // that doesn't read AG-UI 1.0's media parts (`legacy-media`).
        const forClient = <T>(body: T) => (wantsLegacyMedia(c.req.raw.headers) ? legacyMediaJson(body) : body);
        if (reader === undefined || !history.runs.length) {
            return c.json(forClient(history));
        }
        // In a room, each person's message carries whom it mentions, as the
        // transcript gives it (CB-416): the app's "@you" badge reads it.
        const names = new Map(platform.workspace.users().map((user) => [user.id, user.name]));
        return c.json(forClient(withMentions(history, await platform.roomNotices.mentions(thread.id), names, reader)));
    });
    // The conversation as it happens (CB-212): server-sent events from
    // after run `after` (or `Last-Event-ID`, as a reconnecting EventSource
    // sends it), open across turns until the reader leaves or, in a room,
    // their access ends (`ROOM_STREAM_CLOSED` says why). `packages/shared/src/rooms/rooms.ts`
    // describes its frames.
    app.get('/conversations/:id/stream', (c) => {
        const userId = c.get('user').id;
        const thread = owned(userId, c.req.param('id'));
        if (!thread) {
            return c.json({ error: 'Conversation not found.' }, 404);
        }
        const after = cursor(c.req.query('after')) ?? cursor(c.req.header('Last-Event-ID'));
        if (Number.isNaN(after)) {
            return c.json({ error: 'Ask for the runs after one run.' }, 400);
        }
        const stream = conversationStream({
            runner: platform.runner,
            streams: platform.roomStreams,
            readerEvents: platform.readerEvents,
            threadId: thread.id,
            reader: userId,
            room: thread.kind === 'room',
            converted: () => platform.workspace.thread(thread.id)?.kind === 'room',
            signal: c.req.raw.signal,
            mode: { kind: 'follow', after: after ?? 0 },
        });
        // COMPAT(ag-ui-1.0): as the history (`legacy-media`).
        return wantsLegacyMedia(c.req.raw.headers) ? legacyMediaStream(stream) : stream;
    });
    app.get('/conversations/:id/tool-results/:toolCallId', async (c) => {
        const thread = owned(c.get('user').id, c.req.param('id'));
        if (!thread) {
            return c.json({ error: 'Conversation not found.' }, 404);
        }
        const content = await fullToolResult(
            platform.runner,
            platform.replay,
            thread.id,
            c.req.param('toolCallId'),
            roomReader(thread, c.get('user').id),
        );
        return content === undefined ? c.json({ error: 'That step’s result isn’t stored.' }, 404) : c.json({ content });
    });
    return app;
}
