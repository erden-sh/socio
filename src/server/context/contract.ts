/**
 * What other features may know of a chat's context: the tags for the
 * stores and the fitting they reach, as slices of the methods they call,
 * and the plain types those slices name. It imports only `effect`,
 * `@socio/*` and, with `import type`, the allowlisted modules, and holds no
 * logic.
 *
 * The types here moved from the files that defined them, which re-export them,
 * so every importer keeps compiling until that importer switches to the
 * contract. The pure helpers other features call moved to `@socio/foundation/context/*`
 * (`room-context`, `speakers`, `turn-note`, `time-markers`, `budget`,
 * `speaker-echo`, `settings`); the feature logic (the notes, markers, steering
 * and reactions stores, fitting a prompt, the waiting turns) is behind the tags
 * below.
 *
 * Not here, on purpose: `reactionRoutes`, `steeringRoutes` and `pinRoutes`
 * (with the `roomPins` store it is given) are route mounting; they move into
 * the composition's HTTP files with the rest of the routes, not behind a
 * tag.
 */
import type { BaseEvent } from '@ag-ui/core';
import type { AnyTextAdapter, TextOptions } from '@tanstack/ai';
import { Context } from 'effect';

import type { NotesAudience, TimeMarker } from '@socio/foundation/context/time-markers';
import type { ToolImageSource } from '@socio/foundation/turns/tool-images';
import type { MessageReactions, ReactionKind } from '@socio/shared/chat/reactions';
import type {
    ReplyReportsState,
    ReportMark,
    ReportOutcome,
    ReportReason,
    ReportRemoval,
} from '@socio/shared/chat/reply-reports';
import type { QueuedMessage } from '@socio/shared/chat/steering';
import type { ContextSettings, NotesSelection } from '@socio/shared/context-settings';
import type { InferenceCapabilities } from '@socio/shared/inference';
import type { AttachmentRef } from '@socio/shared/media-types';

import type { FitTrace } from '../turns/contract.js';

export type { NotesAudience, TimeMarker } from '@socio/foundation/context/time-markers';
export type { Speaker } from '@socio/foundation/context/speakers';
export type { ContextBudget } from '@socio/foundation/context/budget';
// The turn's trace, as fitting writes to it: turns' port.
export type { FitTrace } from '../turns/contract.js';

// ── The chat's notes (`notes.ts`) ────────────────────────────────────────

/** A thread's stored fact, oldest first by `seq`. */
export interface StoredFact {
    seq: number;
    fact: string;
}

export interface RunningNotes {
    /** The thread's first turns these cover. */
    turns: number;
    anchor: string;
    summary: string;
    /** The summarizer's facts, word for word: goals, decisions, conclusions. */
    pinned: string[];
    /** Ids, paths, links and names found in the turns, word for word. */
    names: string[];
    /**
     * The time the latest marker told when its turn was folded into these
     * notes (CB-141); null while that turn is still in the prompt.
     */
    timeAt: number | null;
    /**
     * The time zone `timeAt` is given in (CB-159); null for notes folded
     * before, given in UTC as then.
     */
    timeZone: string | null;
    /** Markers older than this, in the turns after the notes, are left out. */
    markersFrom: number | null;
    /** How many times the notes were updated. */
    updates: number;
    updatedAt: number;
    /**
     * Whom they were written for (CB-210): a chat with other people in it
     * uses only notes written for it, `shared`.
     */
    audience: NotesAudience | null;
}

/** The notes as `ChatNotesShape.save` writes them: the store keeps the count and time. */
export type SavedNotes = Omit<
    RunningNotes,
    'updates' | 'updatedAt' | 'timeAt' | 'timeZone' | 'markersFrom' | 'audience'
> &
    Partial<Pick<RunningNotes, 'timeAt' | 'timeZone' | 'markersFrom' | 'audience'>>;

/** What a fold writes, together (`ChatNotesShape.fold`, CB-217). */
export interface NotesFold {
    /**
     * The notes' version (`updates`) the fold started from, 0 for none:
     * the fold is written only while it is still the one stored, so of two
     * folds at once, the first to finish wins and the other changes nothing.
     */
    base: number;
    notes: SavedNotes;
    /** The facts it pinned; `restart` first drops a changed history's. */
    facts: { add: readonly string[]; restart: boolean };
    /** Notes written for everyone (a room's) keep a version record. */
    record?: {
        fromTurns: number;
        method: 'model' | 'fallback';
        dotId?: string | null;
        actingUserId?: string | null;
        added: readonly string[];
    };
}

