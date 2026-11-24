import { failureCategory, type FailureCategory } from '@socio/shared/failure-taxonomy';
import { isRoomOwnerId, TEAM_OWNER_PREFIX } from '@socio/shared/rooms/rooms';
import { runSource } from '@socio/shared/runs/run-sources';
import { REASONING_KINDS, RUN_ACTOR_KINDS } from '@socio/shared/runs/run-trace';

import type { SourceRun } from './source-run.js';

/**
 * One stored turn as the analytics store's facts (CB-164, CB-187): the
 * turn, its messages with their authors, and its tool calls. Pure: no I/O.
 *
 * Who started a turn and wrote its messages comes from the trace when the
 * turn recorded it (CB-185: `trace.trigger`, `trace.messages`), with
 * `attribution: 'exact'`. Turns from before fall back: a person's messages
 * and turns are credited to the chat's owner (a person, or a team for a
 * shared Telegram topic; in a room, none: its owner is no person, CB-213),
 * `attribution: 'owner'`; an automation's (a
 * schedule) to the kind its source registers, with no id,
 * `attribution: 'source'`. Messages come from the stored events
 * (`RUN_STARTED.input.messages` for the turn's new person messages,
 * `TEXT_MESSAGE_START` for the socio's), which also give their length and
 * attachments; never their content.
 *
 * Rooms (CB-218): a turn that recorded its work cycle (CB-211's
 * `trace.cycle`) also says whose access it used (`actingId`), who paid
 * (`payerKind`, `payerId`), the cycle and its hop, and which socio ran
 * it, which is the turn's socio (several socios answer in one room once
 * CB-206 lands; until then it is the room's lead). A turn from before
 * records none of that: those columns stay null, never guessed, and its
 * socio is the chat's. Where it ran (`containerKind`) is a person's chat,
 * a team's Telegram topic or a room, as it was then: a chat converted to
 * a room was a private chat before (`convertedAt`), whose unrecorded
 * turns are its one owner's, the person who converted it.
 */

/** Who or what a turn or message is from (CB-185's `RunActor`). */
export interface Actor {
    kind: string;
    id?: string;
}
export type Attribution = 'exact' | 'owner' | 'source';
/** Where a turn ran: a person's chat, a team's Telegram topic, a room. */
export type ContainerKind = 'person' | 'team' | 'room';

export interface TurnFact {
    seq: number;
    runId: string;
    threadId: string;
    socioId: string | null;
    source: string;
    triggerKind: string;
    triggerId: string | null;
    attribution: Attribution;
    status: string;
    endReason: string | null;
    failureCode: string | null;
    receivedAt: number | null;
    startedAt: number;
    finishedAt: number | null;
    rounds: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
    /** summary | raw | hidden | none | mixed | unknown (not recorded). */
    reasoningKind: string;
    /** The model reported reasoning tokens apart (self-hosted ones often don't). */
    reasoningTokensReported: boolean;
    model: string | null;
    backendKey: string | null;
    /** The shared backend that served it (CB-195), when the trace says. */
    backendId: string | null;
    toolCalls: number;
    toolErrors: number;
    toolRefusals: number;
    approvalWaits: number;
    personWaits: number;
    retries: number;
    fallbackReason: string | null;
    /** How the last model round's output ended (`stop`, CB-128). */
    lastStop: string | null;
    /** The run kept an operator detail; never the text. */
    hasDetail: boolean;
    /** The failure taxonomy's category (CB-189); null: not a failure. */
    failureCategory: FailureCategory | null;
    failureRule: string;
    /** Where it ran, as it was then (CB-218). */
    containerKind: ContainerKind;
    /** Its work cycle (CB-211) and hop; null when it recorded none. */
    cycleId: string | null;
    hop: number | null;
    /** Whose access, data and subscription it used; null: not recorded. */
    actingId: string | null;
    /** Who paid for its model use: a person (`payerId`) or the workspace. */
    payerKind: 'person' | 'workspace' | null;
    payerId: string | null;
}

