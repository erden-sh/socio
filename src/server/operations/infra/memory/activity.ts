import { topicKey, type ThemeOutcome } from '@socio/shared/classify';
import { bucketStart, bucketStarts, type OpsFilters } from '@socio/shared/operations/operations';
import {
    OPS_ACTIVITY_TILES,
    OPS_OUTCOME_WINDOW_MS,
    OPS_REPEAT_DAYS,
    OPS_RETURN_DAYS,
    OPS_VALUE_TILES,
    type OpsActivityFacts,
    type OpsActivityTileId,
    type OpsChatRow,
    type OpsOutcome,
    type OpsPersonRow,
    type OpsSessionRow,
    type OpsSocioRow,
    type OpsSourceUse,
    type OpsSpaceUse,
    type OpsToolCapability,
    type OpsValueFacts,
    type OpsValueTileId,
} from '@socio/shared/operations/operations-activity';
import type { OpsLabelledSession } from '@socio/shared/operations/operations-themes';
import { runSource } from '@socio/shared/runs/run-sources';

import { afterCursor, type OpsCursor } from '../../domain/cursor.js';
import type { OpsPage, OpsPageRequest, OpsScope, OpsSessionOptions } from '../../domain/reader.js';
import { aggregateThemes, intentRows } from '../../themes/aggregate.js';

import type { MessageFact, TurnFact } from './facts.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A tool call, as `f_tool` keeps it, with its turn's socio, Space and starter. */
export interface ToolFact {
    runId: string;
    threadId: string;
    socioId: string | null;
    spaceId?: string | null;
    source: string;
    /** The person who started its turn, when a person did. */
    personId?: string | null;
    tool: string;
    outcome: string;
    startedAt: number;
}
/** An approval event (`f_approval`). */
export interface ApprovalFact {
    id: string;
    at: number;
    threadId: string | null;
    socioId: string;
    personId: string;
    capability: string;
    event: string;
}
export interface ReactionFact {
    threadId: string;
    messageId: string;
    personId: string;
    kind: string;
    at: number;
}
/** A page made or edited (`f_space_write`). */
export interface SpaceWriteFact {
    at: number;
    spaceId: string;
    pageId: string;
    authorKind: 'person' | 'socio' | null;
    authorId: string | null;
    threadId: string | null;
}
export interface MemoryFact {
    threadId: string;
    status: string;
    at: number;
    deletedAt?: number | null;
}
/** A session's intent in force (`f_intent`), by the turn that opened it (CB-199). */
export interface IntentFact {
    runId: string;
    intent: string;
}
/** One of a session's topics in force (`f_theme`), with its outcome hint. */
export interface ThemeFact {
    runId: string;
    topic: string;
    outcome: ThemeOutcome;
}

/** What Activity reads besides turns and messages, and the dimensions' names. */
export interface ActivityFacts {
    tools?: readonly ToolFact[];
    approvals?: readonly ApprovalFact[];
    reactions?: readonly ReactionFact[];
    spaceWrites?: readonly SpaceWriteFact[];
    memories?: readonly MemoryFact[];
    /** Sessions' intents and topics (CB-199). */
    intents?: readonly IntentFact[];
    themes?: readonly ThemeFact[];
    people?: readonly { id: string; name: string }[];
    socios?: readonly { id: string; name: string; spaceId: string }[];
    spaces?: readonly { id: string; name: string }[];
    chats?: readonly {
        id: string;
        socioId: string;
        ownerKind: 'person' | 'team' | 'room';
        /** A room's name (CB-218). */
        title?: string | null;
    }[];
}

interface Session {
    id: string;
    threadId: string;
    socioId: string | null;
    source: string;
    startedAt: number;
    endedAt: number;
    messages: number;
    people: Set<string>;
    socios: Set<string>;
    human: boolean;
    lastRun: string | undefined;
    nextAt: number | null;
    outcome: OpsOutcome;
}

const inRange = (at: number, from: number | null, to: number) => (from === null || at >= from) && at < to;
const byTimeThenId = (a: MessageFact, b: MessageFact) =>
    a.at - b.at || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
const shareOf = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const distinct = <T>(list: Iterable<T>) => new Set(list).size;
const maxText = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);

function groupBy<T, K>(list: Iterable<T>, key: (item: T) => K) {
    const groups = new Map<K, T[]>();
    for (const item of list) {
        const k = key(item);
        let group = groups.get(k);
        if (!group) {
            groups.set(k, (group = []));
        }
        group.push(item);
    }
    return groups;
}