/** A stored version of a room's notes (CB-217). */
export interface StoredNotesVersion {
    version: number;
    fromTurns: number;
    turns: number;
    method: 'model' | 'fallback';
    dotId: string | null;
    actingUserId: string | null;
    summary: string;
    added: string[];
    createdAt: number;
}

/**
 * A thread's running notes and pinned facts (CB-129, CB-137, CB-217), as
 * `dots/` hands them to fitting and `memory/` reads their facts.
 * `notes.ts`'s `ContextNotes` implements it.
 */
export interface ChatNotesShape {
    get(threadId: string): RunningNotes | undefined;
    save(threadId: string, notes: SavedNotes, now?: number): void;
    /** Every fact the thread's notes pinned, oldest first. */
    facts(threadId: string): StoredFact[];
    /** Adds the summarizer's new facts; `restart` first drops a changed history's. */
    addFacts(threadId: string, facts: readonly string[], restart?: boolean, now?: number): void;
    /**
     * A fold's notes, facts and version in one transaction, if the notes are
     * still at `fold.base`: the new version, else undefined.
     */
    fold(threadId: string, fold: NotesFold, now?: number): Promise<number | undefined>;
    /** A room's notes' versions, newest first. */
    versions(threadId: string, limit?: number): StoredNotesVersion[];
}

export class ChatNotes extends Context.Service<ChatNotes, ChatNotesShape>()('socio/context/ChatNotes') {}

// ── Time markers (`time-markers.ts`) ─────────────────────────────────────

/**
 * The thread's stored time markers (CB-141, CB-159, CB-210), as `dots/` and
 * `skills/` read and write them. `time-markers.ts`'s `TimeMarkerStore`
 * implements it.
 */
export interface TimeMarkersShape {
    /** The thread's markers, by the message each is attached to. */
    all(threadId: string, shared?: boolean): Map<string, TimeMarker>;
    /** The marker for `messageId`, written now if it has none. */
    mark(threadId: string, messageId: string, now?: number, timeZone?: string, shared?: boolean): TimeMarker;
    /** A turn's markers, and one for the newest message if it needs one. */
    forTurn(
        threadId: string,
        userIds: readonly (string | undefined)[],
        now?: number,
        timeZone?: string,
        shared?: boolean,
    ): Map<string, TimeMarker>;
}

export class TimeMarkers extends Context.Service<TimeMarkers, TimeMarkersShape>()('socio/context/TimeMarkers') {}

// ── Fitting a prompt (`fit.ts`) ──────────────────────────────────────────

/** A model for the notes other than the chat's: the shared one. */
export interface Summarizer {
    /** Traced by the turn's tracer, as the chat's adapter is. */
    adapter: AnyTextAdapter;
    model: string | null;
    /** In place of the chat's (the completion cap, one-shot options). */
    modelOptions: Record<string, unknown>;
    capabilities: InferenceCapabilities;
}

