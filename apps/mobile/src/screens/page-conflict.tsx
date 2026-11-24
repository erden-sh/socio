import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Pressable, View } from 'react-native';

import type { Page } from '@socio/shared/pages/page-library';

import { CANCEL, TOAST_MS } from '../chat/long-press';
import { useCollections, useLiveQuery, usePageConflicts, usePageMerged, useWorkspaceScope } from '../live';
import { randomId } from '../platform/crypto';
import {
    COMPARE,
    type CompareLine,
    compareSheet,
    conflictBanner,
    type DiffSheet as DiffSheetContent,
    KEEP_THEIRS,
    KEEP_THEIRS_CONFIRM,
    MERGED_TOAST,
    SAVE_AS_NEW,
    SAVE_AS_NEW_PICK,
    saveAsNewTargets,
    SAVED_AS_NEW,
    SEE_WHAT_CHANGED,
    USE_MINE,
    USE_MINE_CONFIRM,
    whatChangedSheet,
} from '../shell/page-conflict';
import { spacesQuery } from '../shell/queries';
import { keepTheirs, type PageConflict, saveMineAsNewPage, takeMine } from '../sync/page-conflicts';
import { Button, GlassSurface, AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';

import { type RouteSheetContent, useRouteSheet } from './route-sheet';

// The page's conflict banner and merge toast: over a
// page whose save didn't merge with changes made elsewhere, the web's page
// notice (its amber look is the app's warning surface), then Compare, Keep
// theirs, Use mine and Save mine as a new page. Use mine and Keep theirs ask
// first; Save mine as a new page picks the Space, the page's own first. The
// page under it shows theirs, as the phone now holds it. A clean merge says
// "Merged with changes made elsewhere" for a moment, with "See what changed":
// what the save sent against the merge (the owner's call). Compare and "See what
// changed" open one sheet, DiffSheet, with their own title, legend and rows
// (the owner's choice). The page editor shows the same banner over
// the page it edits.

/** The banner over page `pageId`, while it has a conflict. */
export function PageConflictBanner(props: {
    spaceId: string;
    pageId: string;
    /** The page as the phone holds it: Use mine re-bases on it. */
    current: Page | null;
    /** A short line for the screen's toast ("Saved your version as a new page"). */
    onNotice: (text: string) => void;
}) {
    const { spaceId, pageId, current, onNotice } = props;
    const scope = useWorkspaceScope();
    const banner = conflictBanner(usePageConflicts(pageId));
    const { saveMine, pickSpace, element: picker } = useSaveAsNewPage();
    const [comparing, setComparing] = useState<DiffSheetContent | null>(null);
    useRouteSheet(comparing === null ? null : diffSheet(comparing, () => setComparing(null)), () => setComparing(null));
    // One action at a time: a second tap while one goes does nothing (no second new page).
    const [busy, setBusy] = useState(false);
    const going = useRef(false);
    const heading = banner?.heading;
    useEffect(() => {
        if (heading !== undefined) {
            AccessibilityInfo.announceForAccessibility(heading);
        }
    }, [heading]);
    if (banner === null) {
        return null;
    }
    const { conflict } = banner;
    const failed = (error: unknown) => {
        console.warn('[pages] the conflict was not resolved', error);
        Alert.alert('That didn’t work', 'Your version is still safe on this phone. Try again.');
    };
    const run = (task: () => Promise<void>) => {
        if (going.current) {
            return;
        }
        going.current = true;
        setBusy(true);
        task()
            .catch(failed)
            .finally(() => {
                going.current = false;
                setBusy(false);
            });
    };
    const onUseMine = () =>
        Alert.alert(USE_MINE_CONFIRM.title, USE_MINE_CONFIRM.message, [
            { text: CANCEL, style: 'cancel' },
            {
                text: USE_MINE_CONFIRM.action,
                style: 'destructive',
                onPress: () =>
                    run(() =>
                        takeMine(conflict, {
                            outbox: scope.outbox,
                            newId: randomId,
                            current: current === null ? null : { ...current },
                            landed: scope.pageDrafts.landed,
                        }).then((done) => (done ? undefined : failed(new Error('Use mine found nothing to send.')))),
                    ),
            },
        ]);
    const onKeepTheirs = () =>
        Alert.alert(KEEP_THEIRS_CONFIRM.title, KEEP_THEIRS_CONFIRM.message, [
            { text: CANCEL, style: 'cancel' },
            {
                text: KEEP_THEIRS_CONFIRM.action,
                style: 'destructive',
                onPress: () => run(() => keepTheirs(scope.outbox, conflict).then(() => undefined)),
            },
        ]);
    const saveAsNew = (target: string) =>
        run(() =>
            saveMine(conflict, target).then((localId) => {
                if (localId !== null) {
                    onNotice(SAVED_AS_NEW);
                }
            }),
        );
    const onSaveAsNew = () => pickSpace(spaceId, saveAsNew);

    return (
        <View
            testID="page-conflict"
            className="gap-3 rounded-lg border border-paused-banner-border bg-paused-banner p-4"
        >
            <View className="flex-row gap-3" accessible>
                <AppSymbol name="triangle-alert" size={16} color="paused-banner-foreground" />
                <View className="flex-1 gap-1">
                    <Text weight="medium" accessibilityRole="header">
                        {banner.heading}
                    </Text>
                    <Text>{banner.line}</Text>
                </View>
            </View>
            <View className="flex-row flex-wrap gap-2">
                {banner.canCompare ? (
                    <Button
                        label={COMPARE}
                        variant="ghost"
                        onPress={() => setComparing(compareSheet(conflict))}
                        testID="page-conflict-compare"
                    />
                ) : null}
                <Button
                    label={KEEP_THEIRS}
                    variant="secondary"
                    onPress={onKeepTheirs}
                    disabled={busy}
                    testID="page-conflict-theirs"
                />
                <Button
                    label={USE_MINE}
                    variant="secondary"
                    onPress={onUseMine}
                    disabled={busy}
                    testID="page-conflict-mine"
                />
                <Button
                    label={SAVE_AS_NEW}
                    variant="secondary"
                    onPress={onSaveAsNew}
                    disabled={busy}
                    testID="page-conflict-new"
                />
            </View>
            {picker}
        </View>
    );
}

/**
 * Save as a new page (the conflict banner's, the Unsent list's): `pickSpace` asks
 * which Space when there is more than one, the page's own first; `saveMine`
 * queues the person's version there as a new page and discards the refused
 * write (`saveMineAsNewPage`: once per write, however often it is tapped).
 */
export function useSaveAsNewPage() {
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    const [picking, setPicking] = useState<{
        readonly targets: readonly { readonly id: string; readonly name: string }[];
        readonly onPick: (target: string) => void;
    } | null>(null);
    // Which Space, in a native sheet (CB-421), medium then large: a workspace can have many.
    useRouteSheet(
        picking === null
            ? null
            : {
                  testID: 'save-as-new-pick',
                  title: SAVE_AS_NEW_PICK,
                  tall: true,
                  body: (
                      <View className="rounded-xl border border-border bg-card">
                          {picking.targets.map((space, index) => (
                              <Pressable
                                  key={space.id}
                                  testID={`save-as-new-pick-${space.id}`}
                                  accessibilityRole="button"
                                  accessibilityLabel={space.name}
                                  onPress={() => {
                                      setPicking(null);
                                      picking.onPick(space.id);
                                  }}
                                  className={cx(
                                      'min-h-11 justify-center p-3 active:bg-accent',
                                      index > 0 && 'border-t border-border',
                                  )}
                              >
                                  <Text>{space.name}</Text>
                              </Pressable>
                          ))}
                      </View>
                  ),
              },
        () => setPicking(null),
    );
    const saveMine = (write: Pick<PageConflict, 'id' | 'mine'>, target: string) =>
        saveMineAsNewPage(write, {
            outbox: scope.outbox,
            newId: randomId,
            spaceId: target,
            createdBy: scope.workspace.appUserId,
            serverAt: scope.serverClock.lastDate(),
            known: scope.pages.space(target).collection.toArray.map((page) => page.id),
        });
    const pickSpace = (spaceId: string, onPick: (target: string) => void) => {
        const targets = saveAsNewTargets(spaces, spaceId);
        if (targets.length <= 1) {
            onPick(targets[0]?.id ?? spaceId);
            return;
        }
        setPicking({ targets, onPick });
    };
    return { saveMine, pickSpace, element: null };
}

const LINE_LOOK = {
    same: { box: '', tone: 'muted', sign: ' ' },
    removed: { box: 'bg-destructive/10', tone: 'default', sign: '−' },
    added: { box: 'bg-primary/10', tone: 'default', sign: '+' },
} as const;

/**
 * A read-only diff, line by line: − lines on a red tint, + lines on a green
 * one, each said with its side: DiffSheet's, for Compare (theirs against
 * yours) and the merge toast's "See what changed" (what was sent against the merge).
 */
function LineDiff({ rows, legend, testID }: { rows: readonly CompareLine[]; legend: string; testID: string }) {
    return (
        <View className="gap-1" testID={testID}>
            <Text variant="footnote" tone="muted">
                {legend}
            </Text>
            <View className="overflow-hidden rounded-md border border-border bg-card py-1">
                {rows.map((line) => {
                    const look = LINE_LOOK[line.kind];
                    return (
                        <View
                            key={line.key}
                            className={cx('flex-row gap-2 px-3 py-0.5', look.box)}
                            accessible
                            accessibilityLabel={line.label === null ? line.text : `${line.label}: ${line.text}`}
                        >
                            <Text variant="footnote" tone="muted" className="font-mono">
                                {look.sign}
                            </Text>
                            <Text variant="footnote" tone={look.tone} className="flex-1 font-mono">
                                {line.text === '' ? ' ' : line.text}
                            </Text>
                        </View>
                    );
                })}
            </View>
        </View>
    );
}

/**
 * The one diff sheet (CB-421: a native sheet, medium then large): a LineDiff under its title,
 * Done in its title row.
 */
function diffSheet(sheet: DiffSheetContent, onClose: () => void): RouteSheetContent {
    return {
        testID: sheet.testID,
        title: sheet.title,
        tall: true,
        actions: <Button label="Done" onPress={onClose} testID={`${sheet.testID}-done`} />,
        body: <LineDiff rows={sheet.rows} legend={sheet.legend} testID={`${sheet.testID}-lines`} />,
    };
}

/**
 * The page's toast: "Merged with changes made elsewhere" for a moment after a
 * clean merge of page `pageId`, with "See what changed", else the banner's `notice`.
 */
export function PageToasts({ pageId, notice, onHide }: { pageId: string; notice: string | null; onHide: () => void }) {
    const { merged, change, clear } = usePageMerged(pageId);
    const [viewing, setViewing] = useState<DiffSheetContent | null>(null);
    useRouteSheet(viewing === null ? null : diffSheet(viewing, () => setViewing(null)), () => setViewing(null));
    if (merged > 0) {
        return (
            <>
                <PageToast
                    text={MERGED_TOAST}
                    onHide={clear}
                    {...(change === null
                        ? {}
                        : {
                              action: {
                                  label: SEE_WHAT_CHANGED,
                                  onPress: () => {
                                      setViewing(whatChangedSheet(change));
                                      clear();
                                  },
                              },
                          })}
                />
            </>
        );
    }
    return <>{notice === null ? null : <PageToast text={notice} onHide={onHide} />}</>;
}

/** A line at the bottom of the screen for TOAST_MS, in GlassSurface, said as it shows; at most one action. */
function PageToast({
    text,
    onHide,
    action,
}: {
    text: string;
    onHide: () => void;
    action?: { label: string; onPress: () => void };
}) {
    useEffect(() => {
        AccessibilityInfo.announceForAccessibility(text);
        const timer = setTimeout(onHide, TOAST_MS);
        return () => clearTimeout(timer);
    }, [text, onHide]);
    return (
        <View pointerEvents="box-none" className="absolute right-0 bottom-0 left-0 p-4">
            <GlassSurface
                testID="page-toast"
                radius={16}
                fallbackClassName="border border-border bg-card"
                className={cx('flex-row items-center gap-3', action === undefined ? 'p-4' : 'p-3')}
            >
                <Text className="flex-1" accessibilityLiveRegion="polite">
                    {text}
                </Text>
                {action === undefined ? null : (
                    <Button
                        label={action.label}
                        variant="secondary"
                        onPress={action.onPress}
                        testID="page-toast-action"
                    />
                )}
            </GlassSurface>
        </View>
    );
}