/** Newest first by (key, id), after the cursor, one more than a page. */
function page<T>(list: T[], key: (row: T) => [number, string], { cursor, limit }: OpsPageRequest): OpsPage<T> {
    if (cursor && typeof cursor.key !== 'number') {
        return { items: [], next: null };
    }
    const sorted = list
        .map((row) => ({ row, at: { key: key(row)[0], id: key(row)[1] } }))
        .filter(({ at }) => afterCursor(at, cursor as OpsCursor | undefined))
        .sort((a, b) =>
            b.at.key !== a.at.key
                ? (b.at.key as number) - (a.at.key as number)
                : b.at.id < a.at.id
                  ? -1
                  : b.at.id > a.at.id
                    ? 1
                    : 0,
        );
    const items = sorted.slice(0, limit);
    return {
        items: items.map(({ row }) => row),
        next: sorted.length > limit ? items.at(-1)!.at : null,
    };
}

/**
 * Activity and Value from facts in memory (CB-190), by the same
 * definitions as the DuckDB queries (`infra/duckdb/activity.ts`): what
 * their tests compare with.
 */
export class MemoryActivity {
    private readonly turnsByRun: Map<string, TurnFact>;
    private readonly socioSpace: Map<string, string>;
    private readonly socioName: Map<string, string>;
    private readonly sorted: MessageFact[];

    constructor(
        private readonly turns: readonly TurnFact[],
        private readonly messages: readonly MessageFact[],
        private readonly facts: ActivityFacts,
        private readonly earliest: () => number | null,
    ) {
        this.turnsByRun = new Map(turns.map((turn) => [turn.runId, turn]));
        this.socioSpace = new Map();
        this.socioName = new Map();
        for (const turn of turns) {
            if (turn.spaceId) {
                this.socioSpace.set(turn.socioId, turn.spaceId);
            }
            if (turn.socioName) {
                this.socioName.set(turn.socioId, turn.socioName);
            }
        }
        for (const socio of facts.socios ?? []) {
            this.socioSpace.set(socio.id, socio.spaceId);
            this.socioName.set(socio.id, socio.name);
        }
        this.sorted = [...messages].sort(
            (a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0) || byTimeThenId(a, b),
        );
    }

    private spaceOf(socioId: string | null | undefined) {
        return socioId ? this.socioSpace.get(socioId) : undefined;
    }

    /** Messages (anyone's) in the window, by the socio, Space and source filters. */
    private chatMessages(from: number | null, to: number, filters: OpsFilters) {
        return this.messages.filter(
            (m) =>
                inRange(m.at, from, to) &&
                (!filters.socio || m.socioId === filters.socio) &&
                (!filters.space || this.spaceOf(m.socioId) === filters.space) &&
                (!filters.source || m.source === filters.source),
        );
    }

    /** People's messages, any source; the person filter is the author. */
    private personMessages(from: number | null, to: number, filters: OpsFilters) {
        return this.chatMessages(from, to, filters).filter(
            (m) => m.authorKind === 'person' && (!filters.person || m.authorId === filters.person),
        );
    }

    /** People's messages from `human` sources. */
    private humanMessages(from: number | null, to: number, filters: OpsFilters) {
        return this.personMessages(from, to, filters).filter((m) => runSource(m.source).kind === 'human');
    }

    /** Turns in the window; the person filter is who started them. */
    private turnsIn(from: number | null, to: number, filters: OpsFilters) {
        return this.turns.filter(
            (t) =>
                inRange(t.startedAt, from, to) &&
                (!filters.socio || t.socioId === filters.socio) &&
                (!filters.space || this.spaceOf(t.socioId) === filters.space) &&
                (!filters.source || t.source === filters.source) &&
                (!filters.person || t.personId === filters.person),
        );
    }

    private toolsIn(from: number | null, to: number, filters: OpsFilters) {
        return (this.facts.tools ?? []).filter(
            (t) =>
                inRange(t.startedAt, from, to) &&
                (!filters.socio || t.socioId === filters.socio) &&
                (!filters.space || this.spaceOf(t.socioId) === filters.space) &&
                (!filters.source || t.source === filters.source) &&
                (!filters.person || t.personId === filters.person),
        );
    }