export interface FitOptions {
    capabilities: InferenceCapabilities;
    /** Whose estimates are calibrated together: one per model. */
    key: string;
    threadId: string;
    notes: ChatNotesShape;
    /** Phase-line and compaction events, into the turn's stream. */
    emit: (event: BaseEvent) => void;
    /** The turn's trace (CB-128), when the adapter beneath is traced. */
    trace?: FitTrace;
    /** Operational lines only (no content). */
    log?: (line: string) => void;
    /** The chat's model id, for the trace of the notes it writes. */
    model?: string | null;
    /**
     * The notes' own model (CB-137), when it is not the chat's: resolved the
     * first time the turn needs it; the chat's model when it gives none.
     */
    summarizer?: () => Promise<Summarizer | undefined>;
    /** Which pinned facts a prompt carries (CB-134); `age` when unset. */
    selection?: NotesSelection;
    /**
     * The recall budget in force (CB-173, `memory/turn.ts`): the request's
     * facts' share grows and shrinks with it; as by default when unset.
     */
    recallTokens?: number;
    /**
     * `relevance` also asks the notes' model to rank the facts, once a turn
     * (measured: about 2 s a turn for little gain, so the app ranks by words).
     */
    rankWithModel?: boolean;
    /**
     * The time marker of the person's newest message, made if it has none
     * (CB-141): for a prompt whose notes leave it no marker.
     */
    timeMarker?: () => TimeMarker | undefined;
    /**
     * The turn's person's time zone (CB-159), which a fold gives the notes'
     * time in; UTC when unset.
     */
    timeZone?: string;
    /**
     * The bytes of the images tools' results name (CB-157,
     * `context/images.ts`), from this conversation only. Without it they
     * stay notes.
     */
    images?: ToolImageSource;
    /**
     * The chat has other people in it (CB-210, `sharedChat`): its notes are
     * everyone's, so they are written from a transcript with each person
     * named and no tool's result, and notes written for one person's chat
     * alone (before it was shared, or before CB-210) are never used: they
     * start over.
     */
    shared?: boolean;
    /**
     * Episodes (CB-180, `memory/`): each fold of a person's own chat hands
     * the facts it newly pinned, and the model's summary (none when it fell
     * back), to that person's episodes. Never called when `shared`; a
     * failure is reported and never fails the turn or the fold.
     */
    episodes?: (fold: { facts: readonly string[]; summary?: string; occurredAt?: number }) => unknown;
    /**
     * The socio and the person whose turn this is: a room's notes record
     * them with each version they fold (CB-217).
     */
    writer?: { dotId?: string; userId?: string };
}

/** What `/compact` did (CB-143). */
export interface Compaction {
    /** The turns folded into the notes now. */
    folded: number;
    /** The turns the notes cover. */
    turns: number;
    /**
     * Why it stopped before folding all it meant to: a summary failed, or
     * the summaries a turn may make were used up. Only what the model
     * summarized is in the notes.
     */
    stopped?: 'error' | 'cap';
    /** The turns it meant to fold and didn't. */
    left?: number;
}

/**
 * Long chats that never outgrow their model (CB-129, CB-143), as `dots/`
 * and `skills/` call it: `fit` is `fitContext`, `compactNow` is `/compact`.
 * `fit.ts`'s `contextFitting` implements it.
 */
export interface ContextFittingShape {
    /** The adapter with every round's prompt fitted; one per turn. */
    fit(adapter: AnyTextAdapter, options: FitOptions): AnyTextAdapter;
    /** Folds the conversation's turns into the notes now. */
    compactNow(adapter: AnyTextAdapter, options: FitOptions, request: TextOptions): Promise<Compaction>;
}

export class ContextFitting extends Context.Service<ContextFitting, ContextFittingShape>()(
    'socio/context/ContextFitting',
) {}

// ── Steering (`steering.ts`, `steering-turns.ts`) ────────────────────────

/**
 * The steering queue (CB-151): messages a person sent while their Dot's
 * turn ran, per conversation and person, oldest first. A message is
 * delivered at most once: `take` removes the rows it returns in one
 * statement. A turn's own round takes only the text before the first
 * message with attachments (`takeText`, CB-223). `steering.ts`'s
 * `SqliteSteeringQueue` implements it.
 */
