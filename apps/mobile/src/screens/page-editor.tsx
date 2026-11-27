import { StackActions, type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Platform, TextInput, useWindowDimensions, View } from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PAGE_CONTENT_MAX, PAGE_TITLE_MAX } from '@socio/shared/pages/page-draft';

import { outboxStateStore } from '../chat/composer';
import { editorAppearance } from '../editor/appearance';
import { advancedLine, editorStart, reviewEditLine, saveLine } from '../editor/page-editor';
import { createEditorSession, type EditorSession } from '../editor/session';
import { useHasWorkspaceScope, usePageBody, useSyncStatus, useWorkspaceScope, useWriteHold } from '../live';
import { appState } from '../platform/app-state';
import { holdEditorGrace } from '../platform/background-grace';
import { useAdvanced } from '../platform/device-settings';
import { editorPictureSource } from '../platform/editor-pictures';
import { FOLDER_NO_EDITOR, OPEN_ONLINE } from '../shell/page-reader';
import type { EditorDraft, PageEditorDraft } from '../sync/page-drafts';
import { heldFolder, isFolder, pendingFolder } from '../sync/page-manage';
import { useColors, useScheme } from '../theme/scheme';
import { Banner, Text } from '../ui';

import { useOpenLink } from './open-link';
import { PageToasts } from './page-conflict';
import { BarButton, EditorBarTitle, UnderBar, useBarInset } from './page-editor-bar';
import { createPagePaste, usePagePaste } from './page-editor-paste';
import { EditorToolbar, useLinkPrompt } from './page-editor-toolbar';
import type { EditorWebView as EditorWebViewType } from './page-editor-webview';

// The page editor: the
// `PageEditor` route (no path), pushed from a page's Edit. The title is a
// native field (160 characters, the web's), the body tentap's WebView with
// our editor (page-editor-webview.tsx, required only here, so tentap and the
// document never load at launch), or Markdown source in a plain field when
// the web's `inspectMarkdown` says the rich editor can't keep the page, or on
// request. Under the header, the save line, read from the outbox
// (src/editor/page-editor.ts); with Advanced mode, the revision, base and lane.
//
// The editor starts from the draft a kill left, else the page's newest
// queued save, else the body on the phone (`editorStart`), and opens the page's
// draft on it; src/editor/session.ts carries the WebView's changes to it and
// the save's merges back. Leaving (Back, Android's back, the gesture) first takes
// the WebView's last edit and writes the draft; the background and a
// workspace switch are the scope's (the drafts flush every open editor). While
// typing waits for the draft's debounce, iOS holds a background task.
//
// In the rich editor, the toolbar (page-editor-toolbar.tsx) sits under the
// body and rides on the keyboard; the body's KeyboardAvoidingView adds the
// bar's height to the keyboard's, so the caret never hides behind it.

let webViewModule: typeof import('./page-editor-webview') | null = null;
/** tentap, react-native-webview and the editor's document, loaded on the first open. */
function editorWebView(): typeof EditorWebViewType {
    // oxlint-disable-next-line typescript/no-require-imports -- a lazy require keeps tentap and the 850 KB document out of launch
    webViewModule ??= require('./page-editor-webview') as typeof import('./page-editor-webview');
    return webViewModule.EditorWebView;
}

/** A removal that is the person going back (Back, Android's back, the gesture), not a reset or a switch. */
const isBack = (type: string) => type === 'GO_BACK' || type === 'POP';

/** The editor has no notices of its own for PageToasts: its banner holds them. */
function noToast(): void {}

export function PageEditorScreen({ route }: StaticScreenProps<{ spaceId: string; pageId: string }>) {
    return useHasWorkspaceScope() ? <EditorRoute spaceId={route.params.spaceId} pageId={route.params.pageId} /> : null;
}