    /** The chats whose turns came from `source`. */
    private threadsOf(source: string) {
        return new Set(this.turns.filter((t) => t.source === source).map((t) => t.threadId));
    }

    /** Every chat's sessions, from all its messages, with their outcomes. */
    private sessions(from: number | null, to: number, gapMs: number, filters: OpsFilters): Session[] {
        const all: Session[] = [];
        for (const list of groupBy(this.sorted, (m) => m.threadId).values()) {
            const chat: Session[] = [];
            let current: Session | undefined;
            let last: MessageFact | undefined;
            for (const m of list) {
                if (!current || !last || m.at - last.at >= gapMs) {
                    current = {
                        id: `${m.threadId}@${m.at}`,
                        threadId: m.threadId,
                        socioId: null,
                        source: m.source,
                        startedAt: m.at,
                        endedAt: m.at,
                        messages: 0,
                        people: new Set(),
                        socios: new Set(),
                        human: false,
                        lastRun: undefined,
                        nextAt: null,
                        outcome: 'answered',
                    };
                    chat.push(current);
                }
                current.endedAt = m.at;
                current.messages++;
                current.socioId = maxText(current.socioId, m.socioId ?? null);
                if (m.authorKind === 'person' && m.authorId) {
                    current.people.add(m.authorId);
                }
                if (m.authorKind === 'socio' && m.authorId) {
                    current.socios.add(m.authorId);
                }
                if (m.authorKind === 'person' && runSource(m.source).kind === 'human') {
                    current.human = true;
                }
                current.lastRun = m.runId;
                last = m;
            }
            for (const [index, session] of chat.entries()) {
                session.nextAt = chat[index + 1]?.startedAt ?? null;
            }
            all.push(...chat);
        }
        return all
            .filter(
                (s) =>
                    s.human &&
                    inRange(s.startedAt, from, to) &&
                    (!filters.socio || s.socioId === filters.socio) &&
                    (!filters.space || this.spaceOf(s.socioId) === filters.space) &&
                    (!filters.source || s.source === filters.source) &&
                    (!filters.person || s.people.has(filters.person)),
            )
            .map((s) => ({ ...s, outcome: this.outcome(s) }));
    }

    /** The design's outcome rules (CB-164), as the DuckDB query has them. */
    private outcome(s: Session): OpsOutcome {
        const during = (at: number) => at >= s.startedAt && at <= s.endedAt + OPS_OUTCOME_WINDOW_MS;
        const turn = s.lastRun ? this.turnsByRun.get(s.lastRun) : undefined;
        const reactions = (this.facts.reactions ?? []).filter((r) => r.threadId === s.threadId && during(r.at));
        const approvals = (this.facts.approvals ?? []).filter((a) => a.threadId === s.threadId && during(a.at));
        const lastReaction = [...reactions].sort(
            (a, b) =>
                b.at - a.at || cmp(b.messageId, a.messageId) || cmp(b.personId, a.personId) || cmp(b.kind, a.kind),
        )[0];
        const silent = s.nextAt === null || s.nextAt > s.endedAt + OPS_OUTCOME_WINDOW_MS;
        if (
            silent &&
            ((turn && ['failed', 'interrupted', 'stopped'].includes(turn.status)) ||
                approvals.some((a) => a.event === 'expired') ||
                (lastReaction && ['down', 'retry', 'needs-work'].includes(lastReaction.kind)))
        ) {
            return 'abandoned';
        }
        const signal =
            reactions.some((r) => r.kind === 'up') ||
            approvals.some((a) => a.event === 'executed') ||
            (this.facts.spaceWrites ?? []).some((w) =>
                w.threadId === s.threadId
                    ? w.authorKind === 'socio' && during(w.at)
                    : w.threadId === null &&
                      w.authorKind === 'socio' &&
                      w.authorId === s.socioId &&
                      w.at >= s.startedAt &&
                      w.at <= s.endedAt,
            ) ||
            (this.facts.memories ?? []).some(
                (g) =>
                    g.threadId === s.threadId &&
                    g.status === 'active' &&
                    (g.deletedAt ?? null) === null &&
                    during(g.at),
            );
        if (turn?.status === 'finished' && (turn.endReason ?? 'completed') === 'completed' && signal) {
            return 'completed';
        }
        return 'answered';
    }

    private dayOf(at: number, timeZone: string) {
        return bucketStart(at, 'day', timeZone);
    }

