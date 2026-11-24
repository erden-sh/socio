import * as Clipboard from 'expo-clipboard';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { PAGE_TITLE_MAX } from '@socio/shared/pages/page-draft';
import type { PageSummary } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';

import { outboxStateStore } from '../chat/composer';
import { accessibilityActionsOf, CANCEL, DELETE, UNDO } from '../chat/long-press';
import { useCollections, useLiveQuery, useWorkspaceScope } from '../live';
import { randomId } from '../platform/crypto';
import { clearPickerCache, pick } from '../platform/pickers';
import {
    AT_TOP,
    COVER_REMOVED,
    deleteButton,
    deleteMessage,
    deleteRule,
    deleteTitle,
    knownPages,
    MOVE_TO,
    MOVE_UNDER,
    moveButton,
    moveLine,
    moveTargets,
    moveTitle,
    NEW_PAGE,
    NEW_PAGE_LABEL,
    NO_OTHER_SPACE,
    oneAtATime,
    pageMenu,
    pagesNotSaved,
    parentChoices,
    type PageNotSaved,
    type ShownPage,
    withPageWrites,
} from '../shell/page-menus';
import { pagesQuery, shellQuery, shellRows } from '../shell/queries';
import { overlaysOf } from '../sync/outbox-overlay';
import {
    createPage,
    deletePage,
    movePage,
    PAGE_MANAGE_VIEWS,
    PageWriteError,
    removePageCover,
    restorePageCover,
    setPageCover,
} from '../sync/page-manage';
import { PAGE_IDS, PAGE_SAVE_VIEWS } from '../sync/page-save';
import { FILE_UPLOAD_COPY, type FileUploads } from '../sync/upload-file';
import { Button, AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';

import { type MenuRequest, NotSavedNotice, TextPrompt, UndoToast } from './action-menu';
import { useRouteSheet } from './route-sheet';

// A Space's New page and page menus (view models in
// src/shell/page-menus.ts): the header's New page asks a title and queues
// the page's create, which shows at once; each row's long-press menu, also its
// accessibility actions, moves the page (a Space, then where in it), sets,
// changes or removes its cover ("Cover removed" with Undo) and deletes it
// after a native confirm in the web's words naming its subpages. Every write
// goes through the outbox (src/sync/page-manage.ts), laid over the rows at
// once; one the server refused says so with Retry, Copy (a new page's text)
// and Discard.

const PAGE_KINDS = [...PAGE_SAVE_VIEWS, ...PAGE_MANAGE_VIEWS];

/** The Space's pages with this phone's writes laid over, and the ones refused. */
export function usePageWrites(
    spaceId: string,
    pages: readonly PageSummary[],
): { shown: ShownPage[]; refused: PageNotSaved[] } {
    const { outbox } = useWorkspaceScope();
    const [store] = useState(() => outboxStateStore(outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const overlays = overlaysOf({ rows: writes.rows, unsent: writes.unsent, kinds: PAGE_KINDS, scope: outbox });
    const shown = withPageWrites(pages, overlays);
    const resolve = (id: string) => outbox.resolve(PAGE_IDS, id);
    return { shown, refused: pagesNotSaved(writes.unsent, shown, spaceId, resolve) };
}

/** The photo picker, then the Files upload's copy and upload (`cover`); null when nothing was picked. The pickers' files go after. */
async function pickCover(uploads: FileUploads) {
    try {
        const picked = await pick('photos', 1);
        const file = picked.kind === 'picked' ? picked.files[0] : undefined;
        return file === undefined ? null : await uploads.add(file, 'cover');
    } finally {
        clearPickerCache();
    }
}

type Toast = { readonly text: string; readonly undo?: () => void };

/** New page, each row's menu and actions, the move picker, the toasts and what was refused. */
export function usePageManage(
    spaceId: string,
    spaces: readonly Space[],
    shown: readonly ShownPage[],
    refused: readonly PageNotSaved[],
    /** The Space's pages as synced, without this phone's writes: New page's `known`. */
    synced: readonly PageSummary[],
) {
    const scope = useWorkspaceScope();
    const { outbox, uploads } = scope;
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const role = shellRows(shell).workspace?.user?.role;
    const user = { id: scope.workspace.appUserId, ...(role === undefined ? {} : { role }) };
    const [creating, setCreating] = useState(false);
    // Save and Return both send; a create that is still being queued drops the second.
    const [createOnce] = useState(oneAtATime);
    const [moving, setMoving] = useState<ShownPage | null>(null);
    const [toast, setToast] = useState<Toast | null>(null);
    const failed = (error: unknown) => {
        console.warn('[pages] the change was not queued', error);
        Alert.alert(error instanceof PageWriteError ? error.message : 'The change couldn’t be saved on this phone.');
    };
    const write = { outbox, newId: randomId, uploads, drafts: scope.drafts };

    const confirmDelete = (page: ShownPage, onDelete: () => void = () => {}) => {
        const rule = deleteRule(user, page, shown);
        if (!rule.allowed) {
            return;
        }
        Alert.alert(deleteTitle(page), deleteMessage(rule.subpages), [
            { text: CANCEL, style: 'cancel' },
            {
                text: deleteButton(rule.subpages.length),
                style: 'destructive',
                onPress: () => {
                    onDelete();
                    deletePage({
                        ...write,
                        spaceId,
                        pageId: page.id,
                        subpages: rule.subpages.map((item) => item.id),
                    }).catch(failed);
                },
            },
        ]);
    };

    const setCover = async (page: ShownPage) => {
        const added = await pickCover(uploads);
        if (added === null) {
            return;
        }
        if ('problem' in added) {
            Alert.alert(FILE_UPLOAD_COPY[added.problem]);
            return;
        }
        await setPageCover({ ...write, spaceId, pageId: page.id, current: page.cover, uploadId: added.upload.id });
        const note = uploads.takeSavedNote();
        if (note !== null) {
            setToast({ text: note });
        }
    };

    const removeCover = async (page: ShownPage) => {
        const previous = page.cover;
        await removePageCover({ ...write, spaceId, pageId: page.id, current: previous });
        setToast({
            text: COVER_REMOVED,
            ...(previous === null
                ? {}
                : {
                      undo: () => {
                          restorePageCover({
                              ...write,
                              spaceId,
                              pageId: page.id,
                              current: null,
                              embedId: previous.id,
                          }).catch(failed);
                      },
                  }),
        });
    };

    const act = (page: ShownPage, name: string) => {
        if (name === 'move') {
            setMoving(page);
        } else if (name === 'set-cover') {
            setCover(page).catch(failed);
        } else if (name === 'remove-cover') {
            removeCover(page).catch(failed);
        } else if (name === DELETE.name) {
            confirmDelete(page);
        }
    };
    const actionsOf = (page: ShownPage) => pageMenu(page, deleteRule(user, page, shown).allowed);

    // Move's picker in a native sheet (CB-421), medium then large: the Spaces and a tree can be long.
    useRouteSheet(
        moving === null
            ? null
            : {
                  testID: 'page-move',
                  title: moveTitle(moving),
                  tall: true,
                  body: (
                      <MoveSheet
                          key={moving.id}
                          subpages={deleteRule(null, moving, shown).subpages.length}
                          targets={moveTargets(spaces, spaceId)}
                          onCancel={() => setMoving(null)}
                          onMove={(to, parentId) => {
                              setMoving(null);
                              movePage({ ...write, spaceId, pageId: moving.id, to, parentId }).catch(failed);
                          }}
                      />
                  ),
              },
        () => setMoving(null),
    );
    const notice = toast === null ? refused[0] : undefined;
    const element = (
        <>
            {creating ? (
                <TextPrompt
                    title={NEW_PAGE}
                    label={NEW_PAGE_LABEL}
                    initial=""
                    maxLength={PAGE_TITLE_MAX}
                    onCancel={() => setCreating(false)}
                    onSave={(title) =>
                        // A refusal comes back to the prompt, which says it and asks again.
                        createOnce(() =>
                            createPage({
                                ...write,
                                spaceId,
                                title,
                                createdBy: scope.workspace.appUserId,
                                serverAt: scope.serverClock.lastDate(),
                                known: knownPages(synced, spaceId),
                            }).then(
                                () => {
                                    setCreating(false);
                                    return undefined;
                                },
                                (error: unknown) => {
                                    if (error instanceof PageWriteError) {
                                        return error.message;
                                    }
                                    setCreating(false);
                                    failed(error);
                                    return undefined;
                                },
                            ),
                        )
                    }
                    testID="page-new"
                />
            ) : null}
            {notice === undefined ? null : (
                <View pointerEvents="box-none" className="absolute right-0 bottom-0 left-0 p-4">
                    <NotSavedNotice
                        item={notice}
                        onRetry={(id) => {
                            const page = shown.find((item) => item.id === notice.pageId);
                            if (notice.again === 'confirm-delete' && page !== undefined) {
                                // Its confirm names the subpages it has now; the refused one goes once it is sent.
                                confirmDelete(page, () => {
                                    outbox.discardUnsent(id).catch(failed);
                                });
                                return;
                            }
                            outbox.retryUnsent(id, randomId()).catch(failed);
                        }}
                        onDiscard={(id) => {
                            outbox.discardUnsent(id).catch(failed);
                        }}
                        {...(notice.copy === null
                            ? {}
                            : {
                                  onCopy: () => {
                                      Clipboard.setStringAsync(notice.copy ?? '').catch(() => {});
                                  },
                              })}
                        testID="page-not-saved"
                    />
                </View>
            )}
            {toast === null ? null : (
                <UndoToast
                    key={toast.text}
                    text={toast.text}
                    {...(toast.undo === undefined
                        ? {}
                        : {
                              action: UNDO,
                              onAction: () => {
                                  setToast(null);
                                  toast.undo?.();
                              },
                          })}
                    onHide={() => setToast(null)}
                />
            )}
        </>
    );
    return {
        element,
        act,
        actionsOf,
        accessibilityActions: (page: ShownPage) => accessibilityActionsOf(actionsOf(page)),
        /** A row's long-press menu (CB-421: the system's, with the row as its preview). */
        menu: (page: ShownPage, title: string): MenuRequest => ({
            title,
            actions: actionsOf(page),
            onAction: (name) => act(page, name),
        }),
        newPage: () => setCreating(true),
    };
}

/**
 * Move's picker (CB-421: in a native sheet, its title the sheet's): the Space
 * (the web's select), then where in it, the top or under one of its pages (its
 * tree, all of it, from the phone's copy, pulled while the sheet shows).
 */
function MoveSheet(props: {
    subpages: number;
    targets: readonly Space[];
    onCancel: () => void;
    onMove: (to: string, parentId: string | null) => void;
}) {
    const { subpages, targets } = props;
    const [to, setTo] = useState<string | null>(targets[0]?.id ?? null);
    const [parentId, setParentId] = useState<string | null>(null);
    return (
        <>
            <Text variant="subheadline" tone="muted">
                {targets.length === 0 ? NO_OTHER_SPACE : moveLine(subpages)}
            </Text>
            {to === null ? null : (
                <>
                    <Choices
                        title={MOVE_TO}
                        choices={targets.map((space) => ({ id: space.id, label: space.name, depth: 0 }))}
                        chosen={to}
                        onChoose={(id) => {
                            setTo(id);
                            setParentId(null);
                        }}
                        testID="page-move-space"
                    />
                    <Parents key={to} spaceId={to} chosen={parentId} onChoose={setParentId} />
                </>
            )}
            <View className="flex-row justify-end gap-3">
                <Button label={CANCEL} variant="ghost" onPress={props.onCancel} />
                <Button
                    label={moveButton(subpages)}
                    disabled={to === null}
                    onPress={() => {
                        if (to !== null) {
                            props.onMove(to, parentId);
                        }
                    }}
                    testID="page-move-save"
                />
            </View>
        </>
    );
}

/** Where in Space `spaceId`: the top, or under one of its pages. */
function Parents({
    spaceId,
    chosen,
    onChoose,
}: {
    spaceId: string;
    chosen: string | null;
    onChoose: (id: string | null) => void;
}) {
    const { pages: store } = useWorkspaceScope();
    const space = store.space(spaceId);
    // Its pages pulled while the sheet shows it (the scheduler's `view`); keyed by Space, so one query each.
    useEffect(() => space.view(), [space]);
    const { data: pages } = useLiveQuery({ query: pagesQuery(space.collection) });
    const choices = [
        { id: '', label: AT_TOP, depth: 0 },
        ...parentChoices(pages, spaceId).map((row) => ({ id: row.id, label: row.title, depth: row.depth })),
    ];
    return (
        <Choices
            title={MOVE_UNDER}
            choices={choices}
            chosen={chosen ?? ''}
            onChoose={(id) => onChoose(id === '' ? null : id)}
            testID="page-move-parent"
        />
    );
}

/** INDENT of the parent picker's levels, in points. */
const INDENT = 16;

function Choices(props: {
    title: string;
    choices: readonly { id: string; label: string; depth: number }[];
    chosen: string;
    onChoose: (id: string) => void;
    testID: string;
}) {
    return (
        <View className="gap-1" accessibilityRole="radiogroup" accessibilityLabel={props.title}>
            <Text variant="footnote" tone="muted" weight="medium">
                {props.title}
            </Text>
            <View className="overflow-hidden rounded-xl border border-border">
                {props.choices.map((choice, index) => {
                    const on = choice.id === props.chosen;
                    return (
                        <Pressable
                            key={choice.id}
                            testID={`${props.testID}-${choice.id === '' ? 'top' : choice.id}`}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                            onPress={() => props.onChoose(choice.id)}
                            className={cx(
                                'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent',
                                index > 0 && 'border-t border-border',
                                on && 'bg-accent',
                            )}
                            style={{ paddingLeft: 12 + choice.depth * INDENT }}
                        >
                            <Text numberOfLines={1} className="min-w-0 flex-1">
                                {choice.label}
                            </Text>
                            {on ? <AppSymbol name="check" color="primary" /> : null}
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}
