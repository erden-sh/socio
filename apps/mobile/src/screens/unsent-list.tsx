import { useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Alert, View } from 'react-native';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useUnsent, useWorkspaceScope } from '../live';
import { pageAction } from '../navigation/tabs';
import { SAVED_AS_NEW } from '../shell/page-conflict';
import { chatsQuery, spacesQuery } from '../shell/queries';
import {
    OPEN_PAGE,
    SAVE_AS_NEW_PAGE,
    shownUnsent,
    unsentBadge,
    type UnsentListRow,
    unsentListRows,
} from '../shell/unsent';
import { CONVERSATION_IDS, ISSUE_IDS } from '../sync/local-ids';
import { PAGE_IDS } from '../sync/page-save';
import { Button, Screen, Text } from '../ui';
import { cx } from '../ui/cx';

import { useSaveAsNewPage } from './page-conflict';
import { CountBadge } from './shell-parts';

// The account sheet's Unsent list: what the
// server refused, a chat gone or lost access included, each with Copy (what
// the person wrote, to the clipboard) and Discard (asks first; the outbox's
// `discardUnsent`). Nothing shows while the list is empty. The sheet holds
// the oldest two (it can't scroll inside; five pushed Sign out off the screen); past them "See all N unsent"
// opens the Unsent page, which lists every row. A page's writes say
// the page and its Space; a save whose page is gone offers Save as a new page
// (the Space picked as the conflict banner's is), and a conflict Open page,
// where its banner settles it.

interface UnsentRows {
    readonly rows: UnsentListRow[];
    readonly discard: (row: UnsentListRow) => void;
    readonly saveAsNew: (row: UnsentListRow) => void;
    /** The Space picker, drawn by the list. */
    readonly picker: ReactNode;
}

/** The rows, oldest first, Discard (asks first) and Save as a new page. */
function useUnsentRows(): UnsentRows {
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: chats } = useLiveQuery({ query: chatsQuery(collections) });
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    const { writes, groups } = useUnsent();
    const { saveMine, pickSpace, element: picker } = useSaveAsNewPage();
    const titles = new Map(chats.map((chat) => [chat.id, typeof chat.title === 'string' ? chat.title : null]));
    const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
    const rows = unsentListRows(writes, groups, {
        chatTitle: (id) => titles.get(id) ?? null,
        resolve: (id) => scope.outbox.resolve(CONVERSATION_IDS, id),
        issueNumber: (key) => scope.outbox.resolve(ISSUE_IDS, key),
        spaceName: (id) => spaceNames.get(id) ?? null,
        pageTitle: (spaceId, pageId) => scope.pages.summary(spaceId, pageId)?.title ?? null,
        pageId: (localId) => scope.outbox.resolve(PAGE_IDS, localId),
    });
    const saveAsNew = (row: UnsentListRow) => {
        const page = row.saveAsNew;
        if (page === null) {
            return;
        }
        pickSpace(page.spaceId, (target) => {
            saveMine({ id: row.id, mine: page.mine }, target)
                .then((localId) => {
                    if (localId !== null) {
                        AccessibilityInfo.announceForAccessibility(SAVED_AS_NEW);
                    }
                })
                .catch((error: unknown) => {
                    console.warn('[unsent] not saved as a new page', error);
                    Alert.alert('That didn’t work', 'What you wrote is still here. Try again.');
                });
        });
    };
    const discard = (row: UnsentListRow) => {
        Alert.alert(
            'Discard this?',
            row.text === null
                ? 'It won’t be sent.'
                : 'It won’t be sent, and what you wrote is gone. Copy it first to keep it.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Discard',
                    style: 'destructive',
                    onPress: () => {
                        scope.outbox
                            .discardUnsent(row.id)
                            .catch((error: unknown) => console.warn('[unsent] not discarded', error));
                    },
                },
            ],
            { cancelable: true },
        );
    };
    return { rows, discard, saveAsNew, picker };
}

/** The Account sheet's: the oldest `UNSENT_SHOWN`, then "See all N unsent" to the Unsent page. */
export function UnsentList() {
    const navigation = useNavigation();
    const { rows, discard, saveAsNew, picker } = useUnsentRows();
    if (rows.length === 0) {
        return null;
    }
    const label = unsentBadge(rows.length);
    const list = shownUnsent(rows);
    return (
        <View className="gap-2" testID="unsent-list">
            <View className="flex-row items-center gap-2">
                <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                    Unsent
                </Text>
                {label === null ? null : <CountBadge label={label} />}
            </View>
            {/* No ScrollView: inside the sheet sized to its content, iOS took it as the sheet's own. */}
            <UnsentRows
                rows={list.shown}
                onDiscard={discard}
                onSaveAsNew={saveAsNew}
                onOpen={(row) => {
                    // The sheet closes first: the page opens over the tabs, not inside the sheet.
                    navigation.goBack();
                    openPage((action) => navigation.dispatch(action), row);
                }}
                onEdit={(row) => {
                    // The sheet closes first: the form opens over the tabs, not inside the sheet.
                    navigation.goBack();
                    navigation.navigate('FileIssue', { edit: row.id });
                }}
            />
            {list.seeAll === null ? null : (
                <Button
                    variant="secondary"
                    label={list.seeAll}
                    icon="chevron-right"
                    onPress={() => {
                        // The sheet closes first: the page opens in the tab under it (shell-actions.ts).
                        navigation.goBack();
                        navigation.navigate('Unsent' as never);
                    }}
                    testID="unsent-see-all"
                />
            )}
            {picker}
        </View>
    );
}