    private startOf(scope: OpsScope) {
        return scope.window.from ?? this.earliest();
    }

    private activityTiles(
        scope: OpsScope,
        gapMs: number,
        from: number,
        to: number,
        before: { from: number; to: number } | null,
    ): Record<OpsActivityTileId, number | null> {
        const { filters, window } = scope;
        const now = this.humanMessages(from, to, filters);
        const people = new Set(now.map((m) => m.authorId));
        const sessions = this.sessions(from, to, gapMs, filters);
        const messages = sessions.reduce((sum, s) => sum + s.messages, 0);
        const active = new Map<number, Set<string>>();
        for (const m of this.humanMessages(from - 8 * DAY, to, filters)) {
            const day = this.dayOf(m.at, window.timeZone);
            let set = active.get(day);
            if (!set) {
                active.set(day, (set = new Set()));
            }
            set.add(m.authorId);
        }
        let dau = 0;
        let wau = 0;
        for (const day of bucketStarts(from, to, 'day', window.timeZone)) {
            dau += active.get(day)?.size ?? 0;
            const week = new Set<string>();
            for (const [key, set] of active) {
                if (key <= day && key > day - (7 * DAY - 2 * HOUR)) {
                    for (const p of set) {
                        week.add(p);
                    }
                }
            }
            wau += week.size;
        }
        let returning: number | null = null;
        if (before) {
            const earlier = new Set(this.humanMessages(before.from, before.to, filters).map((m) => m.authorId));
            returning = [...people].filter((p) => earlier.has(p)).length;
        }
        return {
            people: people.size,
            returning,
            stickiness: shareOf(dau, wau),
            sessions: sessions.length,
            chats: distinct(now.map((m) => m.threadId)),
            length: shareOf(messages, sessions.length),
        };
    }