export interface MessageFact {
    messageId: string;
    sentAt: number;
    /** person | socio | schedule | agent | system */
    authorKind: string;
    authorId: string | null;
    attribution: Attribution;
    /** Its text's length; null when the events don't hold it. */
    chars: number | null;
    attachments: number;
}

export interface ToolFact {
    idx: number;
    round: number;
    tool: string;
    outcome: string;
    code: string | null;
    startedAt: number;
    durationMs: number;
    /** The failure taxonomy's category (CB-189); null: it worked. */
    category: FailureCategory | null;
    categoryRule: string;
}

/** A model round (`trace.rounds`, without summaries), for Health (CB-192). */
export interface RoundFact {
    round: number;
    startedAt: number;
    durationMs: number;
    /** To its first visible output; null when the trace didn't time it. */
    firstOutputMs: number | null;
    /** As the round recorded it (CB-185), else `unknown`. */
    reasoningKind: string;
}

export interface RunFacts {
    turn: TurnFact;
    messages: MessageFact[];
    tools: ToolFact[];
    rounds: RoundFact[];
}

/**
 * The trace fields read here (`RunTrace`, CB-185's included), as stored:
 * any may be absent or malformed in an old or damaged row.
 */
interface StoredTrace {
    turn?: { model?: unknown; source?: unknown; backendId?: unknown };
    rounds?: unknown[];
    tools?: unknown[];
    waits?: unknown[];
    retries?: unknown[];
    fallback?: { reason?: unknown };
    end?: { reason?: unknown };
    totals?: {
        rounds?: unknown;
        inputTokens?: unknown;
        outputTokens?: unknown;
        reasoningTokens?: unknown;
        cachedTokens?: unknown;
        reasoningKind?: unknown;
    };
    receivedAt?: unknown;
    trigger?: unknown;
    messages?: unknown[];
    cycle?: unknown;
}

/** The work cycle a turn recorded (CB-211's `TraceCycle`), checked. */
interface Cycle {
    id: string;
    kind: 'private' | 'room';
    hop: number;
    actingUserId: string;
    dotId: string;
    billing: 'person' | 'workspace' | null;
}

const ACTOR_KINDS = new Set<string>(RUN_ACTOR_KINDS);
const REASONING = new Set<string>(REASONING_KINDS);
/** A short code or name, as traces keep them; anything else is dropped. */
const CODE = /^[\w.:/@+-]{1,120}$/;

/**
 * A notice the server writes as the socio (the model is busy, CB-140's
 * `status-…` message), not a message of the conversation.
 */
const notice = (id: string) => id.startsWith('status-');
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const code = (value: unknown) => (typeof value === 'string' && CODE.test(value) ? value : null);
/** A name as traces keep it (a model, a backend), trimmed. */
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null);
const parse = (text: string | null): unknown => {
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
};
const actorOf = (value: unknown): Actor | undefined => {
    if (!isObject(value) || !ACTOR_KINDS.has(value.kind as string)) {
        return undefined;
    }
    const id = code(value.id);
    return { kind: value.kind as string, ...(id ? { id } : {}) };
};

function cycleOf(value: unknown): Cycle | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    const id = code(value.id);
    const actingUserId = code(value.actingUserId);
    const dotId = code(value.dotId);
    const hop = num(value.hop);
    if (!id || !actingUserId || !dotId) {
        return undefined;
    }
    return {
        id,
        kind: value.kind === 'room' ? 'room' : 'private',
        hop: hop !== undefined && hop >= 0 ? Math.floor(hop) : 0,
        actingUserId,
        dotId,
        billing: value.billing === 'person' || value.billing === 'workspace' ? value.billing : null,
    };
}

/**
 * Where a turn ran, as it was then: its cycle's kind when it recorded
 * one; else the chat's now, except before a room's conversion, when it
 * was a private chat (or a Telegram topic, for a room a topic became).
 */
