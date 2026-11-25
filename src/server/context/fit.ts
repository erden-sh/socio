import { EventType, type BaseEvent } from '@ag-ui/core';
import type { AnyTextAdapter, ModelMessage, TextOptions } from '@tanstack/ai';

import { contextBudget, textTokens } from '@socio/foundation/context/budget';
import {
    isTimeMarker,
    latestMarker,
    pruneMarkers,
    timeText,
    utcTimeText,
    withMarker,
} from '@socio/foundation/context/time-markers';
import { isTurnNote, newestFromPerson, withNotes, withTurnNote } from '@socio/foundation/context/turn-note';
import { OVER_LENGTH_WORDING } from '@socio/foundation/inference/chatgpt-errors';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import { PROSE_CHARS, recallScale } from '@socio/shared/context-settings';
import { CONTEXT_COMPACTION_EVENT, RUN_TIDYING_EVENT, type ContextCompactionInfo } from '@socio/shared/runs/run-phase';
import type { TraceNotes } from '@socio/shared/runs/run-trace';
import { roundTokens } from '@socio/shared/runs/token-usage';
import { DEFAULT_TIME_ZONE } from '@socio/shared/time-zone';

import { alternating } from './alternate.js';
import {
    DATA_CHARS,
    IMAGE_TOKENS,
    calibrate,
    calibration,
    distrust,
    fixedTokens,
    messageTokens,
    messagesTokens,
} from './budget.js';
import { capPersonMessages, compactMessages, levels, turnStarts, type Level } from './compact.js';
import type { Compaction, ContextFittingShape, FitOptions, Summarizer, RunningNotes } from './contract.js';
import { shownToolImages, withToolImages, withoutInlineToolImages, type ImageParts } from './images.js';
import {
    SHARED_SUMMARY_NOTE,
    SUMMARY_PROMPT,
    factsText,
    fallbackSummary,
    mergeNames,
    mergePinned,
    notesText,
    parseSummary,
    pinnedNames,
    transcript,
    trimNotes,
    turnAnchor,
    type NotesView,
} from './notes.js';
import { rememberOriginals } from './recall.js';
import { RANK_PROMPT, anyHidden, parseRanking, rankRequest, relevantNotes, selectNotes } from './select.js';

/**
 * Fits every model round of a Dot turn into the model's context (CB-129).
 * The agent loop sends the whole conversation again each round, so the
 * fitting sits on the adapter's input: tool results are cut and set aside
 * (`compact.ts`), and when that is not enough the oldest turns are folded
 * into the thread's running notes (`notes.ts`), kept whole: the system
 * prompt, recent turns' messages, the last rounds and the pinned facts.
 * A prompt the model still refuses as too long is compacted harder and
 * sent again, twice at most, before the turn may fail.
 *
 * The prompt's start (the system prompt, the notes and the older turns)
 * stays the same, byte for byte, from round to round and from turn to turn
 * until the next fold, so a model's prefix cache holds (CB-139): the facts
 * chosen for the request go just before the person's newest message.
 *
 * The turns' time markers (CB-141, `time-markers.ts`) are pruned on a fold
 * only, when the prompt's start changes anyway: the notes record the
 * latest marker's time, and from then on the kept turns carry that marker
 * and the newer ones, never the older. Once the latest marker's turn is
 * folded, the notes carry its date and time; a prompt left with no marker
 * gets one on the person's newest message, so the model always knows the
 * date.
 *
 * The images tools return (CB-157, `images.ts`) go in last, before the
 * roles' pass: the newest within the model's limits as images, the rest as
 * notes that stay the same; base64 screenshots of older versions become a
 * note before anything else.
 */

/** Retries after a too-long refusal. */
export const MAX_RETRIES = 2;
/** A retry's prompt, as a share of the refused one. */
const REFUSED_SHARE = 0.7;
/** Folding aims below the budget, so the next rounds don't fold again. */
const FOLD_AIM = 0.6;
/**
 * The notes' share of the model's budget, and their most tokens: not of a
 * round's room, which moves with calibration, so the notes come out the
 * same from turn to turn (CB-139). A room far smaller than the budget (a
 * retry, a long system prompt) still gives them at most `NOTES_ROOM_MAX`.
 */
