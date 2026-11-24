import { THEME_OUTCOMES, THEMES_MIN_PEOPLE, type ThemeOutcome } from '@socio/shared/classify';
import { compareText } from '@socio/shared/locale';
import { bucketStart, bucketStarts } from '@socio/shared/operations/operations';
import type { OpsOutcome } from '@socio/shared/operations/operations-activity';
import {
    OPS_THEMES_SHOWN,
    type OpsIntentRow,
    type OpsLabelledSession,
    type OpsThemeRow,
    type OpsThemesFacts,
} from '@socio/shared/operations/operations-themes';

/**
 * Themes' answer from people's sessions with their labels (CB-199): the
 * same code for the DuckDB reader and the one in memory, so both give
 * the same answer from the same sessions. Sessions are those that start
 * in the window (as Value counts them); each counts once per intent and
 * once per theme it has.
 */

const zeros = (): Record<OpsOutcome, number> => ({
    completed: 0,
    answered: 0,
    abandoned: 0,
});
const hintZeros = (): Record<ThemeOutcome, number> =>
    Object.fromEntries(THEME_OUTCOMES.map((hint) => [hint, 0])) as Record<ThemeOutcome, number>;

/** Sessions per intent, the most first; no intent last. */
export function intentRows(sessions: readonly OpsLabelledSession[]): OpsIntentRow[] {
    const rows = new Map<string | null, OpsIntentRow & { who: Set<string> }>();
    for (const session of sessions) {
        let row = rows.get(session.intent);
        if (!row) {
            rows.set(
                session.intent,
                (row = {
                    intent: session.intent,
                    sessions: 0,
                    people: 0,
                    ...zeros(),
                    who: new Set(),
                }),
            );
        }
        row.sessions++;
        row[session.outcome]++;
        for (const person of session.people) {
            row.who.add(person);
        }
    }
    return [...rows.values()]
        .map(({ who, ...row }) => ({ ...row, people: who.size }))
        .sort(
            (a, b) =>
                Number(a.intent === null) - Number(b.intent === null) ||
                b.sessions - a.sessions ||
                compareText(a.intent ?? '', b.intent ?? ''),
        );
}

export function aggregateThemes(
    sessions: readonly OpsLabelledSession[],
    {
        from,
        to,
        timeZone,
        minPeople = THEMES_MIN_PEOPLE,
    }: { from: number | null; to: number; timeZone: string; minPeople?: number },
): OpsThemesFacts {
    const first = from ?? sessions.reduce((lo, s) => Math.min(lo, s.startedAt), to);
    const weeks = first < to ? bucketStarts(first, to, 'week', timeZone) : [];
    const weekIndex = new Map(weeks.map((at, index) => [at, index]));
    const weekOf = (at: number) => weekIndex.get(bucketStart(at, 'week', timeZone)) ?? -1;
    const weekSessions = weeks.map(() => 0);

    interface Cluster {
        key: string;
        wordings: Map<string, number>;
        sessions: number;
        who: Set<string>;
        outcomes: Record<OpsOutcome, number>;
        hints: Record<ThemeOutcome, number>;
        weeks: number[];
        intents: Map<string | null, number>;
        ids: Set<string>;
    }
    const clusters = new Map<string, Cluster>();
    let withIntent = 0;
    let withThemes = 0;
    for (const session of sessions) {
        if (session.intent !== null) {
            withIntent++;
        }
        if (!session.topics.length) {
            continue;
        }
        withThemes++;
        const week = weekOf(session.startedAt);
        if (week >= 0) {
            weekSessions[week]!++;
        }
        const keys = new Set<string>();
        for (const { topic, key } of session.topics) {
            if (!key) {
                continue;
            }
            let cluster = clusters.get(key);
            if (!cluster) {
                clusters.set(
                    key,
                    (cluster = {
                        key,
                        wordings: new Map(),
                        sessions: 0,
                        who: new Set(),
                        outcomes: zeros(),
                        hints: hintZeros(),
                        weeks: weeks.map(() => 0),
                        intents: new Map(),
                        ids: new Set(),
                    }),
                );
            }
            cluster.wordings.set(topic, (cluster.wordings.get(topic) ?? 0) + 1);
            // A session with two wordings of one theme counts for it once.
            if (keys.has(key)) {
                continue;
            }
            keys.add(key);
            cluster.sessions++;
            cluster.ids.add(session.id);
            for (const person of session.people) {
                cluster.who.add(person);
            }
            cluster.outcomes[session.outcome]++;
            if (session.hint) {
                cluster.hints[session.hint]++;
            }
            if (week >= 0) {
                cluster.weeks[week]!++;
            }
            cluster.intents.set(session.intent, (cluster.intents.get(session.intent) ?? 0) + 1);
        }
    }

    const order = (a: Cluster, b: Cluster) =>
        b.sessions - a.sessions || b.who.size - a.who.size || compareText(a.key, b.key);
    const eligible = [...clusters.values()].filter((cluster) => cluster.who.size >= minPeople).sort(order);
    const shown = eligible.slice(0, OPS_THEMES_SHOWN);
    const named = new Set<string>();
    for (const cluster of shown) {
        for (const id of cluster.ids) {
            named.add(id);
        }
    }
    const hiddenSessions = sessions.filter((session) => session.topics.length && !named.has(session.id)).length;

    const themes: OpsThemeRow[] = shown.map((cluster) => {
        const [topic] = [...cluster.wordings].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0]!;
        return {
            key: cluster.key,
            topic,
            sessions: cluster.sessions,
            people: cluster.who.size,
            ...cluster.outcomes,
            hints: cluster.hints,
            weeks: cluster.weeks,
            intents: [...cluster.intents]
                .map(([intent, count]) => ({ intent, sessions: count }))
                .sort((a, b) => b.sessions - a.sessions || compareText(a.intent ?? '~', b.intent ?? '~')),
        };
    });
    return {
        sessions: sessions.length,
        withIntent,
        withThemes,
        minPeople,
        weeks,
        weekSessions,
        intents: intentRows(sessions),
        themes,
        hidden: {
            themes: clusters.size - eligible.length,
            sessions: hiddenSessions,
        },
        more: eligible.length - shown.length,
    };
}
