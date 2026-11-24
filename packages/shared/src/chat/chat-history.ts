import type { Message } from '@ag-ui/core';

import { approvalCardId } from '../approvals.js';
import { pageReviewTool } from '../pages/page-review.js';
import type { TranscriptMention } from '../rooms/room-notices.js';
import type { Span } from '../runs/trace-times.js';
import type { TurnFailure } from '../turn-failures.js';
import type { AgentRunStatus } from '../types.js';

/**
 * A chat's history as the browser syncs it (CB-136). The server sends a
 * conversation's finished runs, each with the messages it added, built from
 * its stored events; the browser keeps them per person and per conversation
 * and asks only for what came after the newest it has, or for older ones as
 * the reader scrolls up. The run in progress is never history: CopilotKit
 * streams it.
 */

/** A cold open asks for this many of the newest runs (turns)… */
export const HISTORY_PAGE_RUNS = 20;
/** …or fewer, once they come to about this many characters. */
export const HISTORY_PAGE_CHARS = 300_000;
/** A tool result longer than this comes as a preview (`lightToolResult`). */
export const LIGHT_RESULT_CHARS = 8 * 1024;
/** A preview's text, or each field of one, is cut to this many characters. */
export const LIGHT_PREVIEW_CHARS = 600;
/**
 * The chat's connection replays only the runs after this sequence number
 * (the runner's `connect`): what the browser shows from its store isn't
 * sent again. Without it, the whole conversation replays, as before.
 */
export const HISTORY_AFTER_HEADER = 'x-cb-history-after';

/**
 * Tools whose results a card reads in full (page reviews; approval cards
 * are known by their result): they are never cut.
 */
const WHOLE_RESULT_TOOLS: ReadonlySet<string> = new Set([pageReviewTool.name]);

/** When things in a run happened (`TraceTimes`), as JSON. */
export interface TimesSnapshot {
    messages: [string, number][];
    tools: [string, Span][];
    reasoning: [string, Span][];
}

/**
 * A message as the history endpoint sends it. In a room, a person's message
 * that mentions people (CB-216) carries them as the room's transcript does:
 * each one's name and whether it is the reader (CB-416). Absent when it
 * mentions nobody, outside rooms, and from older servers.
 */
export type HistoryMessage = Message & { mentions?: TranscriptMention[] };

/** One finished run of a conversation, as the history endpoint sends it. */
export interface HistoryRun {
    /** The run's place in the conversation: the sync cursor. */
    seq: number;
    /**
     * The finished run before it (null: it is the first). The store checks
     * the chain, so what it holds is the server's history with no gaps.
     */
    prev: number | null;
    runId: string;
    status: AgentRunStatus;
    startedAt: number;
    finishedAt: number | null;
    /** The messages the run added, in order; long tool results cut. */
    messages: HistoryMessage[];
    times: TimesSnapshot;
    /** Tool results sent as a preview: their call id, and full length. */
    light: Record<string, number>;
    /** About how many characters the run takes (for the store's bound). */
    size: number;
    /**
     * Why a failed or cut-off run failed (CB-406): the kind of its RUN_ERROR's
     * fixed text (`turnFailureKind`), the code a room's transcript words its
     * problem from. Absent for a run that didn't fail, and for one whose
     * error is no fixed text (stored before it had one): its problem reads
     * the plain line. Older servers never send it.
     */
    failure?: TurnFailure;
}

/** What `GET /conversations/:id/history` answers. */
export interface HistoryPage {
    /** Oldest first. Older runs are there when the first has a `prev`. */
    runs: HistoryRun[];
    /**
     * Asked with `after`: more runs came after the last than one page holds.
     * The browser starts again from the newest page instead.
     */
    more: boolean;
}

/** Whether a tool's result stays whole: a card reads it. */
export function keepsWholeResult(tool: string | undefined, content: string) {
    return (!!tool && WHOLE_RESULT_TOOLS.has(tool)) || !!approvalCardId(content);
}

const clip = (text: string) =>
    text.length > LIGHT_PREVIEW_CHARS ? `${text.slice(0, LIGHT_PREVIEW_CHARS - 1)}…` : text;

/**
 * A long tool result's preview: for an object, its short fields (status,
 * error, title, exit code…), which say how the step went and what its
 * line reads; for anything else, its first characters. The step fetches
 * the whole result when it is opened.
 */
export function lightToolResult(content: string): string {
    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch {
        return clip(content);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return clip(content);
    }
    const fields = Object.entries(value as Record<string, unknown>).flatMap(([key, field]): [string, unknown][] =>
        typeof field === 'string'
            ? [[key, clip(field)]]
            : field === null || ['number', 'boolean'].includes(typeof field)
              ? [[key, field]]
              : [],
    );
    return JSON.stringify(Object.fromEntries(fields));
}

/**
 * What a chat's run or connect request carries of its messages (CB-156):
 * only what the server doesn't have yet. Everything up to the newest
 * reply, and the steps before the newest message the person wrote, came
 * from runs the server stored; the runner rebuilds them from storage, whole,
 * when a run's input lacks them (CB-136). The person's messages after the
 * newest reply stay, a turn that never arrived included, and so does
 * whatever follows the newest of them (a page review's answer). The whole
 * history went with every request before, screenshots and long tool
 * results included, until the request was too large to accept.
 */
export function requestMessages<T extends Pick<Message, 'role'>>(messages: readonly T[]): T[] {
    const reply = messages.findLastIndex((message) => message.role === 'assistant');
    const asked = messages.findLastIndex((message) => message.role === 'user');
    return messages.filter((message, index) => index > reply && (message.role === 'user' || index > asked));
}
