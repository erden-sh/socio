import type { Message } from '@ag-ui/core';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { contentText } from '@socio/shared/chat/content-text';
import { dateTimeFormat } from '@socio/shared/locale';
import type { LocalId } from '@socio/shared/mascot';
import type { LiveTurn } from '@socio/shared/rooms/live-turn';
import { messageAt } from '@socio/shared/runs/socio-fields';
import type { CallReceipt } from '@socio/shared/types';

import type { ToneName } from '../theme/theme';

import { type MessageFile, messageFiles } from './attachment-tray';
import { type CardRow, cardsOf, isInternalNote, lastScreenshotCall, receiptRow } from './cards';
import { liveSteps } from './live-steps';
import { withoutPageLine } from './page-line';
import { NO_LIFECYCLE, type ThreadLifecycle } from './run-lifecycle';
import {
    chatTurns,
    liveTraceSummary,
    onlyReasoning,
    stepLines,
    traceSummary,
    turnLines,
    type StepLine,
    type TraceSummary,
} from './turn-trace';

// A private chat's transcript as the chat screen draws it: the stored runs
// (the scope's history, oldest first), then the running turn as the follow
// stream tells it (follow.ts's `state.turn`), as rows:
// - the person's messages, a bubble on the right, with their files;
// - the socio's replies, Markdown at full width;
// - a turn's trace (turn-trace.ts): one row before the socio's first
//   message of each stored turn that did work, a disclosure folded until the
//   person opens it (CB-434), its lines opening the sheet; while a turn runs,
//   "Working · 3 steps" from its events (live-steps.ts), or the phase's word;
// - a run's notes beyond its stream at the end (run-lifecycle.ts, CB-434):
//   "Working in the background" while it works there, then its report;
// - the cards of a reply's calls after it (cards.ts: approvals,
//   coding sessions, the computer's screenshot), and the voice calls'
//   receipts after the message each is anchored to, the rest first (the
//   web's rule: calls before the oldest run shown wait for it);
// - never the server's prompts for the socio (`isInternalNote`).
// Each message row carries its time when the runs know it (`at`, the web's
// CB-72 times), worded as the web's action row words it (`messageTime`).
// Pending bubbles come after these (composer.ts).
// A live message whose id the history already holds is left out (shared's
// `stillLive` rule), so a run is never shown twice while the history takes it
// over. No React Native here: tests/chat runs it under Node.

/** The running turn's own line at the transcript's end ("Working · 3 steps", or the phase's word). */
export const LIVE_TRACE_ID = 'trace:live';

export interface UserRow {
    readonly kind: 'user';
    /** The message's id: the list's key. */
    readonly id: string;
    readonly text: string;
    /** Its files: pictures as thumbnails, the rest as chips. */
    readonly files: readonly MessageFile[];
    /** In a room (room-transcript.ts): who wrote it. A private chat's are the person's own. */
    readonly speaker?: Speaker;
    /** When it was sent (the run's message times, the web's CB-72), when known. */
    readonly at?: number;
}

/** Who wrote a room's message: the reader ("You"), another person, or a socio. */
export type Speaker =
    | { readonly kind: 'you'; readonly name: string }
    | {
          readonly kind: 'person';
          readonly name: string;
          readonly initials: string;
          readonly tone: ToneName;
          /** The message mentions the reader: the web's "@you" badge beside the name (CB-416). */
          readonly mentionsYou?: true;
      }
    | { readonly kind: 'socio'; readonly name: string; readonly character: LocalId };

export interface ReplyRow {
    readonly kind: 'reply';
    readonly id: string;
    readonly text: string;
    /** It is still being written (the live turn's streaming message). */
    readonly streaming: boolean;
    /** A stored reply, which takes reactions; never the live turn's. */
    readonly stored: boolean;
    /** In a room: the socio that wrote it. */
    readonly speaker?: Speaker;
    /** When it was written (the run's message times), when known. */
    readonly at?: number;
}

export interface TraceRow extends TraceSummary {
    readonly kind: 'trace';
    /** `trace:<turn id>`, or `trace:live` for the running turn. */
    readonly id: string;
    /** The stored turn the sheet opens (its first message's id); null for the running turn. */
    readonly turn: string | null;
    /** The steps' lines the disclosure opens to (none when only the phase is known). */
    readonly lines: readonly StepLine[];
    /** Reasoning alone: the text the disclosure opens to instead of lines, as on the web. */
    readonly reasoning?: string;
}

/** A run's note beyond its stream (run-lifecycle.ts, CB-434): it went to the background, or reported back. */
export interface RunNoteRow {
    readonly kind: 'run-note';
    /** `background:<run id>` or `report:<run id>`. */
    readonly id: string;
    readonly note: 'background' | 'report';
    readonly runId: string;
    /** The report's summary, in the server's words. */
    readonly summary?: string;
    /** Where the report's result is (a web path), or null. */
    readonly link?: string | null;
}

export type TranscriptRow = UserRow | ReplyRow | TraceRow | CardRow | RunNoteRow;