const NOTES_SHARE = 0.2;
const NOTES_MAX_TOKENS = 6_000;
const NOTES_ROOM_MAX = 0.4;
/** The `relevance` selection's facts for the request, as a share of the notes' tokens. */
const FACTS_SHARE = 0.25;
/**
 * A summarizer request's transcript and current notes, as shares of the
 * messages' budget: the request stays within the model's budget too.
 */
const SUMMARY_INPUT_SHARE = 0.5;
const SUMMARY_NOTES_SHARE = 0.3;

/** Summarizer calls a turn makes at most; further turns fold without one. */
export const MAX_SUMMARIES_PER_TURN = 3;

const OVER_LENGTH_CODES = new Set([
    'context_length_exceeded',
    // TanStack AI 1.x adapters' own code for it.
    'context_overflow',
    'chatgpt_context_too_long',
    'string_above_max_length',
    // llama.cpp's server.
    'exceed_context_size_error',
]);

/**
 * Whether a model refused a prompt for its length: a RUN_ERROR chunk or a
 * thrown error with `context_length_exceeded` (OpenAI), the ChatGPT
 * module's `chatgpt_context_too_long`, or a 400 or 413 that says so.
 */
export function isOverLength(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const value = error as Record<string, unknown>;
    const nested = [value, value.error, value.rawEvent].filter(
        (item): item is Record<string, unknown> => !!item && typeof item === 'object',
    );
    const codes = nested.flatMap((item) => [item.code, item.type]);
    if (codes.some((code) => typeof code === 'string' && OVER_LENGTH_CODES.has(code))) {
        return true;
    }
    const status =
        codes.find((code) => code === '400' || code === '413') ??
        (typeof value.status === 'number' ? String(value.status) : undefined);
    const message = nested.map((item) => (typeof item.message === 'string' ? item.message : '')).join(' ');
    if (status === '413') {
        return true;
    }
    return (status === undefined || status === '400' || /^4\d\d\b/.test(message)) && OVER_LENGTH_WORDING.test(message);
}

/** The notes as fitting keeps them through a turn. */
type KeptNotes = NotesView &
    Pick<RunningNotes, 'turns'> &
    Partial<Pick<RunningNotes, 'timeAt' | 'timeZone' | 'markersFrom' | 'updates'>>;

/**
 * The person's request a turn's notes are chosen for: their message, and
 * the answer before it. A turn's own note (`withTurnNote`) is not theirs.
 */
function currentRequest(messages: readonly ModelMessage[]) {
    const at = newestFromPerson(messages);
    if (at < 0) {
        return '';
    }
    const said = (message?: ModelMessage) =>
        !message
            ? ''
            : typeof message.content === 'string'
              ? message.content
              : Array.isArray(message.content)
                ? message.content
                      .map((part) =>
                          part.type === 'text' && !isTurnNote(part) && !isTimeMarker(part) ? part.content : '',
                      )
                      .join('\n')
                : '';
    const before = messages.slice(0, at).findLast((message) => message.role === 'assistant' && said(message));
    return [said(before).slice(-600), said(messages[at]).slice(0, 2_000)].filter(Boolean).join('\n');
}

interface Round {
    messages: ModelMessage[];
    /** Uncalibrated estimate of what is sent (for calibration). */
    sent: number;
    info: ContextCompactionInfo;
}

/** The adapter with every round's prompt fitted; one per turn. */
export const fitContext = (adapter: AnyTextAdapter, options: FitOptions): AnyTextAdapter =>
    fitting(adapter, options).adapter;

/**
 * `/compact` (CB-143): folds the conversation's turns into the notes now,
 * as a fold would once the prompt outgrew the model, without waiting for
 * it. `request` is the conversation as the next turn's prompt will carry
 * it, without the person's next message: every turn but the last ones the
 * next turn keeps whole is folded (the first level's `keepTurns`, the next
 * message among them), so the next turn starts with the notes and the
 * turns after them, and the system prompt is not touched. Nothing is
 * folded when the notes cover those turns already.
 */