/** The Unsent page: every row, each with Copy and Discard; the Screen's ScrollView is its root. */
export function UnsentScreen() {
    return (
        <Screen testID="unsent-screen" edges={['right', 'bottom', 'left']}>
            {useHasWorkspaceScope() ? <AllUnsent /> : null}
        </Screen>
    );
}

function AllUnsent() {
    const navigation = useNavigation();
    const { rows, discard, saveAsNew, picker } = useUnsentRows();
    return rows.length === 0 ? (
        <Text variant="subheadline" tone="muted">
            Nothing is waiting: every change was sent or discarded.
        </Text>
    ) : (
        <>
            <UnsentRows
                rows={rows}
                onDiscard={discard}
                onSaveAsNew={saveAsNew}
                onOpen={(row) => openPage((action) => navigation.dispatch(action), row)}
                onEdit={(row) => navigation.navigate('FileIssue', { edit: row.id })}
            />
            {picker}
        </>
    );
}

/** A conflict's page, under its banner. */
function openPage(dispatch: (action: ReturnType<typeof pageAction>) => void, row: UnsentListRow) {
    if (row.opens !== null) {
        dispatch(pageAction(row.opens.spaceId, row.opens.pageId));
    }
}

interface RowActions {
    readonly onDiscard: (row: UnsentListRow) => void;
    readonly onSaveAsNew: (row: UnsentListRow) => void;
    readonly onOpen: (row: UnsentListRow) => void;
    /** A refused filing's Edit: FileIssue on what was written. */
    readonly onEdit: (row: UnsentListRow) => void;
}

function UnsentRows({ rows, ...actions }: RowActions & { rows: readonly UnsentListRow[] }) {
    return (
        <View className="rounded-xl border border-border bg-card">
            {rows.map((row, index) => (
                <UnsentItem key={row.id} row={row} first={index === 0} {...actions} />
            ))}
        </View>
    );
}

function UnsentItem({
    row,
    first,
    onDiscard,
    onSaveAsNew,
    onOpen,
    onEdit,
}: RowActions & { row: UnsentListRow; first: boolean }) {
    const { text } = row;
    return (
        <View testID={`unsent-${row.id}`} className={cx('gap-2 p-3', !first && 'border-t border-border')}>
            <View accessible accessibilityLabel={row.accessibilityLabel} className="gap-1">
                <Text variant="footnote" tone="muted" numberOfLines={1}>
                    {`${row.what} · ${row.where}`}
                </Text>
                {text === null ? null : <Text numberOfLines={4}>{text}</Text>}
                <Text variant="footnote" tone="destructive">
                    {row.holding === null ? row.why : `${row.why} · ${row.holding}`}
                </Text>
            </View>
            <View className="-mr-4 -mb-3 flex-row flex-wrap justify-end">
                {row.opens === null ? null : (
                    <Button
                        variant="ghost"
                        label={OPEN_PAGE}
                        icon="file-text"
                        onPress={() => onOpen(row)}
                        testID={`unsent-open-${row.id}`}
                    />
                )}
                {row.editable ? (
                    <Button
                        variant="ghost"
                        label="Edit"
                        icon="pencil"
                        onPress={() => onEdit(row)}
                        testID={`unsent-edit-${row.id}`}
                    />
                ) : null}
                {row.saveAsNew === null ? null : (
                    <Button
                        variant="ghost"
                        label={SAVE_AS_NEW_PAGE}
                        icon="file-plus"
                        onPress={() => onSaveAsNew(row)}
                        testID={`unsent-save-new-${row.id}`}
                    />
                )}
                {text === null ? null : (
                    <Button
                        variant="ghost"
                        label="Copy"
                        icon="copy"
                        onPress={() => {
                            Clipboard.setStringAsync(text).catch((error: unknown) =>
                                console.warn('[unsent] not copied', error),
                            );
                        }}
                        testID={`unsent-copy-${row.id}`}
                    />
                )}
                <Button
                    variant="ghost"
                    label="Discard"
                    icon="trash-2"
                    onPress={() => onDiscard(row)}
                    testID={`unsent-discard-${row.id}`}
                />
            </View>
        </View>
    );
}