function containerOf(run: SourceRun, cycle: Cycle | undefined): ContainerKind {
    const team = !!run.ownerId?.startsWith(TEAM_OWNER_PREFIX);
    if (cycle) {
        return cycle.kind === 'room' ? 'room' : team ? 'team' : 'person';
    }
    if (run.chatKind === 'room') {
        if (typeof run.convertedAt === 'number' && run.startedAt < run.convertedAt) {
            return run.fromTopic ? 'team' : 'person';
        }
        return 'room';
    }
    return team ? 'team' : 'person';
}

/** A message's text length and attachments, from its content parts. */
function measure(content: unknown) {
    if (typeof content === 'string') {
        return { chars: content.length, files: 0 };
    }
    let chars = 0;
    let files = 0;
    if (Array.isArray(content)) {
        for (const part of content) {
            if (!isObject(part)) {
                continue;
            }
            if (part.type === 'text' && typeof part.text === 'string') {
                chars += part.text.length;
            } else if (part.type !== 'text') {
                files++;
            }
        }
    }
    return { chars, files };
}

/**
 * The turn's reasoning kind (CB-185's `turnReasoningKind`): its rounds'
 * one kind, `mixed` when they differ, `unknown` when none said (turns
 * from before).
 */
function reasoningKind(trace: StoredTrace): string {
    const total = trace.totals?.reasoningKind;
    if (typeof total === 'string' && (REASONING.has(total) || total === 'mixed')) {
        return total;
    }
    const kinds = new Set<string>();
    for (const round of trace.rounds ?? []) {
        if (isObject(round) && !round.summary && REASONING.has(round.reasoningKind as string)) {
            kinds.add(round.reasoningKind as string);
        }
    }
    if (kinds.size > 1) {
        kinds.delete('none');
    }
    if (kinds.size > 1) {
        return 'mixed';
    }
    return kinds.values().next().value ?? 'unknown';
}

/** Tokens: the trace's totals, else its rounds added up (a running turn). */
function tokens(trace: StoredTrace, key: keyof NonNullable<StoredTrace['totals']>) {
    const total = num(trace.totals?.[key]);
    if (total !== undefined) {
        return total;
    }
    let sum: number | null = null;
    for (const round of trace.rounds ?? []) {
        const value = isObject(round) ? num(round[key]) : undefined;
        if (value !== undefined) {
            sum = (sum ?? 0) + value;
        }
    }
    return sum;
}