export const compactNow = (adapter: AnyTextAdapter, options: FitOptions, request: TextOptions): Promise<Compaction> =>
    fitting(adapter, options).foldNow(request);

/** `fitContext` and `compactNow`, as the `ContextFitting` tag serves them. */
export const contextFitting: ContextFittingShape = { fit: fitContext, compactNow };

function fitting(adapter: AnyTextAdapter, options: FitOptions) {
    const budget = contextBudget(options.capabilities);
    const ladder = levels(budget.target);
    const log = options.log ?? ((line: string) => console.log(line));
    // A refusal makes the rest of the turn start at the harder level.
    let floor = 0;
    // The first fold of a long thread on a small window could take many
    // summaries in a row: past this many, turns fold without the model.
    let summaries = 0;
    // The tools' images as parts, loaded once a turn (CB-157).
    const imageParts: ImageParts = new Map();
    // A shared chat uses only notes written for one (CB-210).
    const forAudience = (stored: RunningNotes) => !options.shared || stored.audience === 'shared';
    /**
     * Stored notes this conversation can carry on from: written for its
     * audience, over the turns it still has (a history that changed under
     * them, or a shorter one, starts over).
     */
    const usable = (stored: RunningNotes | undefined, messages: readonly ModelMessage[], starts: readonly number[]) =>
        stored &&
        stored.turns <= starts.length &&
        stored.anchor === turnAnchor(messages, starts[stored.turns - 1]) &&
        forAudience(stored)
            ? stored
            : undefined;
    /** The notes to start a fold from: none yet, at the stored version. */
    const blank = (stored: RunningNotes | undefined): KeptNotes => ({
        turns: 0,
        summary: '',
        pinned: [],
        names: [],
        updates: stored?.updates ?? 0,
    });

    /** The notes' model for this turn: the shared one, else the chat's. */
    let notesModel: Promise<{ by: 'shared' | 'chat'; summarizer?: Summarizer }> | undefined;
    const modelForNotes = () =>
        (notesModel ??= (async () => {
            const summarizer = await options.summarizer?.().catch(() => undefined);
            return summarizer ? { by: 'shared' as const, summarizer } : { by: 'chat' as const };
        })());

    /** Updates the notes to cover the first `upTo` turns, from those they cover. */
    const updateNotes = async (
        request: TextOptions,
        messages: readonly ModelMessage[],
        starts: number[],
        previous: KeptNotes,
        upTo: number,
        room: number,
        /**
         * `/compact` (CB-143): only what the notes' model summarized is kept.
         * A failed summary, or the turn's summaries used up, stops the update
         * there, with `stopped` saying why; nothing is written without the
         * model.
         */
        strict?: { stopped?: 'error' | 'cap' },
    ): Promise<KeptNotes> => {
        options.emit({
            type: EventType.CUSTOM,
            name: RUN_TIDYING_EVENT,
            value: {},
        } as BaseEvent);
        const writer = await modelForNotes();
        // The summarizer's request stays within its own model's budget too.
        const summaryRoom = writer.summarizer
            ? Math.min(room, Math.floor(contextBudget(writer.summarizer.capabilities).target * 0.8))
            : room;
        const limit = Math.floor(summaryRoom * SUMMARY_INPUT_SHARE * PROSE_CHARS);
        let notes = previous;
        let from = previous.turns;
        // The latest time marker (CB-141): the notes carry its time once its
        // turn is folded, and the turns after them keep no older marker.
        const latest = latestMarker(messages);
        while (from < upTo) {
            const byModel = summaries < MAX_SUMMARIES_PER_TURN;
            if (strict && !byModel) {
                strict.stopped = 'cap';
                break;
            }
            // As many whole turns as the summarizer's request can take (all of
            // them once this turn has had its summaries).
            let to = byModel ? from : upTo;
            let text = '';
            while (to < upTo) {
                const next = transcript(messages.slice(starts[to], starts[to + 1] ?? messages.length), options.shared);
                if (to > from && text.length + next.length > limit) {
                    break;
                }
                text += (text ? '\n' : '') + next.slice(0, limit);
                to += 1;
            }
            const span = messages.slice(starts[from], starts[to] ?? messages.length);
            const names = mergeNames(notes.names, pinnedNames(span));
            const startedAt = Date.now();
            let summary: string;
            let pinned = notes.pinned;
            let added: string[] = [];
            let fallback: TraceNotes['fallback'];
            let tokens: { inputTokens?: number; outputTokens?: number } = {};
            if (!byModel) {
                summary = fallbackSummary(notes.summary, span, options.shared);
                fallback = 'cap';
            } else {
                try {
                    summaries += 1;
                    const reply = await summarize(
                        request,
                        writer.summarizer,
                        trimNotes(notes, Math.floor(summaryRoom * SUMMARY_NOTES_SHARE)),
                        text,
                    );
                    tokens = reply.tokens;
                    const parsed = parseSummary(reply.answer);
                    if (!parsed.summary) {
                        fallback = 'empty';
                        throw new Error('The summary was empty.');
                    }
                    summary = parsed.summary;
                    added = parsed.pinned;
                    // Earlier facts stay word for word, whatever this summary left out.
                    pinned = mergePinned(notes.pinned, parsed.pinned);
                } catch (error) {
                    if (request.request?.signal?.aborted) {
                        throw error;
                    }
                    if (strict) {
                        reportFailure('Context notes', [
                            `summary failed (${safeFailure(error)}); /compact kept the notes as they were`,
                        ]);
                        strict.stopped = 'error';
                        break;
                    }
                    fallback ??= 'error';
                    // The notes still move on, without the model's summary.
                    reportFailure('Context notes', [`summary failed (${safeFailure(error)}); kept a plain one`]);
                    summary = fallbackSummary(notes.summary, span, options.shared);
                }
            }
            options.trace?.notes({
                startedAt,
                endedAt: Date.now(),
                by: writer.by,
                model: writer.summarizer ? writer.summarizer.model : (options.model ?? null),
                turns: to - from,
                ...(tokens.inputTokens !== undefined ? { inputTokens: tokens.inputTokens } : {}),
                ...(tokens.outputTokens !== undefined ? { outputTokens: tokens.outputTokens } : {}),
                ...(fallback ? { fallback } : {}),
            });
            const next: KeptNotes = {
                ...trimNotes({ summary, pinned, names }, NOTES_MAX_TOKENS * 2),
                turns: to,
                timeAt: latest && latest.index < (starts[to] ?? messages.length) ? latest.at : null,
                timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
                markersFrom: latest?.at ?? null,
            };
            // Every fact stays in the thread's store (CB-134), past the notes' cap;
            // notes started over drop a changed history's facts first. Written
            // with the notes, only while they are still the version this fold
            // started from (CB-217): of two folds at once, the first wins.
            const version = await options.notes.fold(options.threadId, {
                base: notes.updates ?? 0,
                facts: {
                    add:
                        notes.turns === 0
                            ? [...notes.pinned, ...added]
                            : options.notes.facts(options.threadId).length
                              ? added
                              : [...notes.pinned, ...added],
                    restart: notes.turns === 0,
                },
                notes: {
                    turns: to,
                    anchor: turnAnchor(messages, starts[to - 1]),
                    summary: next.summary,
                    pinned: next.pinned,
                    names: next.names,
                    timeAt: next.timeAt,
                    timeZone: next.timeZone,
                    markersFrom: next.markersFrom,
                    audience: options.shared ? 'shared' : 'private',
                },
                record: {
                    fromTurns: from,
                    method: fallback ? 'fallback' : 'model',
                    dotId: options.writer?.dotId ?? null,
                    actingUserId: options.writer?.userId ?? null,
                    added,
                },
            });
            if (version === undefined) {
                // Another turn folded these notes meanwhile: its fold stands, and
                // this one is left unwritten (its facts and episodes too).
                log('Context: the notes were folded by another turn meanwhile; kept that fold.');
                const theirs = usable(options.notes.get(options.threadId), messages, starts);
                if (strict) {
                    strict.stopped = 'error';
                }
                return theirs ?? next;
            }
            notes = { ...next, updates: version };
            // The person's episodes (CB-180): only from a chat of their own.
            if (options.episodes && !options.shared) {
                try {
                    await options.episodes({
                        facts: added,
                        ...(fallback ? {} : { summary }),
                        ...(notes.timeAt !== null && notes.timeAt !== undefined ? { occurredAt: notes.timeAt } : {}),
                    });
                } catch (error) {
                    reportFailure('Episodes', [`capture failed (${safeFailure(error)}); the notes are kept`]);
                }
            }
            from = to;
        }
        return notes;
    };

    /**
     * A request for the notes, with no tools: to the shared model when it
     * writes them, else to the chat's, within budget. Its answer and the
     * tokens the model reported.
     */
    const ask = async (request: TextOptions, summarizer: Summarizer | undefined, system: string, content: string) => {
        let answer = '';
        let tokens: ReturnType<typeof roundTokens> = {};
        options.trace?.request({ summary: true });
        for await (const chunk of (summarizer?.adapter ?? adapter).chatStream({
            ...request,
            ...(summarizer
                ? {
                      model: summarizer.model ?? request.model,
                      modelOptions: summarizer.modelOptions,
                  }
                : {}),
            messages: [{ role: 'user', content }],
            systemPrompts: [system],
            tools: [],
            outputSchema: undefined,
        })) {
            if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
                answer += chunk.delta;
            }
            if (chunk.type === 'RUN_FINISHED') {
                tokens = roundTokens((chunk as { usage?: unknown }).usage);
            }
            if (chunk.type === 'RUN_ERROR') {
                throw new Error(
                    `The notes' request failed (${String((chunk as { code?: unknown }).code ?? 'error').slice(0, 40)}).`,
                );
            }
        }
        return { answer, tokens };
    };

    /** The summarizer's request: the current notes and the new turns. */
    const summarize = (request: TextOptions, summarizer: Summarizer | undefined, notes: NotesView, text: string) => {
        const current = notes.summary || notes.pinned.length || notes.names.length ? notesText(notes) : '(none yet)';
        return ask(
            request,
            summarizer,
            options.shared ? `${SHARED_SUMMARY_NOTE}\n\n${SUMMARY_PROMPT}` : SUMMARY_PROMPT,
            `Current notes:\n${current}\n\nNew part of the conversation:\n${text}`,
        );
    };

    // The ranking of the turn's request (CB-134), once a turn: every round
    // then carries the same facts (and facts pinned since, after them).
    let ranking: { key: string; order?: number[] } | undefined;

    /**
     * The notes as this round's prompt carries them, chosen as the settings
     * say (CB-134): at its start, within `allowance` tokens, and for
     * `relevance` the request's facts, within `factsAllowance`, to go just
     * before the person's newest message (CB-139).
     */
    const chooseNotes = async (request: TextOptions, notes: KeptNotes, allowance: number, factsAllowance: number) => {
        const selection = options.selection ?? 'age';
        const startedAt = Date.now();
        const facts = options.notes.facts(options.threadId).map((stored) => stored.fact);
        const pool = facts.length ? facts : notes.pinned;
        const view = selectNotes(selection, notes, facts, allowance);
        // In the zone of the turn that folded them (CB-159), so the notes stay
        // the same until the next fold, whoever's turn it is; in UTC, as then,
        // for notes folded before.
        const text = notesText(
            notes.timeAt
                ? {
                      ...view,
                      time: notes.timeZone ? timeText(notes.timeAt, notes.timeZone) : utcTimeText(notes.timeAt),
                  }
                : view,
        );
        let extra: { pinned: string[]; names: string[] } | undefined;
        const query = selection === 'relevance' ? currentRequest(request.messages) : '';
        if (query) {
            let order: number[] | undefined;
            // Ranked by the notes' model when asked and the notes leave facts
            // out, once a turn; by words always, and alone when that fails.
            if (options.rankWithModel && anyHidden(view, notes, facts)) {
                // Facts pinned since keep their places (the store only appends).
                const key = query;
                if (ranking?.key !== key) {
                    ranking = { key };
                    try {
                        const writer = await modelForNotes();
                        const { answer } = await ask(request, writer.summarizer, RANK_PROMPT, rankRequest(query, pool));
                        ranking.order = parseRanking(answer, pool);
                    } catch (error) {
                        if (request.request?.signal?.aborted) {
                            throw error;
                        }
                        reportFailure('Context notes', [`ranking failed (${safeFailure(error)}); ranked by words`]);
                    }
                }
                order = ranking.order;
            }
            extra = relevantNotes(view, notes, facts, query, factsAllowance, order);
            if (!extra.pinned.length && !extra.names.length) {
                extra = undefined;
            }
        }
        const facted = extra ? textTokens(factsText(extra)) : 0;
        return {
            text,
            facts: extra,
            info: {
                selection,
                pinnedShown: view.pinned.length + (extra?.pinned.length ?? 0),
                pinnedStored: Math.max(pool.length, notes.pinned.length),
                notesTokens: textTokens(text) + facted,
                selectMs: Date.now() - startedAt,
            },
        };
    };

    /**
     * Steps c and d: the oldest turns folded into the notes. Unless
     * `required`, only notes already kept are used (none are written): once
     * a thread has notes, every round starts with them, so the prompt's start
     * stays the same from round to round.
     */
    const fold = async (
        request: TextOptions,
        compacted: ModelMessage[],
        level: Level,
        room: number,
        required: boolean,
    ) => {
        const messages = request.messages;
        const starts = turnStarts(messages);
        const foldable = starts.length - level.keepTurns;
        if (foldable < 1) {
            return undefined;
        }
        const allowance = Math.min(
            Math.floor(budget.target * NOTES_SHARE),
            NOTES_MAX_TOKENS,
            Math.floor(room * NOTES_ROOM_MAX),
        );
        const factsAllowance =
            options.selection === 'relevance'
                ? Math.min(allowance, Math.floor(allowance * FACTS_SHARE * recallScale(options.recallTokens)))
                : 0;
        // Tokens from each turn's start to the end, as compacted.
        const after: number[] = [];
        let sum = 0;
        for (let turn = starts.length - 1; turn >= 0; turn--) {
            for (let index = starts[turn]; index < (starts[turn + 1] ?? compacted.length); index++) {
                sum += messageTokens(compacted[index]);
            }
            after[turn] = sum;
        }
        let need = 1;
        while (need < foldable && after[need] + allowance + factsAllowance > room * FOLD_AIM) {
            need += 1;
        }
        const found = options.notes.get(options.threadId);
        // A history that changed under the notes (or a shorter one), or notes
        // not written for a chat with other people in it: start over.
        const stored = usable(found, messages, starts);
        if (!required && !stored) {
            return undefined;
        }
        let notes: KeptNotes = stored ?? blank(found);
        let chosen = notes.turns ? await chooseNotes(request, notes, allowance, factsAllowance) : undefined;
        // Folded again only when the notes kept and the turns after them don't
        // fit, then down to the aim: the notes, and so the prompt's start, stay
        // the same for the turns between (CB-139).
        if (
            required &&
            notes.turns < need &&
            (!chosen || chosen.info.notesTokens + after[Math.min(notes.turns, foldable)] > room)
        ) {
            notes = await updateNotes(request, messages, starts, notes, need, room);
            chosen = await chooseNotes(request, notes, allowance, factsAllowance);
        }
        const { text, facts, info } = chosen!;
        // Notes may cover more turns than fold now; those turns stay too.
        const folded = Math.min(notes.turns, foldable);
        // Only the markers from the notes' on (CB-141): the same from turn to
        // turn until the next fold.
        const kept =
            notes.markersFrom != null
                ? pruneMarkers(compacted.slice(starts[folded]), notes.markersFrom)
                : compacted.slice(starts[folded]);
        // In the first kept message, not one of their own: the roles still
        // take turns (CB-147).
        const noted = withNotes(kept, text);
        return {
            messages: noted,
            turns: folded,
            facts,
            tokens: messagesTokens(noted) + (facts ? textTokens(factsText(facts)) : 0),
            info,
        };
    };

    const fitRound = async (
        request: TextOptions,
        retried: number,
        /** The refused prompt's size (uncalibrated), on a retry. */
        refused?: number,
    ): Promise<Round> => {
        const ratio = calibration(options.key);
        const fixed = fixedTokens(request.systemPrompts ?? [], request.tools);
        const total = messagesTokens(request.messages);
        // The tools' images go in after compaction (CB-157): room is kept for
        // those it will show.
        const images = (await shownToolImages(request.messages, options.capabilities, options.images)) * IMAGE_TOKENS;
        // The messages' share, in uncalibrated tokens; a retry asks for well
        // under what was refused.
        const room = Math.max(
            Math.min(
                Math.floor(budget.target / ratio - fixed - images),
                refused === undefined ? Infinity : Math.floor(refused * REFUSED_SHARE) - fixed - images,
            ),
            Math.floor(budget.target * 0.15),
        );
        let messages = request.messages;
        let tokens = total;
        let stubbed = 0;
        let summarised = 0;
        let notesInfo: Partial<ContextCompactionInfo> = {};
        let facts: { pinned: string[]; names: string[] } | undefined;
        for (let at = Math.min(floor, ladder.length - 1); at < ladder.length; at++) {
            const level = ladder[at];
            const compacted = compactMessages(request.messages, level, room);
            rememberOriginals(options.threadId, compacted.originals, Math.floor(level.capTokens * DATA_CHARS * 0.8));
            messages = compacted.messages;
            tokens = compacted.tokens;
            stubbed = compacted.stubbed;
            summarised = 0;
            notesInfo = {};
            facts = undefined;
            const fits = tokens <= room;
            const folded = await fold(request, compacted.messages, level, room, !fits);
            if (fits && (!folded || folded.tokens > room)) {
                break;
            }
            if (folded) {
                messages = folded.messages;
                tokens = folded.tokens;
                summarised = folded.turns;
                notesInfo = folded.info;
                facts = folded.facts;
                if (tokens <= room) {
                    break;
                }
            }
        }
        if (tokens > room) {
            // Still over at the hardest level: the person's longest messages too.
            const hardest = ladder[ladder.length - 1];
            const originals = new Map<string, { tool: string; text: string }>();
            const capped = capPersonMessages(messages, hardest, room, originals);
            if (capped.capped) {
                rememberOriginals(options.threadId, originals, Math.floor(hardest.capTokens * DATA_CHARS * 0.8));
                messages = capped.messages;
                stubbed += capped.capped;
            }
        }
        // A prompt with notes and no time marker left (the latest one's turn
        // is folded): the person's newest message gets one (CB-141).
        if (summarised && options.timeMarker && !latestMarker(messages)) {
            const at = newestFromPerson(messages);
            const marker = at >= 0 ? options.timeMarker() : undefined;
            if (marker) {
                messages = messages.with(at, withMarker(messages[at], marker));
            }
        }
        // The request's facts go in the turn's note, with the person's newest
        // message: all before it stays the same from turn to turn, and a turn's
        // later rounds come after it (CB-139).
        if (facts) {
            messages = withTurnNote(messages, factsText(facts));
        }
        // The newest images tools returned, as images (CB-157): after the
        // compaction and the notes, where a message of their own changes no
        // turn, and before the roles' pass.
        messages = await withToolImages(messages, options.capabilities, options.images, imageParts);
        // Last, the roles taking turns, whatever the stored conversation holds
        // (CB-147), and the prompt counted as sent, its labels and merges too,
        // for calibration.
        messages = alternating(messages);
        tokens = messagesTokens(messages);
        return {
            messages,
            sent: tokens + fixed,
            info: {
                beforeTokens: Math.round((total + fixed) * ratio),
                afterTokens: Math.round((tokens + fixed) * ratio),
                window: budget.window,
                stubbed,
                summarised,
                retried,
                ...notesInfo,
            },
        };
    };

    /** `compactNow`: the turns before the kept ones folded, if not yet. */
    const foldNow = async (asked: TextOptions): Promise<Compaction> => {
        const request = {
            ...asked,
            messages: withoutInlineToolImages(asked.messages),
        };
        const messages = request.messages;
        const starts = turnStarts(messages);
        const upTo = starts.length - (ladder[0].keepTurns - 1);
        const found = options.notes.get(options.threadId);
        const previous: KeptNotes = usable(found, messages, starts) ?? blank(found);
        if (!messages.length || upTo <= previous.turns) {
            return { folded: 0, turns: previous.turns };
        }
        const room = Math.max(
            Math.floor(
                budget.target / calibration(options.key) - fixedTokens(request.systemPrompts ?? [], request.tools),
            ),
            Math.floor(budget.target * 0.15),
        );
        const strict: { stopped?: 'error' | 'cap' } = {};
        const notes = await updateNotes(request, messages, starts, previous, upTo, room, strict);
        return {
            folded: notes.turns - previous.turns,
            turns: notes.turns,
            ...(strict.stopped ? { stopped: strict.stopped, left: upTo - notes.turns } : {}),
        };
    };

    const fitted = Object.create(adapter) as AnyTextAdapter;
    fitted.chatStream = async function* (request) {
        let refusedSize: number | undefined;
        // Screenshots older versions stored as base64 text become a short note
        // first (CB-157), in the prompt only.
        const input = {
            ...request,
            messages: withoutInlineToolImages(request.messages),
        };
        for (let retried = 0; ; retried++) {
            const round = await fitRound(input, retried, refusedSize);
            if (round.info.stubbed || round.info.summarised || retried) {
                options.emit({
                    type: EventType.CUSTOM,
                    name: CONTEXT_COMPACTION_EVENT,
                    value: round.info,
                } as BaseEvent);
                options.trace?.compaction(round.info);
            }
            if (retried) {
                options.trace?.request({ retry: retried });
            }
            // Held until the model shows it took the prompt: a refusal comes first.
            const held: unknown[] = [];
            let shown = false;
            let refused = false;
            try {
                for await (const chunk of adapter.chatStream({
                    ...request,
                    messages: round.messages,
                })) {
                    if (!shown) {
                        if (chunk.type === 'RUN_ERROR' && retried < MAX_RETRIES && isOverLength(chunk)) {
                            refused = true;
                            break;
                        }
                        if (chunk.type === 'RUN_STARTED') {
                            held.push(chunk);
                            continue;
                        }
                        shown = true;
                        for (const early of held.splice(0)) {
                            yield early as typeof chunk;
                        }
                    }
                    if (chunk.type === 'RUN_FINISHED') {
                        const usage = (chunk as { usage?: unknown }).usage;
                        const reported = (Array.isArray(usage) ? usage[0] : usage) as
                            | { promptTokens?: number; inputTokens?: number }
                            | undefined;
                        calibrate(options.key, round.sent, reported?.promptTokens ?? reported?.inputTokens ?? 0);
                    }
                    yield chunk;
                }
            } catch (error) {
                if (shown || retried >= MAX_RETRIES || !isOverLength(error)) {
                    throw error;
                }
                refused = true;
            }
            if (!refused) {
                for (const early of held) {
                    yield early as never;
                }
                return;
            }
            distrust(options.key);
            floor = Math.min(floor + 1, ladder.length - 1);
            refusedSize = round.sent;
            log(
                `Context: the model refused a ${round.info.afterTokens}-token prompt as too long; compacting harder (retry ${retried + 1} of ${MAX_RETRIES}).`,
            );
        }
    };
    return { adapter: fitted, foldNow };
}