    activity(scope: OpsScope, options: OpsSessionOptions & { capabilities: OpsToolCapability[] }): OpsActivityFacts {
        const { window, filters } = scope;
        const from = this.startOf(scope);
        const gapMs = options.sessionGapMinutes * 60_000;
        if (from === null) {
            return {
                tiles: OPS_ACTIVITY_TILES.map((id) => ({
                    id,
                    value: null,
                    previous: null,
                })),
                points: [],
                sources: [],
                participation: {
                    chats: 0,
                    withSeveralPeople: 0,
                    withSeveralSocios: 0,
                    collaboration: 0,
                },
                features: [],
                spaces: [],
            };
        }
        const { to, previous } = window;
        const now = this.activityTiles(scope, gapMs, from, to, previous);
        const before = previous
            ? this.activityTiles(scope, gapMs, previous.from, previous.to, {
                  from: previous.from - (to - from),
                  to: previous.from,
              })
            : undefined;
        const tiles = OPS_ACTIVITY_TILES.map((id) => ({
            id,
            value: now[id],
            previous: before ? before[id] : null,
        }));

        const key = (at: number) => bucketStart(at, window.bucket, window.timeZone);
        const human = this.humanMessages(from, to, filters);
        const sessions = this.sessions(from, to, gapMs, filters);
        const points = bucketStarts(from, to, window.bucket, window.timeZone).map((at) => {
            const here = human.filter((m) => key(m.at) === at);
            return {
                at,
                people: distinct(here.map((m) => m.authorId)),
                sessions: sessions.filter((s) => key(s.startedAt) === at).length,
                messages: here.length,
            };
        });

        const turns = this.turnsIn(from, to, filters);
        const people = this.personMessages(from, to, filters);
        const keys = new Set([...turns.map((t) => t.source), ...people.map((m) => m.source)]);
        const sources = [...keys]
            .map((key): OpsSourceUse => {
                const entry = runSource(key);
                const said = people.filter((m) => m.source === key);
                return {
                    key,
                    label: entry.label,
                    kind: entry.kind,
                    turns: turns.filter((t) => t.source === key).length,
                    messages: said.length,
                    people: distinct(said.map((m) => m.authorId)),
                };
            })
            .sort((a, b) => b.turns - a.turns || b.messages - a.messages || cmp(a.key, b.key));

        const chatsPeople = groupBy(human, (m) => m.threadId);
        const chatSocios = groupBy(
            this.chatMessages(from, to, filters).filter((m) => m.authorKind === 'socio'),
            (m) => m.threadId,
        );
        const participation = {
            chats: chatsPeople.size,
            withSeveralPeople: [...chatsPeople.values()].filter((list) => distinct(list.map((m) => m.authorId)) >= 2)
                .length,
            withSeveralSocios: [...chatsPeople.keys()].filter(
                (thread) => distinct((chatSocios.get(thread) ?? []).map((m) => m.authorId)) >= 2,
            ).length,
            collaboration: turns.filter((t) => t.triggerKind === 'socio' && t.triggerId !== t.socioId).length,
        };

        const capabilityOf = new Map<string, string>();
        for (const { tool, capability } of options.capabilities) {
            const known = capabilityOf.get(tool);
            if (known === undefined || capability < known) {
                capabilityOf.set(tool, capability);
            }
        }
        const features = [
            ...groupBy(this.toolsIn(from, to, filters), (t) => capabilityOf.get(t.tool) ?? `tool:${t.tool}`),
        ]
            .map(([id, calls]) => ({
                id,
                tools: [...new Set(calls.map((t) => t.tool))].sort(cmp),
                calls: calls.length,
                people: distinct(calls.flatMap((t) => (t.personId ? [t.personId] : []))),
                socios: distinct(calls.flatMap((t) => (t.socioId ? [t.socioId] : []))),
                errors: calls.filter((t) => ['error', 'timeout'].includes(t.outcome)).length,
                refusals: calls.filter((t) => t.outcome === 'refused').length,
            }))
            .sort((a, b) => b.calls - a.calls || cmp(a.id, b.id));

        const threads = filters.source ? this.threadsOf(filters.source) : undefined;
        const writes = (this.facts.spaceWrites ?? []).filter(
            (w) =>
                inRange(w.at, from, to) &&
                (!filters.space || w.spaceId === filters.space) &&
                (!filters.socio || (w.authorKind === 'socio' && w.authorId === filters.socio)) &&
                (!filters.person || (w.authorKind === 'person' && w.authorId === filters.person)) &&
                (!threads || (w.threadId !== null && threads.has(w.threadId))),
        );
        const spaceIds = new Set([
            ...writes.map((w) => w.spaceId),
            ...human.flatMap((m) => {
                const space = this.spaceOf(m.socioId);
                return space ? [space] : [];
            }),
            ...turns.flatMap((t) => {
                const space = this.spaceOf(t.socioId);
                return space ? [space] : [];
            }),
        ]);
        const spaceName = new Map((this.facts.spaces ?? []).map((space) => [space.id, space.name]));
        const spaces = [...spaceIds]
            .map((spaceId): OpsSpaceUse => {
                const here = writes.filter((w) => w.spaceId === spaceId);
                const spaceTurns = turns.filter((t) => this.spaceOf(t.socioId) === spaceId);
                return {
                    spaceId,
                    name: spaceName.get(spaceId) ?? null,
                    writesByPeople: here.filter((w) => w.authorKind === 'person').length,
                    writesBySocios: here.filter((w) => w.authorKind === 'socio').length,
                    pages: distinct(here.map((w) => w.pageId)),
                    people: distinct(human.filter((m) => this.spaceOf(m.socioId) === spaceId).map((m) => m.authorId)),
                    socios: distinct(spaceTurns.map((t) => t.socioId)),
                    turns: spaceTurns.length,
                };
            })
            .sort(
                (a, b) =>
                    b.writesByPeople + b.writesBySocios - (a.writesByPeople + a.writesBySocios) ||
                    b.turns - a.turns ||
                    cmp(a.spaceId, b.spaceId),
            );
        return { tiles, points, sources, participation, features, spaces };
    }

    private valueTiles(
        scope: OpsScope,
        gapMs: number,
        from: number,
        to: number,
    ): Record<OpsValueTileId, number | null> {
        const sessions = this.sessions(from, to, gapMs, scope.filters);
        const count = (outcome: OpsOutcome) => sessions.filter((s) => s.outcome === outcome).length;
        const days = [...groupBy(this.humanMessages(from, to, scope.filters), (m) => m.threadId).values()].map((list) =>
            distinct(list.map((m) => this.dayOf(m.at, scope.window.timeZone))),
        );
        return {
            completed: count('completed'),
            answered: count('answered'),
            abandoned: count('abandoned'),
            completedShare: shareOf(count('completed'), sessions.length),
            resumption: shareOf(days.filter((n) => n >= 2).length, days.length),
        };
    }