/** A message's words: its string content, or the text parts of a multipart one. */
export function messageText(message: Pick<Message, 'content'> & { content?: unknown }): string {
    const { content } = message;
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((part: unknown) =>
            part !== null &&
            typeof part === 'object' &&
            (part as { type?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
        )
        .filter((text) => text !== '')
        .join('\n');
}

function rowOf(
    message: Message,
    streamingId: string | undefined,
    stored: boolean,
    at: number | undefined,
): TranscriptRow | null {
    const text = messageText(message);
    if (isInternalNote(message)) {
        return null;
    }
    const when = at === undefined ? {} : { at };
    if (message.role === 'user') {
        const files = messageFiles(message);
        // Older page chats' messages start with their page, which the banner shows (CB-499): never in the bubble.
        const shown = withoutPageLine(text);
        return shown.trim() === '' && files.length === 0
            ? null
            : { kind: 'user', id: message.id, text: shown, files, ...when };
    }
    if (message.role === 'assistant') {
        const streaming = message.id === streamingId;
        // A reply with no words yet (a tool call alone) has no row, unless it is being written.
        return text.trim() === '' && !streaming
            ? null
            : { kind: 'reply', id: message.id, text, streaming, stored: stored && !streaming, ...when };
    }
    return null;
}

/**
 * A message's time: the runs' (`times.messages`, the web's CB-72), else its own `metadata.at`
 * (or the top-level `at` a message stored before AG-UI 1.0 has: `messageAt`), else none.
 */
function timeOf(times: ReadonlyMap<string, number>, message: Message): number | undefined {
    const own = messageAt(message);
    return times.get(message.id) ?? (typeof own === 'number' && Number.isFinite(own) ? own : undefined);
}

const shortTime = dateTimeFormat({ hour: 'numeric', minute: '2-digit' });
const shortDate = dateTimeFormat({ month: 'short', day: 'numeric' });
const longDate = dateTimeFormat({ month: 'short', day: 'numeric', year: 'numeric' });
const fullTime = dateTimeFormat({ dateStyle: 'full', timeStyle: 'short' });

/**
 * A message's time, the web's `messageTime` (MessageActions.tsx): "3:04 PM" today, "Oct 15,
 * 3:04 PM" this year, "Oct 15, 2025, 3:04 PM" before. In the device's time zone.
 */
export function messageTime(at: number, now: number = Date.now()): string {
    const date = new Date(at);
    const today = new Date(now);
    const time = shortTime.format(date);
    if (date.toDateString() === today.toDateString()) {
        return time;
    }
    return `${(date.getFullYear() === today.getFullYear() ? shortDate : longDate).format(date)}, ${time}`;
}

/** The whole date, the web's tooltip on the time: the long-press menu's title. "Friday, October 17, 2026 at 3:04 PM". */
export const messageFullTime = (at: number): string => fullTime.format(new Date(at));

/** What the cards need besides the runs: the workspace's call receipts, and whether older runs wait. */
export interface TranscriptExtras {
    /** The shell's `calls` (all chats'); this chat's are picked by `threadId`. */
    readonly calls?: readonly CallReceipt[];
    readonly threadId?: string;
    /** Older runs aren't loaded yet: receipts from before the oldest shown wait for them. */
    readonly earlier?: boolean;
    /** The socio's name, for the computer's card. */
    readonly socio?: string | null;
    /** The chat's runs beyond their streams (run-lifecycle.ts, CB-434): their notes go last. */
    readonly lifecycle?: ThreadLifecycle;
}

/** The rows of a private chat: its stored runs, then what the live turn adds. */
export function transcriptRows(
    runs: readonly HistoryRun[],
    turn: LiveTurn,
    extras: TranscriptExtras = {},
): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    const seen = new Set<string>();
    const times = new Map<string, number>(runs.flatMap((run) => run.times?.messages ?? []));
    const traces = new Map(chatTurns(runs).map((turn) => [turn.anchor, turn]));
    const results = new Map<string, string>();
    for (const message of [...runs.flatMap((run) => run.messages), ...turn.messages]) {
        if (message.role === 'tool') {
            results.set(message.toolCallId, contentText(message.content));
        }
    }
    const socio = extras.socio ?? null;
    const oldest = extras.earlier === true ? runs[0]?.startedAt : undefined;
    const calls = (extras.calls ?? []).filter(
        (call) => call.threadId === extras.threadId && (oldest === undefined || call.startedAt >= oldest),
    );
    const shown = new Set(
        [...runs.flatMap((run) => run.messages), ...turn.messages]
            .filter((message) => (message.role === 'user' || message.role === 'assistant') && !isInternalNote(message))
            .map((message) => message.id),
    );
    for (const call of calls) {
        if (typeof call.anchorMessageId !== 'string' || !shown.has(call.anchorMessageId)) {
            rows.push(receiptRow(call));
        }
    }
    const screenshot = lastScreenshotCall([...runs.flatMap((run) => run.messages), ...turn.messages], results);
    const after = (message: Message) => {
        rows.push(...cardsOf(message, results, socio, screenshot));
        for (const call of calls) {
            if (call.anchorMessageId === message.id) {
                rows.push(receiptRow(call));
            }
        }
    };
    for (const run of runs) {
        for (const message of run.messages) {
            if (seen.has(message.id)) {
                continue;
            }
            seen.add(message.id);
            const trace = traces.get(message.id);
            if (trace !== undefined) {
                const only = onlyReasoning(trace.steps);
                rows.push({
                    kind: 'trace',
                    id: `trace:${trace.id}`,
                    turn: trace.id,
                    ...traceSummary(trace),
                    lines: only === undefined ? turnLines(trace) : [],
                    ...(only === undefined ? {} : { reasoning: only.text }),
                });
            }
            const row = rowOf(message, undefined, true, timeOf(times, message));
            if (row !== null) {
                rows.push(row);
            }
            after(message);
        }
    }
    const steps = turn.running ? liveSteps(turn) : [];
    const live = turn.running ? liveTraceSummary(turn.phase, steps) : null;
    const only = onlyReasoning(steps);
    let liveShown = live === null;
    const showLive = () => {
        if (!liveShown && live !== null) {
            rows.push({
                kind: 'trace',
                id: LIVE_TRACE_ID,
                turn: null,
                ...live,
                lines: only === undefined ? stepLines(steps, true) : [],
                ...(only === undefined || only.text.trim() === '' ? {} : { reasoning: only.text }),
            });
            liveShown = true;
        }
    };
    for (const message of turn.messages) {
        if (seen.has(message.id)) {
            continue;
        }
        seen.add(message.id);
        if (message.role !== 'user') {
            showLive();
        }
        const row = rowOf(message, turn.streamingId, false, timeOf(times, message));
        if (row !== null) {
            rows.push(row);
        }
        after(message);
    }
    showLive();
    rows.push(...runNoteRows(extras.lifecycle ?? NO_LIFECYCLE));
    return rows;
}

/** A chat's run notes (CB-434): the runs working in the background, then the reports, oldest first. */
export function runNoteRows(lifecycle: ThreadLifecycle): RunNoteRow[] {
    return [
        ...lifecycle.background.map((run): RunNoteRow => ({
            kind: 'run-note',
            id: `background:${run.runId}`,
            note: 'background',
            runId: run.runId,
        })),
        ...lifecycle.reports.map((report): RunNoteRow => ({
            kind: 'run-note',
            id: `report:${report.runId}`,
            note: 'report',
            runId: report.runId,
            summary: report.summary,
            link: report.link,
        })),
    ];
}

/** A run note's words (CB-434): placeholders until the server's events and the copy are settled. */
export function runNoteText(row: Pick<RunNoteRow, 'note' | 'summary'>, socio: string | null): string {
    const who = socio ?? 'Your socio';
    return row.note === 'background'
        ? `${who} is working on this in the background. You can keep chatting.`
        : row.summary !== undefined && row.summary.trim() !== ''
          ? row.summary
          : `${who} finished working in the background.`;
}

/**
 * The person's message ids the live turn holds: delivered, though the history
 * doesn't have them yet (follow.ts; a queued message delivered mid-run). The
 * composer's queued bubbles hide these too.
 */
export function deliveredInTurn(turn: LiveTurn): ReadonlySet<string> {
    return new Set(turn.messages.filter((message) => message.role === 'user').map((message) => message.id));
}

/** What a screen reader hears when a reply has come: once per turn. */
export const repliedAnnouncement = (socio: string | null) => `${socio ?? 'Your socio'} replied`;

/**
 * Whether the live turn just ended with a reply (running, then not, with words
 * from the socio): the moment to say {@link repliedAnnouncement}. Opening a
 * chat, a page of older runs or the history taking the turn over says nothing.
 */
export function replyFinished(previous: LiveTurn, next: LiveTurn): boolean {
    return (
        previous.running &&
        !next.running &&
        next.messages.some((message) => message.role === 'assistant' && messageText(message).trim() !== '')
    );
}

/**
 * Whether the chat has drawn what it will show from what the phone holds: its
 * rows, or, for a chat with no runs, the empty or offline line once the
 * history has answered from disk or the server, or failed. The cold-start
 * timing marks the first frame with data then (a kept chat with no
 * runs marks too).
 */
export function transcriptDrawn(
    rows: number,
    history: { readonly ready: boolean; readonly settled: boolean; readonly failed: boolean },
): boolean {
    return rows > 0 || history.ready || history.settled || history.failed;
}

/** The time a message row shows: its `messageTime`, or null when the runs don't know it. */
export const rowTime = (row: Pick<UserRow, 'at'>, now?: number): string | null =>
    row.at === undefined ? null : messageTime(row.at, now);

/**
 * What a screen reader says for the person's bubble: in a room who wrote it, then its words, then
 * when it was sent; undefined when that is only its words (the Text says them).
 */
export function bubbleLabel(row: Pick<UserRow, 'text' | 'speaker' | 'at'>, now?: number): string | undefined {
    const time = rowTime(row, now);
    if (row.speaker === undefined && time === null) {
        return undefined;
    }
    const words = row.speaker === undefined ? row.text : `${row.speaker.name}: ${row.text}`;
    return time === null ? words : `${words}, ${time}`;
}