export interface SteeringQueue {
    /** The person's waiting messages in the conversation, oldest first. */
    list(threadId: string, userId: string): Promise<QueuedMessage[]>;
    /** How many the person has waiting there. */
    count(threadId: string, userId: string): Promise<number>;
    add(
        threadId: string,
        userId: string,
        text: string,
        now?: number,
        attachments?: readonly AttachmentRef[],
    ): Promise<QueuedMessage>;
    /**
     * Adds it unless `limit` of the person's wait there already (CB-170), in
     * one statement; undefined then.
     */
    addIfRoom(
        threadId: string,
        userId: string,
        text: string,
        limit: number,
        now?: number,
        attachments?: readonly AttachmentRef[],
    ): Promise<QueuedMessage | undefined>;
    /**
     * The message with new text, and (given) the attachments it keeps
     * (CB-223); undefined once delivered or canceled.
     */
    edit(
        threadId: string,
        userId: string,
        id: string,
        text: string,
        now?: number,
        attachments?: readonly AttachmentRef[],
    ): Promise<QueuedMessage | undefined>;
    /** False once delivered or canceled. */
    cancel(threadId: string, userId: string, id: string): Promise<boolean>;
    /**
     * Everyone else's waiting messages in the conversation (CB-215), oldest
     * first, with whose each is: what a room admin may cancel.
     */
    others(threadId: string, userId: string): Promise<Array<QueuedMessage & { userId: string }>>;
    /**
     * Cancels the message whoever's it is (CB-215: a room admin's cancel);
     * whose it was, or undefined once delivered or canceled. Never edits.
     */
    cancelAny(threadId: string, id: string): Promise<string | undefined>;
    /** Removes and returns the person's waiting messages, oldest first. */
    take(threadId: string, userId: string): Promise<QueuedMessage[]>;
    /**
     * `take` for a turn's next round (CB-223): only the messages before the
     * first with attachments, which waits, with those after it, for the
     * next turn; and (given) before the first that `waits` holds back (in a
     * room, one that names another socio, CB-206).
     */
    takeText(threadId: string, userId: string, waits?: (message: QueuedMessage) => boolean): Promise<QueuedMessage[]>;
    /** Puts taken messages back, in their place, when no turn could take them. */
    restore(threadId: string, userId: string, messages: readonly QueuedMessage[]): Promise<void>;
    /**
     * The ids of the messages waiting in the conversation, whoever's: each
     * becomes its message's id once delivered, so no request may claim one
     * first (CB-223, CB-225).
     */
    ids(threadId: string): Promise<Set<string>>;
    /** Conversations with messages waiting, and whose they are. */
    waiting(): Promise<{ threadId: string; userId: string }[]>;
    /**
     * The attachments the waiting messages carry (CB-223): not sent yet, but
     * not left unsent either, so their cleanup keeps them.
     */
    attachmentIds(): Promise<Set<string>>;
}

export class Steering extends Context.Service<Steering, SteeringQueue>()('socio/context/Steering') {}

/**
 * The turns steering messages left waiting (CB-151, CB-170), as the
 * composition (`LegacySteering`), the server's start and the steering routes drive them.
 * `steering-turns.ts`'s `SteeringTurns` implements it.
 */
export interface WaitingTurnsShape {
    /** The run id of the turn started here in the conversation, while it runs. */
    turn(threadId: string): string | undefined;
    /** At start, and when Socio is resumed: what waits since. */
    resume(): Promise<void>;
    stop(): void;
    /**
     * Starts a turn with the conversation's waiting messages when none runs
     * there; whether it did. Never fails its caller.
     */
    consider(threadId: string): Promise<boolean>;
}

export class WaitingTurns extends Context.Service<WaitingTurns, WaitingTurnsShape>()('socio/context/WaitingTurns') {}

// ── Reactions (`reactions.ts`, `reaction-routes.ts`) ─────────────────────

export interface ReactionRow {
    messageId: string;
    userId: string;
    kind: ReactionKind;
    createdAt: number;
    messageAt: number | null;
    excerpt: string;
}

/**
 * Reactions on a Dot's messages (CB-133), as `telegram/` and the
 * composition use them. `reactions.ts`'s `MessageReactionStore` implements it.
 */
export interface ReactionsShape {
    /** Adds one (again is fine); a thumbs up removes the same person's thumbs down. */
    add(
        threadId: string,
        messageId: string,
        userId: string,
        kind: ReactionKind,
        message: { at?: number; text: string },
        now?: number,
    ): ReportRemoval | undefined;
    /**
     * Removes one. Removing a thumbs-down (or replacing it with a thumbs-up,
     * in `add`) withdraws the person's report on that reply (CB-382): what it
     * answers is what became of it, when there was one.
     */
    remove(threadId: string, messageId: string, userId: string, kind: ReactionKind): ReportRemoval | undefined;
    /** The thread's messages that have reactions, as `userId` sees them. */
    view(threadId: string, userId: string): Record<string, MessageReactions>;
    /** Reactions no turn was told about yet, oldest first. */
    unnoted(threadId: string): ReactionRow[];
    /** Marks the thread's reactions given by `at` as told. */
    markNoted(threadId: string, at: number): void;
    /** What the Learning analysis reads under each message. */
    labels(threadId: string): Map<string, string>;
}