function EditorRoute({ spaceId, pageId }: { spaceId: string; pageId: string }) {
    const scope = useWorkspaceScope();
    const body = usePageBody(spaceId, pageId);
    const [start, setStart] = useState<EditorDraft | null>(null);
    // A folder (CB-426) has no editor: its body is kept, hidden, and nothing here may show or save
    // over it. A toggle waiting on the phone counts, and so does the Space's list. That holds also
    // when it turns into one with the editor open (another device's toggle, found by a refresh):
    // the editor closes to the folder's words, and its draft stays on the phone, unsent (the
    // scope's page saves take none for a folder), for when it is a page again.
    const shut =
        pendingFolder(scope.outbox, pageId) ?? (isFolder(body.value) || heldFolder(scope.cache, spaceId, pageId));
    const found =
        start ?? (shut ? null : editorStart(scope.pageDrafts.stored(pageId), scope.outbox, pageId, body.value));
    useEffect(() => {
        if (shut && start !== null) {
            // Opened again later, it starts from the draft kept on disk.
            setStart(null);
        } else if (!shut && start === null && found !== null) {
            setStart(found);
        }
    }, [shut, start, found]);
    if (shut) {
        return <Waiting line={FOLDER_NO_EDITOR} />;
    }
    if (start === null) {
        return <Waiting line={found === null && body.settled ? OPEN_ONLINE : 'Loading page…'} />;
    }
    return <Editor target={{ kind: 'page', spaceId, pageId }} open={() => scope.pageDrafts.open(pageId, start)} />;
}

/**
 * What the editor edits: a page (its draft feeds the page's saves), or a page
 * review's draft (its edits stay in `drafts` until the review's Save;
 * leaving goes back to the review's sheet).
 */
export type EditorTarget =
    | { readonly kind: 'page'; readonly spaceId: string; readonly pageId: string }
    | { readonly kind: 'review'; readonly chat: string; readonly call: string; readonly dot: string };

export const EDIT_PAGE = 'Edit page';
export const EDIT_REVIEW_DRAFT = 'Edit draft';

export function Waiting({ line, title = EDIT_PAGE }: { line: string; title?: string }) {
    const navigation = useNavigation();
    const inset = useBarInset();
    useLayoutEffect(() => {
        navigation.setOptions({ title, headerTitle: title });
    }, [navigation, title]);
    return (
        <View testID="page-editor" className="flex-1 bg-screen" collapsable={false}>
            <View className="p-4" style={{ paddingTop: inset + 16 }}>
                <Text variant="subheadline" tone="muted" testID="page-editor-waiting">
                    {line}
                </Text>
            </View>
        </View>
    );
}

