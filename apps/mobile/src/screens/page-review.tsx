import { useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { pageReviewCard } from '../chat/cards';
import { chatSource } from '../chat/chat-source';
import { outboxStateStore } from '../chat/composer';
import {
    DISCARD_EDITS,
    DISCARD_EDITS_CONFIRM,
    EDIT_DRAFT,
    readReviewReceipt,
    reviewDecision,
    reviewDraftShown,
    type ReviewReceipt,
    reviewSheetView,
    skipConfirm,
} from '../chat/page-review';
import { useHasWorkspaceScope, useWorkspaceScope } from '../live';
import { randomId } from '../platform/crypto';
import { SAVED_AS_NEW } from '../shell/page-conflict';
import { SAVE_AS_NEW_PAGE } from '../shell/unsent';
import { reviewDraft } from '../sync/chat-drafts';
import { overlaysOf } from '../sync/outbox-overlay';
import { parseEditorDraft } from '../sync/page-drafts';
import { decideReview, openReviews, PAGE_REVIEW_VIEW } from '../sync/page-review';
import { dropEdits, saveEditsAsNewPage } from '../sync/review-edits';
import { Button, AppSymbol, Text } from '../ui';

import { OPEN_PAGE } from './chat-cards';
import { ReplyMarkdown } from './chat-markdown';
import { useOpenLink } from './open-link';
import { useSaveAsNewPage } from './page-conflict';

// The page review's sheet, from its card in a chat: the socio's draft, its
// title and Markdown (the chat replies' renderer, nothing fetched), then Save
// and Skip. Each queues the decision in the outbox
// (sync/page-review.ts) and closes the sheet; the card follows it. The
// receipt is asked once as the sheet opens, online only (src/chat/page-review.ts
// says what each answer changes).
//
// Edit closes the sheet and opens the page editor on the draft
// (`PageReviewEditor`, page-editor.tsx); leaving it opens this sheet again on
// the person's version, kept in `drafts` (sync/review-edits.ts), which Save
// then saves. Discard edits (asks first) goes back to the socio's draft; Skip
// with edits asks first too, since it clears them (`skipConfirm`). Edits
// whose review was decided elsewhere stay, with Copy and Save as a new page.

export const SKIP = 'Skip';

const REVIEW_KINDS = [PAGE_REVIEW_VIEW];

export function PageReviewScreen({ route }: StaticScreenProps<{ chat: string; call: string; dot: string }>) {
    return useHasWorkspaceScope() ? (
        <PageReview chat={route.params.chat} call={route.params.call} dot={route.params.dot} />
    ) : null;
}

function PageReview({ chat, call, dot }: { chat: string; call: string; dot: string }) {
    const scope = useWorkspaceScope();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const openLink = useOpenLink();
    const [source] = useState(() => chatSource(scope.histories.history(chat), scope.follows.follow(chat)));
    useEffect(() => source.history.use(), [source]);
    const snapshot = useSyncExternalStore(source.subscribe, source.get);
    const [store] = useState(() => outboxStateStore(scope.outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const receipt = useReceipt(chat, call);
    const [busy, setBusy] = useState(false);
    const editsScope = reviewDraft(chat, call);
    const editsText = useSyncExternalStore(
        (listener) => scope.drafts.subscribe((changed) => (changed === editsScope ? listener() : undefined)),
        () => scope.drafts.read(editsScope).text,
    );
    const stored = editsText ? parseEditorDraft(editsText) : undefined;
    const edits = stored === undefined ? null : { title: stored.title, content: stored.content };
    const { pickSpace, element: picker } = useSaveAsNewPage();
    const toolCall = snapshot.runs
        .flatMap((run) => run.messages)
        .flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []) : []))
        .find((found) => found.id === call);
    if (toolCall === undefined) {
        return (
            <View testID="page-review" className="bg-sheet p-5">
                <Text variant="subheadline" tone="muted">
                    This review isn’t in the chat any more.
                </Text>
            </View>
        );
    }
    const result = snapshot.runs
        .flatMap((run) => run.messages)
        .find((message) => message.role === 'tool' && message.toolCallId === call);
    const card = pageReviewCard(toolCall, result?.role === 'tool' ? result.content : undefined);
    if (card.kind !== 'page-review') {
        return null;
    }
    const decision = reviewDecision(
        overlaysOf({ rows: writes.rows, unsent: writes.unsent, kinds: REVIEW_KINDS, scope: scope.outbox }),
        call,
    );
    const open = openReviews(snapshot.runs).some((found) => found.toolCallId === call);
    const view = reviewSheetView(card, { open, receipt, decision, edits });
    const draft = reviewDraftShown(card.args, edits);
    const decide = (approved: boolean) => {
        setBusy(true);
        decideReview(scope.outbox, {
            threadId: chat,
            dotId: dot,
            toolCallId: call,
            args: card.args,
            approved,
            newId: randomId,
            // Continue on a receipt that doesn't hold the edits answers without them.
            ...(edits === null || !view.sendEdits ? {} : { edits }),
        })
            .then(() => navigation.goBack())
            .catch((error: unknown) => {
                console.warn('[review] the decision was not queued', error);
                setBusy(false);
            });
    };
    const edit = () => {
        // The sheet closes first: the editor opens over the chat, not inside the sheet.
        navigation.goBack();
        navigation.navigate('PageReviewEditor', { chat, call, dot });
    };
    const discard = () =>
        Alert.alert(DISCARD_EDITS_CONFIRM.title, DISCARD_EDITS_CONFIRM.message, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: DISCARD_EDITS_CONFIRM.action,
                style: 'destructive',
                onPress: () => dropEdits(scope.drafts, chat, call, (error) => console.warn('[review]', error)),
            },
        ]);
    // A Skip clears the edits: with edits, it asks first, as Discard edits does.
    const skip = () => {
        const confirm = skipConfirm(edits);
        if (confirm === null) {
            decide(false);
            return;
        }
        Alert.alert(confirm.title, confirm.message, [
            { text: 'Cancel', style: 'cancel' },
            { text: confirm.action, style: 'destructive', onPress: () => decide(false) },
        ]);
    };
    const copy = () => {
        Clipboard.setStringAsync(`${draft.title}\n\n${draft.content}`).catch((error: unknown) =>
            console.warn('[review] not copied', error),
        );
    };
    const saveAsNew = () =>
        pickSpace(stored?.spaceId ?? '', (target) => {
            saveEditsAsNewPage(scope.drafts, chat, call, {
                outbox: scope.outbox,
                newId: randomId,
                spaceId: target,
                createdBy: scope.workspace.appUserId,
                serverAt: scope.serverClock.lastDate(),
                known: scope.pages.space(target).collection.toArray.map((found) => found.id),
            })
                .then((localId) => {
                    if (localId !== null) {
                        AccessibilityInfo.announceForAccessibility(SAVED_AS_NEW);
                        navigation.goBack();
                    }
                })
                .catch((error: unknown) => {
                    console.warn('[review] not saved as a new page', error);
                    Alert.alert('That didn’t work', 'Your edits are still here. Try again.');
                });
        });
    const page = view.page;
    return (
        // The ScrollView is the sheet's root, as the trace's is: below a View, an iOS form sheet drew none
        // of the draft (seen on the first iOS run). The decision bar ends the scroll, held at the sheet's
        // bottom while the draft is short (the spacer).
        <ScrollView testID="page-review" className="bg-sheet" contentContainerStyle={{ flexGrow: 1 }}>
            <View style={{ padding: 20, gap: 16 }}>
                <View className="flex-row items-center gap-2">
                    <AppSymbol name="file-text" color="muted-foreground" />
                    <Text variant="footnote" tone="muted" accessibilityRole="header" className="flex-1">
                        {view.heading}
                    </Text>
                </View>
                <Text variant="headline">{draft.title}</Text>
                {draft.content === '' ? null : <ReplyMarkdown text={draft.content} testID="page-review-draft" />}
            </View>
            <View className="grow" />
            <View className="gap-3 border-t border-border p-5" style={{ paddingBottom: 20 + insets.bottom }}>
                {view.lines.map((line) => (
                    <Text key={line.text} variant="footnote" tone={line.problem ? 'destructive' : 'muted'}>
                        {line.text}
                    </Text>
                ))}
                <View className="flex-row flex-wrap gap-2">
                    {view.save === null ? null : (
                        <Button label={view.save} onPress={() => decide(true)} busy={busy} testID="page-review-save" />
                    )}
                    {view.edit ? (
                        <Button
                            label={EDIT_DRAFT}
                            variant="secondary"
                            icon="pen-line"
                            onPress={edit}
                            disabled={busy}
                            testID="page-review-edit"
                        />
                    ) : null}
                    {view.skip ? (
                        <Button
                            label={SKIP}
                            variant="secondary"
                            onPress={skip}
                            disabled={busy}
                            testID="page-review-skip"
                        />
                    ) : null}
                    {page === null ? null : (
                        <Button
                            label={OPEN_PAGE}
                            variant="ghost"
                            icon="external-link"
                            onPress={() => openLink(page)}
                            testID="page-review-open"
                        />
                    )}
                    {view.keep ? (
                        <>
                            <Button
                                label={SAVE_AS_NEW_PAGE}
                                variant="secondary"
                                icon="file-plus"
                                onPress={saveAsNew}
                                testID="page-review-save-new"
                            />
                            <Button label="Copy" variant="ghost" icon="copy" onPress={copy} testID="page-review-copy" />
                        </>
                    ) : null}
                    {view.discard ? (
                        <Button
                            label={DISCARD_EDITS}
                            variant="ghost"
                            onPress={discard}
                            disabled={busy}
                            testID="page-review-discard"
                        />
                    ) : null}
                </View>
            </View>
            {picker}
        </ScrollView>
    );
}

/** The review's receipt, asked once as the sheet opens. */
function useReceipt(chat: string, call: string): ReviewReceipt {
    const scope = useWorkspaceScope();
    const [receipt, setReceipt] = useState<ReviewReceipt>({ kind: 'checking' });
    useEffect(() => {
        const controller = new AbortController();
        readReviewReceipt(scope.fetch, chat, call, controller.signal).then((found) => {
            if (!controller.signal.aborted) {
                setReceipt(found);
            }
        });
        return () => controller.abort();
    }, [scope, chat, call]);
    return receipt;
}
