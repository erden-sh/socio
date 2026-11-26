import type { Message } from '@ag-ui/core';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { transaction } from '@socio/data/open';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJson } from '@socio/foundation/http/conditional';
import { messageText } from '@socio/foundation/turns/media-parts';
import { REACTION_MESSAGE_ID, isReactionKind, type ReactionsView } from '@socio/shared/chat/reactions';
import {
    REPORT_NOTE_MAX,
    REPORT_REASON_IDS,
    answeredMessage,
    promptByOther,
    reportNoteLength,
    type ReportOutcome,
    type ReportPreview,
    type ReportRemoval,
} from '@socio/shared/chat/reply-reports';
import { ROOM_DENIAL_MESSAGES } from '@socio/shared/rooms/rooms';
import { TraceTimes } from '@socio/shared/runs/trace-times';
import { SOCIO_METADATA, type Conversation } from '@socio/shared/types';

import type { EventReplayShape } from '../replay/contract.js';
import type { RunnerShape } from '../turns/contract.js';

import type { DotRepliesShape, ReactionReportInput } from './contract.js';
import { messageReactions } from './reactions.js';
import type { ReactionRouteSources } from './sources.js';

/** `PUT …/reactions/down`'s optional body (docs/specs/REPLY-REPORTS.md §3): nothing else is accepted. */
const reactionBody = z
    .object({
        report: z
            .object({
                reason: z.enum(REPORT_REASON_IDS),
                note: z
                    .string()
                    .refine((note) => reportNoteLength(note) <= REPORT_NOTE_MAX)
                    .optional(),
                consent: z.string().min(1).max(200),
            })
            .strict()
            .optional(),
    })
    .strict();
type ReactionBody = z.infer<typeof reactionBody>;