    value(scope: OpsScope, options: OpsSessionOptions): OpsValueFacts {
        const { window, filters } = scope;
        const from = this.startOf(scope);
        const gapMs = options.sessionGapMinutes * 60_000;
        if (from === null) {
            return {
                tiles: OPS_VALUE_TILES.map((id) => ({
                    id,
                    value: null,
                    previous: null,
                })),
                points: [],
                approvals: [],
                reactions: {
                    socioMessages: 0,
                    reacted: 0,
                    up: 0,
                    down: 0,
                    retry: 0,
                    needsWork: 0,
                },
                intents: [],
            };
        }
        const { to, previous } = window;
        const now = this.valueTiles(scope, gapMs, from, to);
        const before = previous ? this.valueTiles(scope, gapMs, previous.from, previous.to) : undefined;
        const tiles = OPS_VALUE_TILES.map((id) => ({
            id,
            value: now[id],
            previous: before ? before[id] : null,
        }));
        const key = (at: number) => bucketStart(at, window.bucket, window.timeZone);
        const sessions = this.sessions(from, to, gapMs, filters);
        const points = bucketStarts(from, to, window.bucket, window.timeZone).map((at) => {
            const here = sessions.filter((s) => key(s.startedAt) === at);
            const n = (outcome: OpsOutcome) => here.filter((s) => s.outcome === outcome).length;
            return {
                at,
                completed: n('completed'),
                answered: n('answered'),
                abandoned: n('abandoned'),
            };
        });

        const threads = filters.source ? this.threadsOf(filters.source) : undefined;
        const events = (this.facts.approvals ?? []).filter(
            (a) =>
                inRange(a.at, from, to) &&
                FUNNEL.has(a.event) &&
                (!filters.socio || a.socioId === filters.socio) &&
                (!filters.space || this.spaceOf(a.socioId) === filters.space) &&
                (!filters.person || a.personId === filters.person) &&
                (!threads || (a.threadId !== null && threads.has(a.threadId))),
        );
        const approvals = [...groupBy(events, (a) => a.capability)]
            .map(([capability, list]) => {
                const n = (...kinds: string[]) => list.filter((a) => kinds.includes(a.event)).length;
                return {
                    capability,
                    requested: n('requested'),
                    approved: n('approved', 'auto_approved', 'bypassed'),
                    denied: n('denied', 'auto_denied'),
                    expired: n('expired'),
                    executed: n('executed'),
                    failed: n('failed'),
                };
            })
            .sort((a, b) => b.requested - a.requested || cmp(a.capability, b.capability));

        const socioMessages = this.chatMessages(from, to, filters).filter(
            (m) =>
                m.authorKind === 'socio' &&
                (!filters.person ||
                    (m.runId !== undefined && this.turnsByRun.get(m.runId)?.personId === filters.person)),
        );
        const wanted = new Set(socioMessages.map((m) => `${m.threadId}\u0000${m.messageId}`));
        const rx = (this.facts.reactions ?? []).filter((r) => wanted.has(`${r.threadId}\u0000${r.messageId}`));
        const kind = (k: string) => rx.filter((r) => r.kind === k).length;
        return {
            tiles,
            points,
            approvals,
            reactions: {
                socioMessages: socioMessages.length,
                reacted: distinct(rx.map((r) => `${r.threadId}\u0000${r.messageId}`)),
                up: kind('up'),
                down: kind('down'),
                retry: kind('retry'),
                needsWork: kind('needs-work'),
            },
            intents: intentRows(this.labelledSessions(sessions)),
        };
    }