export class Reactions extends Context.Service<Reactions, ReactionsShape>()('socio/context/Reactions') {}

// ── AI reply reports (CB-382, docs/specs/REPLY-REPORTS.md) ─────────────────

/** What the reaction route gathered about a confirmed report, before it is redacted and sealed. */
export interface ReactionReportInput {
    threadId: string;
    messageId: string;
    userId: string;
    /** The consent the person confirmed under (`ReplyReportsState.consent`). */
    consent: string;
    reason: ReportReason;
    /** Trimmed; at most `REPORT_NOTE_MAX` code points. */
    note?: string;
    /** The reply's text as shown, and when it was written. */
    reply: { text: string; at?: number };
    /** The message it answered, as text (attachments as `[attachment: …]`), and whether it is another person's. */
    prompt?: { text: string; byOther: boolean };
    model?: string;
    /** The socio that wrote the reply: only its hash leaves. */
    socioId?: string;
    surface?: 'web' | 'mobile' | 'telegram';
    appVersion?: string;
}

/** A report ready to queue: its id and sealed body, made outside the reaction's unit of work. */
export interface PreparedReactionReport {
    readonly id: string;
    readonly threadId: string;
    readonly messageId: string;
    readonly userId: string;
    readonly consent: string;
    readonly sealed: string;
    readonly createdAt: number;
}

/**
 * What the reactions ask of the reply reports, which `cloud/` (above
 * context in the folder order) implements as its `ReplyReports`. `file`
 * and `withdraw` are synchronous writes on the workspace connection, so the
 * reaction's own unit of work holds them with the reaction row.
 */
export interface ReactionReportsShape {
    /** Whether reports are shared now, and under which consent. */
    state(): ReplyReportsState;
    /** This person's report on this reply, if one exists. */
    mark(threadId: string, messageId: string, userId: string): ReportMark | undefined;
    /** This person's reports in a conversation, by reply. */
    marks(threadId: string, userId: string): Record<string, ReportMark>;
    /** Redacts, cuts, hashes and seals the report's body. */
    prepare(input: ReactionReportInput): Promise<PreparedReactionReport>;
    /** Queues it, after checking sharing, consent and an existing report again. */
    file(report: PreparedReactionReport): ReportOutcome;
    /** The thumbs-down went: an unsent report is deleted (`withdrawn`), a sent one stays (`kept`). */
    withdraw(threadId: string, messageId: string, userId: string): ReportRemoval | undefined;
}

/** A Dot's stored reply, the only kind of message a reaction is for. */
export interface DotReply {
    text: string;
    at?: number;
}

/**
 * Finds a Dot's stored reply by id (`dotMessage`, CB-133, CB-145), as
 * `telegram/` checks a reaction's message. `reaction-routes.ts`'s
 * `dotReplies(runner, replay)` builds it.
 */
export interface DotRepliesShape {
    find(threadId: string, id: string): Promise<DotReply | undefined>;
}

export class DotReplies extends Context.Service<DotReplies, DotRepliesShape>()('socio/context/DotReplies') {}

// ── Shared chats (the module's tools) ─────────────────────────────────────

/**
 * Whether a chat has people besides `userId` in it, as the module's tools
 * withhold for one: memory's `TurnMemory.sharedChat`, by the slice the
 * tools call (memory is above context in the folder order, so the port is
 * declared here and the composition provides it from `TurnMemory`).
 */
export interface SharedChatsShape {
    sharedChat(threadId: string, userId: string): Promise<boolean>;
}

export class SharedChats extends Context.Service<SharedChats, SharedChatsShape>()('socio/context/SharedChats') {}

// ── Config ───────────────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `context/` reads itself: `CONTEXT_SUMMARY_MODEL`
 * and `CONTEXT_SELECTION` (CB-137, CB-134), under what an admin saved.
 * `PlatformConfig` has it with this type, so the composition root can
 * provide the tag from it. The config `steering-turns.ts` hands whole to
 * `dots/` is carried by `DotsConfig` and the other features' config tags.
 */
export interface ContextConfigShape {
    readonly context?: Partial<ContextSettings>;
}

export class ContextConfig extends Context.Service<ContextConfig, ContextConfigShape>()(
    'socio/context/ContextConfig',
) {}