/** The app's User-Agent (`Socio/<version> (<device>; <OS>)`, apps/mobile): a report's surface and version. */
const APP_USER_AGENT = /^Socio\/(\d{1,4}(?:\.\d{1,4}){0,3}) \((?:iPhone|iPad|Android);/;

function surfaceOf(userAgent: string | undefined, version: string | undefined) {
    const app = APP_USER_AGENT.exec(userAgent ?? '');
    return app
        ? { surface: 'mobile' as const, appVersion: app[1] }
        : { surface: 'web' as const, ...(version ? { appVersion: version } : {}) };
}

/**
 * Reactions on a Dot's messages (CB-133), for whoever may read the
 * conversation: its owner, a team topic's members, and a room's active
 * members (CB-208), who react while they may send there (Rooms on, the
 * room unarchived). Anyone else gets "not found", as for the
 * conversation itself. `replay` rebuilds the stored replies (replay's
 * `EventReplay`).
 */
export function reactionRoutes(platform: ReactionRouteSources, replay: Pick<EventReplayShape, 'messages'>) {
    const app = new Hono<AppEnv>();
    const store = messageReactions(platform.workspace.db);
    const readable = (userId: string, id: string) => platform.workspace.readableThread(userId, id);
    const view = (thread: { id: string; team?: boolean; kind?: string }, userId: string): ReactionsView => ({
        shared: !!thread.team || thread.kind === 'room',
        messages: store.view(thread.id, userId),
    });
    const missing = (what: string) => ({ error: `${what} not found.` });

    // Polled by the chat: 304 when nothing changed (conditional.ts).
    app.get('/conversations/:id/reactions', async (c) => {
        const thread = await readable(c.get('user').id, c.req.param('id'));
        if (!thread) {
            return c.json(missing('Conversation'), 404);
        }
        return conditionalJson(c, () => view(thread, c.get('user').id));
    });

    /** The conversation and message a reaction or report is for, or the refusal to answer with. */
    const subject = async (c: Context<AppEnv>, write: boolean) => {
        const userId = c.get('user').id;
        const thread = await readable(userId, c.req.param('id') ?? '');
        if (!thread) {
            return { refusal: c.json(missing('Conversation'), 404) };
        }
        if (write && thread.kind === 'room') {
            const { decision } = platform.workspace.access(userId, thread.id, 'send');
            if (!decision.allowed) {
                return {
                    refusal: c.json(
                        {
                            error: ROOM_DENIAL_MESSAGES[decision.reason],
                            code: decision.reason,
                        },
                        409,
                    ),
                };
            }
        }
        const messageId = c.req.param('messageId') ?? '';
        if (!REACTION_MESSAGE_ID.test(messageId)) {
            return { refusal: c.json(missing('Message'), 404) };
        }
        return { userId, thread, messageId };
    };

    const react = (add: boolean) => async (c: Context<AppEnv>) => {
        const found = await subject(c, true);
        if ('refusal' in found) {
            return found.refusal;
        }
        const { userId, thread, messageId } = found;
        const kind = c.req.param('kind');
        if (!isReactionKind(kind)) {
            return c.json({ error: 'React with up, down, retry or needs-work.' }, 400);
        }
        let body: ReactionBody = {};
        if (add) {
            const raw = await c.req.text();
            if (raw.trim()) {
                let json: unknown;
                try {
                    json = JSON.parse(raw);
                } catch {
                    return c.json({ error: 'The body must be JSON.' }, 400);
                }
                const parsed = reactionBody.safeParse(json);
                if (!parsed.success) {
                    return c.json(
                        {
                            error: `A report has a reason (${REPORT_REASON_IDS.join(', ')}), an optional note of at most ${REPORT_NOTE_MAX} characters, and the consent it was confirmed under; nothing else.`,
                        },
                        400,
                    );
                }
                body = parsed.data;
            }
            if (body.report && kind !== 'down') {
                return c.json({ error: 'Only a thumbs-down carries a report.' }, 400);
            }
        }
        const db = platform.workspace.db;
        if (!add) {
            const removal = await transaction(db, 'remove a reaction', () =>
                store.remove(thread.id, messageId, userId, kind),
            );
            return c.json(withReport(view(thread, userId), removal));
        }
        // Only a Dot's stored reply can be reacted to.
        const message = await dotMessage(platform.runner, replay, thread.id, messageId);
        if (!message) {
            return c.json(missing('Message'), 404);
        }
        const request = body.report;
        const reports = platform.reports;
        let outcome: ReportOutcome | undefined;
        let prepared: Awaited<ReturnType<NonNullable<typeof reports>['prepare']>> | undefined;
        if (request) {
            const state = reports?.state() ?? null;
            outcome =
                !reports || !state
                    ? 'not-sharing'
                    : state.consent !== request.consent
                      ? 'consent-changed'
                      : reports.mark(thread.id, messageId, userId)
                        ? 'already'
                        : undefined;
            if (!outcome && reports) {
                prepared = await reports.prepare(
                    await reportInput(platform, thread, messageId, userId, request, {
                        reply: message,
                        ...surfaceOf(c.req.header('user-agent'), platform.version?.()),
                    }),
                );
            }
        }
        // The reaction and its report in one unit of work: the thumbs-down is stored whatever becomes of the report.
        const written = await transaction(db, 'add a reaction', () => {
            const removal = store.add(thread.id, messageId, userId, kind, message);
            return { removal, report: prepared && reports ? reports.file(prepared) : outcome };
        });
        return c.json(withReport(view(thread, userId), written.report ?? written.removal));
    };

    // Whether this person's thumbs-down on this reply would be a report (§2), for clients without the transcript.
    app.get('/conversations/:id/messages/:messageId/report', async (c) => {
        const found = await subject(c, false);
        if ('refusal' in found) {
            return found.refusal;
        }
        const { userId, thread, messageId } = found;
        const message = await dotMessage(platform.runner, replay, thread.id, messageId);
        if (!message) {
            return c.json(missing('Message'), 404);
        }
        const state = platform.reports?.state() ?? null;
        const messages = await platform.runner.messages(thread.id);
        const preview: ReportPreview = {
            sharing: !!state,
            ...(state ? { consent: state.consent } : {}),
            promptByOther: promptByOther(answeredMessage(messages, messageId, thread.ownerId), userId),
        };
        return c.json(preview);
    });
    app.put('/conversations/:id/messages/:messageId/reactions/:kind', react(true));
    app.delete('/conversations/:id/messages/:messageId/reactions/:kind', react(false));
    return app;
}

/** The view, with what became of the report when there is something to say. */
const withReport = (view: ReactionsView, report: ReportOutcome | ReportRemoval | undefined) =>
    report ? { ...view, report } : view;

/**
 * What a confirmed report holds, from the conversation's stored messages:
 * the reply as shown, the message it answered (and whether another person
 * wrote it), the model of the turn that wrote it, and the socio.
 */
async function reportInput(
    platform: ReactionRouteSources,
    thread: Conversation,
    messageId: string,
    userId: string,
    request: NonNullable<ReactionBody['report']>,
    seen: { reply: { text: string; at?: number }; surface: 'web' | 'mobile'; appVersion?: string },
): Promise<ReactionReportInput> {
    const messages: Message[] = await platform.runner.messages(thread.id);
    const reply = messages.find((message) => message.id === messageId);
    const answered = answeredMessage(messages, messageId, thread.ownerId);
    const promptText = answered ? messageText(answered.message.content) : '';
    const socio = (reply as { metadata?: Record<string, unknown> } | undefined)?.metadata?.[SOCIO_METADATA];
    let model: string | undefined;
    for (const row of platform.runner.rowsMentioning(thread.id, messageId)) {
        model = platform.runner.runTrace(row.runId)?.trace?.turn?.model ?? model;
    }
    const note = request.note?.trim();
    return {
        threadId: thread.id,
        messageId,
        userId,
        consent: request.consent,
        reason: request.reason,
        ...(note ? { note } : {}),
        reply: seen.reply,
        ...(promptText.trim() ? { prompt: { text: promptText, byOther: promptByOther(answered, userId) } } : {}),
        ...(model ? { model } : {}),
        socioId: typeof socio === 'string' ? socio : thread.dotId,
        surface: seen.surface,
        ...(seen.appVersion ? { appVersion: seen.appVersion } : {}),
    };
}

/**
 * The stored reply from the Dot with this id, with its time and text: the
 * only kind of message a reaction is for (here, and in Telegram, CB-145).
 */
export async function dotMessage(
    runner: Pick<RunnerShape, 'rowsMentioning'>,
    replay: Pick<EventReplayShape, 'messages'>,
    threadId: string,
    id: string,
) {
    for (const row of runner.rowsMentioning(threadId, id)) {
        const found = (await replay.messages(threadId, row.events)).find(
            (message) => message.id === id && message.role === 'assistant',
        );
        const text = found ? messageText(found.content) : '';
        if (text.trim()) {
            return { text, at: new TraceTimes(row.events).messages.get(id) };
        }
    }
    return undefined;
}

/** `dotMessage` over `runner` and `replay`, as the `DotReplies` tag serves it. */
export const dotReplies = (
    runner: Pick<RunnerShape, 'rowsMentioning'>,
    replay: Pick<EventReplayShape, 'messages'>,
): DotRepliesShape => ({
    find: (threadId, id) => dotMessage(runner, replay, threadId, id),
});