    /**
     * Sessions with the intent and themes of their earliest labeled turn
     * (CB-199), as `themes/duckdb.ts labelledSessions` gives them: a turn
     * is in a session when one of its messages is.
     */
    labelledSessions(sessions: readonly Session[]): OpsLabelledSession[] {
        const intents = new Map((this.facts.intents ?? []).map((fact) => [fact.runId, fact.intent]));
        const themes = groupBy(this.facts.themes ?? [], (fact) => fact.runId);
        const byThread = groupBy(this.sorted, (m) => m.threadId);
        return [...sessions]
            .sort((a, b) => a.startedAt - b.startedAt || cmp(a.id, b.id))
            .map((s) => {
                const inside = (byThread.get(s.threadId) ?? []).filter(
                    (m) => m.at >= s.startedAt && m.at <= s.endedAt && m.runId,
                );
                const intent = inside.find((m) => intents.has(m.runId!));
                const themed = inside.find((m) => themes.has(m.runId!));
                const topics = themed
                    ? themes
                          .get(themed.runId!)!
                          .map((fact) => ({ topic: fact.topic, key: topicKey(fact.topic) }))
                          .filter((topic) => topic.key)
                          .sort((a, b) => cmp(a.topic, b.topic))
                    : [];
                return {
                    id: s.id,
                    startedAt: s.startedAt,
                    outcome: s.outcome,
                    people: [...s.people],
                    intent: intent ? intents.get(intent.runId!)! : null,
                    topics,
                    hint: themed ? themes.get(themed.runId!)![0]!.outcome : null,
                };
            });
    }

    /** Themes (CB-199): the window's labeled sessions, aggregated. */
    themes(scope: OpsScope, options: OpsSessionOptions) {
        const from = this.startOf(scope);
        const { to, timeZone } = scope.window;
        if (from === null) {
            return aggregateThemes([], { from: to, to, timeZone });
        }
        const sessions = this.sessions(from, to, options.sessionGapMinutes * 60_000, scope.filters);
        return aggregateThemes(this.labelledSessions(sessions), {
            from,
            to,
            timeZone,
        });
    }

    activityPeople(scope: OpsScope, options: OpsSessionOptions, request: OpsPageRequest): OpsPage<OpsPersonRow> {
        const from = this.startOf(scope);
        if (from === null) {
            return { items: [], next: null };
        }
        const { to, timeZone } = scope.window;
        const sessions = this.sessions(from, to, options.sessionGapMinutes * 60_000, scope.filters);
        const tools = this.toolsIn(from, to, scope.filters);
        const names = new Map((this.facts.people ?? []).map((person) => [person.id, person.name]));
        const rows = [...groupBy(this.humanMessages(from, to, scope.filters), (m) => m.authorId)].map(
            ([personId, list]): OpsPersonRow => {
                const theirs = sessions.filter((s) => s.people.has(personId));
                return {
                    personId,
                    name: names.get(personId) ?? null,
                    messages: list.length,
                    sessions: theirs.length,
                    chats: distinct(list.map((m) => m.threadId)),
                    socios: distinct(list.flatMap((m) => (m.socioId ? [m.socioId] : []))),
                    activeDays: distinct(list.map((m) => this.dayOf(m.at, timeZone))),
                    toolCalls: tools.filter((t) => t.personId === personId).length,
                    completed: theirs.filter((s) => s.outcome === 'completed').length,
                    lastAt: Math.max(...list.map((m) => m.at)),
                };
            },
        );
        return page(rows, (row) => [row.lastAt, row.personId], request);
    }

    activitySocios(scope: OpsScope, options: OpsSessionOptions, request: OpsPageRequest): OpsPage<OpsSocioRow> {
        const from = this.startOf(scope);
        if (from === null) {
            return { items: [], next: null };
        }
        const { filters } = scope;
        const { to, timeZone } = scope.window;
        const gapMs = options.sessionGapMinutes * 60_000;
        const sessions = this.sessions(from, to, gapMs, filters);
        const later = this.sessions(from, to + OPS_RETURN_DAYS * DAY + DAY, gapMs, {});
        const turns = this.turnsIn(from, to, filters);
        const recent = this.humanMessages(to - OPS_REPEAT_DAYS * DAY, to, filters);
        const rows = [
            ...groupBy(
                this.humanMessages(from, to, filters).filter((m) => m.socioId),
                (m) => m.socioId,
            ),
        ].map(([socioId, list]): OpsSocioRow => {
            const theirs = sessions.filter((s) => s.socioId === socioId);
            const chats = distinct(theirs.map((s) => s.threadId));
            const said = theirs.reduce((sum, s) => sum + s.messages, 0);
            const days = [
                ...groupBy(
                    recent.filter((m) => m.socioId === socioId),
                    (m) => m.authorId,
                ).values(),
            ].map((ms) => distinct(ms.map((m) => this.dayOf(m.at, timeZone))));
            const visits = new Map<string, boolean>();
            for (const s of theirs) {
                for (const person of s.people) {
                    const back = later.some(
                        (b) =>
                            b.socioId === socioId &&
                            b.people.has(person) &&
                            b.startedAt > s.endedAt &&
                            b.startedAt <= s.endedAt + OPS_RETURN_DAYS * DAY,
                    );
                    visits.set(person, (visits.get(person) ?? false) || back);
                }
            }
            const own = turns.filter((t) => t.socioId === socioId);
            const n = (outcome: OpsOutcome) => theirs.filter((s) => s.outcome === outcome).length;
            return {
                socioId,
                name: this.socioName.get(socioId) ?? null,
                people: distinct(list.map((m) => m.authorId)),
                sessions: theirs.length,
                chats: distinct(list.map((m) => m.threadId)),
                messages: list.length,
                turns: own.length,
                perChat: chats ? said / chats : 0,
                repeatUse: shareOf(days.filter((d) => d >= 2).length, days.length),
                collaboration: own.filter((t) => t.triggerKind === 'socio' && t.triggerId !== t.socioId).length,
                completed: n('completed'),
                answered: n('answered'),
                abandoned: n('abandoned'),
                returnRate: shareOf([...visits.values()].filter(Boolean).length, visits.size),
                lastAt: Math.max(...list.map((m) => m.at)),
            };
        });
        return page(rows, (row) => [row.lastAt, row.socioId], request);
    }

