import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, View } from 'react-native';

import { useSyncStatus, useWorkspaceScope } from '../live';
import { network } from '../platform/network';
import { DETAIL_GONE, DETAIL_OFFLINE, type DetailState, OPENS_IN_BROWSER, refreshesDetail } from '../shell/schedules';
import { type OnlineActionResult, type OnlineContext, onlineActionCopy } from '../sync/schedule-writes';
import { AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';

import { useOpenLink } from './open-link';

// The parts Scheduled & activity and Schedules share: a card, a fact's
// row, the "Opens in your browser" row, a detail's state lines and the
// online-only actions' runner (a schedule's Run now, a task's Pause and Cancel, Stop).

/** A card: the web's Card, its padding even on every side. */
export function Card(props: { children: ReactNode; testID?: string; dashed?: boolean }) {
    return (
        <View
            testID={props.testID}
            className={cx(
                'gap-3 rounded-xl border border-border bg-card p-4',
                props.dashed === true && 'border-dashed',
            )}
        >
            {props.children}
        </View>
    );
}

export function SectionTitle({ children }: { children: string }) {
    return (
        <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
            {children}
        </Text>
    );
}

/** One fact of "What it does": its label over its value, one element for screen readers. */
export function Fact(props: { label: string; value: string }) {
    return (
        <View accessible className="gap-0.5">
            <Text variant="footnote" tone="muted">
                {props.label}
            </Text>
            <Text>{props.value}</Text>
        </View>
    );
}

/** A row that opens a workspace page in the browser (useOpenLink's sign-in line the first time). */
export function WebRow(props: { label: string; href: string; testID: string }) {
    const openLink = useOpenLink();
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="link"
            accessibilityLabel={props.label}
            accessibilityHint={OPENS_IN_BROWSER}
            onPress={() => openLink(props.href, { web: true })}
            className="min-h-11 flex-row items-center gap-3 rounded-xl border border-border bg-card p-3 active:bg-accent"
        >
            <View className="min-w-0 flex-1">
                <Text>{props.label}</Text>
                <Text variant="footnote" tone="muted">
                    {OPENS_IN_BROWSER}
                </Text>
            </View>
            <AppSymbol name="external-link" size={16} color="muted-foreground" />
        </Pressable>
    );
}

/** What a detail with nothing to show says: loading, offline with no copy, or gone. */
export function DetailEmpty({ state, testID }: { state: DetailState; testID: string }) {
    if (state === 'ready') {
        return null;
    }
    const words = state === 'loading' ? 'Loading…' : state === 'gone' ? DETAIL_GONE : DETAIL_OFFLINE;
    return (
        <Text variant="subheadline" tone="muted" testID={`${testID}-${state}`}>
            {words}
        </Text>
    );
}

/** "Saved Nov 8, 3:45 PM" over a copy the last read couldn't refresh. */
export function Age({ age, testID }: { age: string | null; testID: string }) {
    return age === null ? null : (
        <Text variant="footnote" tone="muted" testID={testID}>
            {age}
        </Text>
    );
}

/** Whether a request can go now: NetInfo says connected and the server isn't away; null when unknown. */
export async function online(reconnecting: boolean): Promise<boolean | null> {
    if (reconnecting) {
        return false;
    }
    try {
        return (await network.current()).connected;
    } catch {
        return null;
    }
}

/**
 * Runs the schedules' and tasks' online-only actions: offline (or while "Reconnecting…") nothing
 * goes and the notice says "Needs a connection"; what came back is said once,
 * and a done action pulls what is in view and calls `after` (a detail's read).
 */
export function useOnlineAction(after?: () => void): {
    readonly run: (key: string, action: (context: OnlineContext) => Promise<OnlineActionResult>) => void;
    readonly busy: string | null;
    readonly notice: string | null;
} {
    const scope = useWorkspaceScope();
    const { reconnecting } = useSyncStatus();
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const run = (key: string, action: (context: OnlineContext) => Promise<OnlineActionResult>) => {
        setNotice(null);
        setBusy(key);
        void online(reconnecting)
            .then((connected) => action({ fetch: scope.fetch, connected, cache: scope.cache }))
            .then(
                (result) => {
                    const words = onlineActionCopy(result);
                    setNotice(words);
                    if (words !== null) {
                        AccessibilityInfo.announceForAccessibility(words);
                    }
                    if (result.outcome === 'done') {
                        scope.scheduler.poke();
                        after?.();
                    }
                },
                (error: unknown) => console.warn('[schedules] the action failed', error),
            )
            .finally(() => setBusy(null));
    };
    return { run, busy, notice };
}

export function Notice({ words, testID }: { words: string | null; testID: string }) {
    return words === null ? null : (
        <Text variant="footnote" tone="destructive" testID={testID}>
            {words}
        </Text>
    );
}

/** A status chip: its word always shows (never color alone, 10.1). */
export function StatusChip({ word, testID }: { word: string; testID?: string }) {
    return (
        <View className="self-start rounded-sm bg-secondary px-1.5" testID={testID}>
            <Text variant="footnote" tone="on-secondary">
                {word}
            </Text>
        </View>
    );
}

/**
 * Reads a detail again when its list row moves on (`signature`: its poll, a
 * write), never on a timer of its own and never on the open, which reads it
 * already (one GET per open, not two).
 */
export function useRefreshOnRowChange(signature: string, refresh: () => void): void {
    const seen = useRef(signature);
    const latest = useRef(refresh);
    useEffect(() => {
        latest.current = refresh;
    });
    useEffect(() => {
        const before = seen.current;
        seen.current = signature;
        if (refreshesDetail(before, signature)) {
            latest.current();
        }
    }, [signature]);
}