export function runFacts(run: SourceRun): RunFacts {
    const stored = parse(run.trace);
    const trace = (isObject(stored) ? stored : {}) as StoredTrace;
    const events = parse(run.events);
    const list = Array.isArray(events) ? events : [];
    const registered = runSource(run.source);
    const cycle = cycleOf(trace.cycle);
    const containerKind = containerOf(run, cycle);
    // The socio that ran it: its cycle's (CB-206 adds more than one per
    // room), else the chat's.
    const socioId = cycle?.dotId ?? run.socioId;

    // Who started it.
    const recorded = actorOf(trace.trigger);
    let trigger: Actor;
    let attribution: Attribution;
    if (recorded && (recorded.id || recorded.kind !== 'person')) {
        trigger = recorded;
        attribution = 'exact';
    } else if (registered.kind === 'automation') {
        trigger = { kind: registered.actor ?? 'system' };
        attribution = 'source';
    } else {
        // A room's owner is its sentinel (`room:<id>`), no person (CB-213):
        // an unrecorded turn there is a person's, none known; before a private
        // chat became the room, its one owner's, who converted it (CB-218).
        const owner =
            run.chatKind === 'room'
                ? containerKind === 'person'
                    ? (code(run.createdBy) ?? undefined)
                    : undefined
                : run.ownerId && !isRoomOwnerId(run.ownerId)
                  ? run.ownerId
                  : undefined;
        trigger = { kind: 'person', ...(owner ? { id: owner } : {}) };
        attribution = 'owner';
    }

    // The events: the turn's new messages, its error code.
    // `streamed`: its text comes in content events (a socio's answer, or a
    // person's message delivered mid-turn), not whole in RUN_STARTED.
    const fromEvents = new Map<
        string,
        {
            kind: 'person' | 'socio';
            at: number;
            chars: number;
            files: number;
            streamed?: true;
        }
    >();
    let failureCode: string | null = null;
    for (const event of list) {
        if (!isObject(event)) {
            continue;
        }
        const at = num(event.timestamp) ?? run.startedAt;
        switch (event.type) {
            case 'RUN_STARTED': {
                const input = isObject(event.input) ? event.input : {};
                for (const message of Array.isArray(input.messages) ? input.messages : []) {
                    if (!isObject(message) || message.role !== 'user' || typeof message.id !== 'string') {
                        continue;
                    }
                    const { chars, files } = measure(message.content);
                    fromEvents.set(message.id, { kind: 'person', at, chars, files });
                }
                break;
            }
            case 'TEXT_MESSAGE_START':
                if (
                    typeof event.messageId === 'string' &&
                    !notice(event.messageId) &&
                    !fromEvents.has(event.messageId)
                ) {
                    // A person's message sent while the turn ran (CB-151's steering)
                    // is the turn's person's, as CB-185 credits its new messages.
                    const kind =
                        event.role === undefined || event.role === 'assistant'
                            ? 'socio'
                            : event.role === 'user'
                              ? 'person'
                              : undefined;
                    if (kind) {
                        fromEvents.set(event.messageId, {
                            kind,
                            at,
                            chars: 0,
                            files: 0,
                            streamed: true,
                        });
                    }
                }
                break;
            case 'TEXT_MESSAGE_CONTENT':
            case 'TEXT_MESSAGE_CHUNK': {
                const message = typeof event.messageId === 'string' ? fromEvents.get(event.messageId) : undefined;
                if (message?.streamed && typeof event.delta === 'string') {
                    message.chars += event.delta.length;
                }
                break;
            }
            case 'RUN_ERROR':
                failureCode = code(event.code) ?? failureCode ?? 'run_error';
                break;
        }
    }

    // Messages: the trace's authors where it named them (CB-185), else the
    // fallbacks above; the events' length and attachments where they have them.
    const messages = new Map<string, MessageFact>();
    const socio: Actor = {
        kind: 'socio',
        ...(socioId ? { id: socioId } : {}),
    };
    for (const [id, seen] of fromEvents) {
        const author = seen.kind === 'socio' ? socio : trigger;
        messages.set(id, {
            messageId: id,
            sentAt: seen.at,
            authorKind: author.kind,
            authorId: author.id ?? null,
            // The chat's socio wrote its answers.
            attribution: seen.kind === 'socio' ? (socioId ? 'exact' : 'source') : attribution,
            chars: seen.chars,
            attachments: seen.files,
        });
    }
    for (const entry of trace.messages ?? []) {
        if (!isObject(entry) || typeof entry.id !== 'string' || notice(entry.id)) {
            continue;
        }
        const author = actorOf(entry.author);
        if (!author) {
            continue;
        }
        const seen = messages.get(entry.id);
        const known = !!author.id;
        // A message the trace names without an author id keeps the fallback.
        const who = known ? author : author.kind === 'socio' ? socio : author.kind === trigger.kind ? trigger : author;
        messages.set(entry.id, {
            messageId: entry.id,
            sentAt: num(entry.at) ?? seen?.sentAt ?? run.startedAt,
            authorKind: who.kind,
            authorId: who.id ?? null,
            attribution: known ? 'exact' : (seen?.attribution ?? 'source'),
            chars: seen?.chars ?? null,
            attachments: seen?.attachments ?? 0,
        });
    }

    const tools: ToolFact[] = [];
    let toolErrors = 0;
    let toolRefusals = 0;
    for (const [idx, tool] of (trace.tools ?? []).entries()) {
        if (!isObject(tool) || typeof tool.name !== 'string') {
            continue;
        }
        const startedAt = num(tool.startedAt) ?? run.startedAt;
        const outcome = typeof tool.outcome === 'string' ? tool.outcome.slice(0, 16) : 'ok';
        if (outcome === 'error' || outcome === 'timeout') {
            toolErrors++;
        }
        if (outcome === 'refused') {
            toolRefusals++;
        }
        const name = tool.name.slice(0, 120);
        const errorCode = code(tool.error);
        const failure = failureCategory({
            level: 'tool',
            tool: name,
            outcome,
            code: errorCode,
        });
        tools.push({
            idx,
            round: num(tool.round) ?? 0,
            tool: name,
            outcome,
            code: errorCode,
            startedAt,
            durationMs: Math.max(0, (num(tool.endedAt) ?? startedAt) - startedAt),
            category: failure.category,
            categoryRule: failure.ruleId,
        });
    }

    const rounds = trace.rounds ?? [];
    const roundFacts: RoundFact[] = [];
    for (const round of rounds) {
        if (!isObject(round) || round.summary) {
            continue;
        }
        const startedAt = num(round.startedAt) ?? run.startedAt;
        const firstOutput = num(round.firstOutputMs);
        roundFacts.push({
            round: num(round.round) ?? roundFacts.length + 1,
            startedAt,
            durationMs: Math.max(0, (num(round.endedAt) ?? startedAt) - startedAt),
            firstOutputMs: firstOutput === undefined ? null : Math.max(0, Math.round(firstOutput)),
            reasoningKind: REASONING.has(round.reasoningKind as string) ? (round.reasoningKind as string) : 'unknown',
        });
    }
    const waits = (trace.waits ?? []).filter(isObject);
    const lastError = [...rounds].reverse().find((round) => isObject(round) && code(round.error));
    const reasoningTokens = tokens(trace, 'reasoningTokens');
    const lastRound = [...rounds].reverse().find((round) => isObject(round) && !round.summary);
    const endReason = code(trace.end?.reason);
    const turnCode = failureCode ?? (isObject(lastError) ? code(lastError.error) : null) ?? null;
    const lastStop = isObject(lastRound) ? code(lastRound.stop) : null;
    const fallbackReason = code(trace.fallback?.reason);
    const hasDetail = !!run.detail;
    const failure = failureCategory({
        level: 'turn',
        status: run.status,
        endReason,
        code: turnCode,
        stop: lastStop,
        fallback: fallbackReason !== null,
        detail: hasDetail,
    });
    const turn: TurnFact = {
        seq: run.seq,
        runId: run.runId,
        threadId: run.threadId,
        socioId,
        source: run.source,
        triggerKind: trigger.kind,
        triggerId: trigger.id ?? null,
        attribution,
        status: run.status,
        endReason,
        failureCode: turnCode,
        receivedAt: num(trace.receivedAt) ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        rounds:
            num(trace.totals?.rounds) ??
            rounds.filter((round) => isObject(round) && !round.retry && !round.summary).length,
        inputTokens: tokens(trace, 'inputTokens'),
        outputTokens: tokens(trace, 'outputTokens'),
        cachedTokens: tokens(trace, 'cachedTokens'),
        reasoningTokens,
        reasoningKind: reasoningKind(trace),
        reasoningTokensReported: reasoningTokens !== null,
        model: text(trace.turn?.model),
        backendKey: text(trace.turn?.source),
        backendId: code(trace.turn?.backendId),
        toolCalls: tools.length,
        toolErrors,
        toolRefusals,
        approvalWaits: waits.filter((wait) => wait.for === 'approval').length,
        personWaits: waits.filter((wait) => wait.for === 'person').length,
        retries: (trace.retries ?? []).length,
        fallbackReason,
        lastStop,
        hasDetail,
        failureCategory: failure.category,
        failureRule: failure.ruleId,
        containerKind,
        cycleId: cycle?.id ?? null,
        hop: cycle ? cycle.hop : null,
        actingId: cycle?.actingUserId ?? null,
        payerKind: cycle?.billing ?? null,
        payerId: cycle?.billing === 'person' ? cycle.actingUserId : null,
    };
    return {
        turn,
        messages: [...messages.values()],
        tools,
        rounds: roundFacts,
    };
}