    activityChats(scope: OpsScope, options: OpsSessionOptions, request: OpsPageRequest): OpsPage<OpsChatRow> {
        const from = this.startOf(scope);
        if (from === null) {
            return { items: [], next: null };
        }
        const { filters } = scope;
        const { to, timeZone } = scope.window;
        const sessions = this.sessions(from, to, options.sessionGapMinutes * 60_000, filters);
        const all = groupBy(this.chatMessages(from, to, filters), (m) => m.threadId);
        const chats = new Map((this.facts.chats ?? []).map((chat) => [chat.id, chat]));
        const rows: OpsChatRow[] = [];
        for (const [threadId, list] of groupBy(
            this.humanMessages(from, to, { ...filters, person: undefined }),
            (m) => m.threadId,
        )) {
            if (filters.person && !list.some((m) => m.authorId === filters.person)) {
                continue;
            }
            const everyone = all.get(threadId);
            if (!everyone) {
                continue;
            }
            const chat = chats.get(threadId);
            const socioId =
                chat?.socioId ?? everyone.reduce<string | null>((top, m) => maxText(top, m.socioId ?? null), null);
            const activeDays = distinct(list.map((m) => this.dayOf(m.at, timeZone)));
            rows.push({
                threadId,
                socioId,
                socioName: socioId ? (this.socioName.get(socioId) ?? null) : null,
                ownerKind: chat?.ownerKind ?? null,
                people: distinct(list.map((m) => m.authorId)),
                socios: distinct(everyone.filter((m) => m.authorKind === 'socio').map((m) => m.authorId)),
                messages: everyone.length,
                sessions: sessions.filter((s) => s.threadId === threadId).length,
                activeDays,
                resumed: activeDays >= 2,
                lastAt: Math.max(...everyone.map((m) => m.at)),
            });
        }
        return page(rows, (row) => [row.lastAt, row.threadId], request);
    }

    activitySessions(scope: OpsScope, options: OpsSessionOptions, request: OpsPageRequest): OpsPage<OpsSessionRow> {
        const from = this.startOf(scope);
        if (from === null) {
            return { items: [], next: null };
        }
        const rows = this.sessions(from, scope.window.to, options.sessionGapMinutes * 60_000, scope.filters)
            .filter((s) => !options.outcome || s.outcome === options.outcome)
            .map((s): OpsSessionRow => ({
                id: s.id,
                threadId: s.threadId,
                socioId: s.socioId,
                socioName: s.socioId ? (this.socioName.get(s.socioId) ?? null) : null,
                source: s.source,
                startedAt: s.startedAt,
                endedAt: s.endedAt,
                messages: s.messages,
                people: s.people.size,
                socios: s.socios.size,
                outcome: s.outcome,
            }));
        return page(rows, (row) => [row.startedAt, row.id], request);
    }
}

const FUNNEL = new Set([
    'requested',
    'approved',
    'auto_approved',
    'bypassed',
    'denied',
    'auto_denied',
    'expired',
    'executed',
    'failed',
]);

function cmp(a: string, b: string) {
    return a < b ? -1 : a > b ? 1 : 0;
}