export function Editor({ target, open }: { target: EditorTarget; open: () => PageEditorDraft }) {
    const navigation = useNavigation();
    const pageId = target.kind === 'page' ? target.pageId : null;
    const spaceId = target.kind === 'page' ? target.spaceId : null;
    // The review's ids as plain strings, so leaving's listener isn't added again on every render.
    const [chat, call, dot] = target.kind === 'review' ? [target.chat, target.call, target.dot] : [null, null, null];
    const scope = useWorkspaceScope();
    const openLink = useOpenLink();
    const scheme = useScheme();
    const colors = useColors();
    const { fontScale } = useWindowDimensions();
    const advanced = useAdvanced();
    const [draft] = useState(open);
    // A page's pasted pictures: made before the session, which hands it the WebView's paste.
    const [paste] = useState(createPagePaste);
    const [session] = useState<EditorSession>(() =>
        createEditorSession({
            draft,
            appearance: editorAppearance(scheme, fontScale),
            // The page's own pictures from the image cache: the WebView fetches nothing.
            pictures: editorPictureSource(scope),
            ...(spaceId === null ? {} : { onPasteImage: paste.fromWebView }),
        }),
    );
    const canPaste = usePagePaste(paste, spaceId, session);
    const view = useSyncExternalStore(session.subscribe, session.view);
    const [store] = useState(() => outboxStateStore(scope.outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const { reconnecting } = useSyncStatus();
    const hold = useWriteHold();
    const [toolbarHeight, setToolbarHeight] = useState(0);
    // The bar lies over the document on iOS: the document pads by it, and by the home indicator's room while the keyboard is down.
    const barInset = useBarInset();
    const safe = useSafeAreaInsets();
    const keyboardUp = useKeyboardState((state) => state.isVisible);
    // The workspace's origin: links to its pages are written in the `/#/spaces/…` form.
    const linkPrompt = useLinkPrompt(session, scope.workspace.origin);
    const bottomInset = keyboardUp ? 0 : safe.bottom;

    useEffect(() => {
        session.setAppearance(editorAppearance(scheme, fontScale, { top: barInset, bottom: bottomInset }));
    }, [session, scheme, fontScale, barInset, bottomInset]);
    // Back online: the pictures the cache couldn't give are asked for again.
    useEffect(() => {
        if (!reconnecting) {
            session.retryPictures();
        }
    }, [session, reconnecting]);
    // Unmounted (the route gone, a workspace switch): the draft closes, saving a pending debounce.
    useEffect(() => () => void session.close(), [session]);
    // Leaving takes the WebView's last edit first, then goes.
    useEffect(() => {
        let leaving = false;
        return navigation.addListener('beforeRemove', (event) => {
            if (leaving) {
                return;
            }
            leaving = true;
            event.preventDefault();
            void session.close().finally(() =>
                navigation.dispatch(
                    // A review's editor goes back to its sheet, which shows the edits with Save.
                    chat !== null && call !== null && dot !== null && isBack(event.data.action.type)
                        ? StackActions.replace('PageReview', { chat, call, dot })
                        : event.data.action,
                ),
            );
        });
    }, [navigation, session, chat, call, dot]);
    // The background: the WebView's last edit into the draft (the scope then flushes it).
    useEffect(
        () =>
            appState.subscribe((next) => {
                if (next === 'background') {
                    void session.flush();
                }
            }),
        [session],
    );
    useEffect(() => {
        holdEditorGrace(view.editing);
    }, [view.editing]);
    useEffect(() => () => holdEditorGrace(false), []);

    const line =
        pageId === null
            ? reviewEditLine(draft.error())
            : saveLine({
                  outbox: {
                      rows: () => [...writes.rows],
                      unsent: () => [...writes.unsent],
                      resolve: scope.outbox.resolve,
                  },
                  pageId,
                  draftError: draft.error(),
                  editing: view.editing,
                  connected: !reconnecting,
                  held: writes.heldForSignIn || hold !== null,
              });
    // Mounted in source mode too (hidden): Visual editor's check runs in it.
    const EditorWebView = editorWebView();
    const source = view.mode === 'source';
    const monospace = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
    const advancedText = advanced && pageId !== null ? advancedLine(scope.outbox, pageId, draft.read().revision) : null;
    const screenTitle = pageId === null ? EDIT_REVIEW_DRAFT : EDIT_PAGE;
    // In source mode the title is the native field's, on screen: the bar keeps to the status.
    const titleShown = source || view.mode === 'loading' || view.titleShown;
    const destructive = line.tone === 'destructive';
    const lineText = line.text;
    const pageTitle = view.text.title;
    const modeDisabled = view.mode === 'loading';

    // The system's bar (CB-417): the save line as its status, the title once it scrolled away, and the mode's button.
    useLayoutEffect(() => {
        navigation.setOptions({
            title: screenTitle,
            headerTitle: () => (
                <EditorBarTitle title={pageTitle} titleShown={titleShown} status={lineText} destructive={destructive} />
            ),
            headerRight: () => (
                <BarButton
                    icon={source ? 'type' : 'file-code-2'}
                    label={source ? 'Visual editor' : 'Markdown source'}
                    disabled={modeDisabled}
                    onPress={() => (source ? session.showRich() : session.showSource())}
                    testID="page-editor-mode"
                />
            ),
            headerTintColor: colors.foreground,
            // Android's top app bar takes the raised container color once the page scrolls under it, as Material's does.
            ...(Platform.OS === 'android'
                ? { headerStyle: { backgroundColor: titleShown ? colors.header : colors.muted } }
                : {}),
        });
    }, [navigation, screenTitle, pageTitle, titleShown, lineText, destructive, source, modeDisabled, session, colors]);

    return (
        <View testID="page-editor" className="flex-1 bg-screen" collapsable={false}>
            <KeyboardAvoidingView
                behavior="padding"
                automaticOffset
                keyboardVerticalOffset={source ? 0 : toolbarHeight}
                style={{ flex: 1 }}
            >
                {line.detail === null && advancedText === null && view.notice === null ? null : (
                    <UnderBar inset={barInset}>
                        {line.detail === null && advancedText === null ? null : (
                            <View className="gap-1 rounded-lg border border-border bg-card px-3 py-2">
                                {line.detail === null ? null : (
                                    <Text variant="footnote" tone="destructive">
                                        {line.detail}
                                    </Text>
                                )}
                                {advancedText === null ? null : (
                                    <Text variant="footnote" tone="muted" testID="page-editor-advanced">
                                        {advancedText}
                                    </Text>
                                )}
                            </View>
                        )}
                        {view.notice === null ? null : (
                            <Banner
                                tone="warning"
                                action={{ label: 'OK', onPress: session.dismissNotice }}
                                testID="page-editor-notice"
                            >
                                {view.notice}
                            </Banner>
                        )}
                    </UnderBar>
                )}
                <View className="flex-1">
                    {source ? (
                        <View className="flex-1 gap-3 p-4" style={{ paddingTop: barInset + 16 }}>
                            <TextInput
                                value={view.text.title}
                                onChangeText={session.setTitle}
                                maxLength={PAGE_TITLE_MAX}
                                placeholder="Untitled page"
                                placeholderTextColor={colors['muted-foreground']}
                                accessibilityLabel="Page title"
                                multiline
                                submitBehavior="blurAndSubmit"
                                className="text-3xl font-semibold tracking-tight text-foreground"
                                // Flush with the screen's padding, as the body's text is.
                                style={{ paddingHorizontal: 0 }}
                                testID="page-editor-title"
                            />
                            <View className="flex-1 gap-2" testID="page-editor-source">
                                <Text variant="footnote" weight="medium" tone="muted">
                                    Markdown source
                                </Text>
                                {view.sourceReason === null ? null : (
                                    <Text variant="footnote" tone="muted" testID="page-editor-source-reason">
                                        {view.sourceReason}
                                    </Text>
                                )}
                                <TextInput
                                    value={view.text.content}
                                    onChangeText={session.setSource}
                                    maxLength={PAGE_CONTENT_MAX}
                                    multiline
                                    autoCorrect={false}
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    textAlignVertical="top"
                                    accessibilityLabel="Page Markdown"
                                    className="flex-1 rounded-lg border border-border bg-muted/30 p-4 text-base text-foreground"
                                    style={{ fontFamily: monospace }}
                                    testID="page-editor-markdown"
                                />
                            </View>
                        </View>
                    ) : null}
                    {/* The title is the document's own (CB-417), so it scrolls with the text under the bar; the editor pads both by 16. */}
                    <View
                        className={source ? 'h-0 overflow-hidden' : 'flex-1'}
                        importantForAccessibility={source ? 'no-hide-descendants' : 'auto'}
                        accessibilityElementsHidden={source}
                    >
                        <EditorWebView session={session} onOpenLink={openLink} testID="page-editor-body" />
                    </View>
                </View>
                {/* Saves go out from here, so their merges mostly land here: the toast sits above the toolbar. */}
                {pageId === null ? null : <PageToasts pageId={pageId} notice={null} onHide={noToast} />}
            </KeyboardAvoidingView>
            {source || !keyboardUp ? null : (
                <EditorToolbar
                    session={session}
                    view={view}
                    onHeight={setToolbarHeight}
                    onLink={linkPrompt.open}
                    {...(spaceId === null ? {} : { pasteImage: { enabled: canPaste, onPress: paste.fromClipboard } })}
                />
            )}
            {linkPrompt.element}
        </View>
    );
}
