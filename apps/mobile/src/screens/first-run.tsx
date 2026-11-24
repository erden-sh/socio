import { StackActions, useNavigation } from '@react-navigation/native';
import { Fragment, type ReactNode, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
    KeyboardAvoidingView,
    KeyboardController,
    useKeyboardState,
    useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { type Edge, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ModelChoice } from '@socio/shared/inference';

import { composerView, SEND_FAILED } from '../chat/composer';
import { MODEL_PICKER_HINT, modelPickerView } from '../chat/model-picker';
import { useCollections, useLiveQuery, useWorkspaceScope } from '../live';
import { chatAction } from '../navigation/tabs';
import { randomId } from '../platform/crypto';
import {
    fillStarter,
    firstRun,
    type FirstRunView,
    STARTER_HINT,
    type StarterPrompt,
    STARTERS_LABEL,
} from '../shell/first-run';
import { chatsQuery, shellQuery, shellRows, sociosQuery } from '../shell/queries';
import { newChatDraft } from '../sync/chat-drafts';
import { enqueueNewChat, newestChat } from '../sync/new-chat';
import { Banner, AppSymbol, Screen, Text } from '../ui';
import { cx } from '../ui/cx';
import { keyboardFooterInset } from '../ui/keyboard-scroll';

import { useTray } from './attachments';
import { Composer, useDraft } from './chat-composer';
import { useModelOptions } from './chat-header';
import { ListRow, StatusBanners, SocioAvatar } from './shell-parts';
import { TAB_EDGES } from './tab-edges';

// The first run (src/shell/first-run.ts): with no chats yet, New
// chat with the default socio chosen, a socio picker at the top and the
// privacy line. Its composer keeps the socio's new-chat draft and sends
// it as a new chat (`enqueueNewChat`), then opens that chat under its
// local id, which swaps to the server's once the create resolves. Home shows it
// today: Home calls `useFirstRun()` inside a workspace scope and
// draws `<FirstRun>` while its view isn't null, with its header actions (the
// workspace button, which opens the drawer, leads; the account button ends)
// and anything under it. It sits in a tab, so the tab bar keeps the bottom
// safe area clear (tab-edges.ts); a keyboard-controller KeyboardAvoidingView
// keeps the composer above the keyboard. New chat, a page with the bottom
// edge, pins its composer under the scrolling part instead (CB-466): in it,
// with the bottom safe area kept while the keyboard was up, the composer was
// cut off and sat that inset above the keyboard. New chat hides the tab bar
// (CB-491), so its inset is the home indicator alone. The web's starters (CB-359) sit just
// above the composer, as the web's do on a phone: a short list of full-width
// cards, each a tap that fills the box. They give way while the keyboard is
// up (the web's `keyboard:hidden`, CB-155), so the composer never shares the
// little room left with them.
//
// The model (the web's ModelPicker in the new chat's composer): under
// the starters, at the composer's end as the web's sits by its send, the
// model the new chat will run on, "Automatic: …" (or the socio's default) until
// one is chosen. It opens an inline list, as the socio picker does (the
// ChatModel sheet needs a chat), over model-picker.ts's rows. The choice goes
// in the create (`enqueueNewChat`'s `inference`), so the first reply runs on
// it; choosing another socio goes back to that socio's default, as the web's
// New chat for another socio does.

export interface FirstRunState {
    /** The screen's view, or null when the workspace has chats (or isn't known yet). */
    readonly view: FirstRunView | null;
    /** Chooses the socio the new chat is with. */
    readonly pick: (socioId: string) => void;
}

/** The first run's view from the open scope's collections, and the picker's choice. */
export function useFirstRun(): FirstRunState {
    const collections = useCollections();
    const [picked, setPicked] = useState<string | null>(null);
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { data: chats } = useLiveQuery({ query: chatsQuery(collections) });
    const { state, workspace } = shellRows(shell);
    return { view: firstRun({ chats, dots, state, workspace, picked }), pick: setPicked };
}

export function FirstRun(props: {
    view: FirstRunView;
    pick: (socioId: string) => void;
    /** Before the picker, at the top's start: the workspace button. */
    leading?: ReactNode;
    /** Beside the picker, at the top's end. */
    action?: ReactNode;
    /** Under the composer. */
    children?: ReactNode;
    /**
     * Its safe areas: a tab's (Home) by default; a page pushed in a tab (`NewChat`) takes the bottom one
     * too, and its composer is pinned under the scrolling part, on the keyboard (CB-466).
     */
    edges?: readonly Edge[];
    /** The new chat replaces this screen (`NewChat`), so Back goes where New chat was opened from; else it is pushed. */
    replace?: boolean;
    testID?: string;
}) {
    const { view } = props;
    const [open, setOpen] = useState(false);
    const [modelsOpen, setModelsOpen] = useState(false);
    // The choice holds for the socio it was made with; another socio starts on its default.
    const [model, setModel] = useState<{ socioId: string; choice: ModelChoice } | null>(null);
    const { chosen } = view;
    const inference = model !== null && model.socioId === chosen.id ? model.choice : null;
    const composer = (
        <View className="gap-1">
            <NewChatModel
                socioId={chosen.id}
                value={inference}
                open={modelsOpen}
                setOpen={setModelsOpen}
                choose={(choice) => setModel(choice === null ? null : { socioId: chosen.id, choice })}
            />
            <FirstRunComposer
                socioId={chosen.id}
                inference={inference}
                label={view.composerLabel}
                placeholder={view.composerPlaceholder}
                replace={props.replace === true}
            />
        </View>
    );
    const edges = props.edges ?? TAB_EDGES;
    const pinned = edges.includes('bottom');
    const content = (
        <Screen
            testID={props.testID ?? 'first-run'}
            // A pinned composer keeps the bottom safe area itself (PinnedComposer).
            edges={pinned ? edges.filter((edge) => edge !== 'bottom') : edges}
            keyboardAware={false}
        >
            <StatusBanners />
            <View className="flex-row items-center gap-3">
                {props.leading}
                <View className="min-w-0 flex-1 flex-row">
                    <Pressable
                        testID="socio-picker"
                        accessibilityRole="button"
                        accessibilityLabel={`Socio: ${chosen.name}`}
                        accessibilityHint="Chooses who the new chat is with"
                        accessibilityState={{ expanded: open }}
                        onPress={() => setOpen(!open)}
                        className="min-h-11 min-w-0 flex-row items-center gap-1.5 rounded-md px-2 active:bg-accent"
                    >
                        <Text variant="headline" numberOfLines={1}>
                            {chosen.name}
                        </Text>
                        <AppSymbol name={open ? 'chevron-up' : 'chevron-down'} color="muted-foreground" />
                    </Pressable>
                </View>
                {props.action}
            </View>
            {open ? (
                <View className="rounded-xl border border-border bg-card" testID="socio-picker-list">
                    {view.socios.map((socio, index) => (
                        <ListRow
                            key={socio.id}
                            first={index === 0}
                            testID={`pick-socio-${socio.id}`}
                            leading={<SocioAvatar character={socio.character} />}
                            title={socio.name}
                            subtitle={socio.personal ? `Personal · ${socio.blurb}` : socio.blurb}
                            trailing={socio.id === chosen.id ? <AppSymbol name="check" color="foreground" /> : null}
                            accessibilityLabel={`${socio.name}${socio.personal ? ', Personal' : ''}${socio.id === chosen.id ? ', chosen' : ''}`}
                            onPress={() => {
                                props.pick(socio.id);
                                setOpen(false);
                            }}
                        />
                    ))}
                </View>
            ) : null}
            <View className="items-center gap-2" testID="first-run-socio">
                <SocioAvatar character={chosen.character} />
                <Text accessibilityRole="header" variant="headline">
                    {chosen.personal ? `${chosen.name} · Personal` : chosen.name}
                </Text>
                <Text variant="subheadline" tone="muted" className="text-center" numberOfLines={3}>
                    {chosen.blurb}
                </Text>
            </View>
            {view.noInference === null ? null : (
                <Banner tone="warning" testID="no-inference">
                    {view.noInference}
                </Banner>
            )}
            <View className="grow" />
            <Text variant="footnote" tone="muted" className="text-center" testID="privacy-line">
                {view.privacy}
            </Text>
            {modelsOpen ? null : <StarterPrompts socioId={chosen.id} starters={view.starters} />}
            {pinned ? null : composer}
            {props.children}
        </Screen>
    );
    return (
        // The composer rides above the keyboard (it once stayed under it on Android). The view finds
        // its own place on screen, so a tab bar under it (Home's) counts.
        <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
            {pinned ? (
                <View className="flex-1 bg-screen" collapsable={false}>
                    {content}
                    <PinnedComposer>{composer}</PinnedComposer>
                </View>
            ) : (
                content
            )}
        </KeyboardAvoidingView>
    );
}

/**
 * A page's composer (New chat, CB-466): under the scrolling part, never in it, so
 * it is always whole and grows with its text, as the chat's does. It keeps the
 * bottom safe area (the home indicator: New chat hides the tab bar, CB-491) while the keyboard is down
 * and gives it up as the keyboard comes, since the KeyboardAvoidingView already
 * lifts the screen by the keyboard's height: it sits right on the keyboard.
 */
function PinnedComposer({ children }: { children: ReactNode }) {
    const insets = useSafeAreaInsets();
    const { progress } = useReanimatedKeyboardAnimation();
    const bottom = useAnimatedStyle(() => ({ paddingBottom: keyboardFooterInset(insets.bottom, progress.value) }));
    return (
        <Animated.View
            testID="first-run-pinned-composer"
            style={[{ paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }, bottom]}
        >
            {children}
        </Animated.View>
    );
}

/**
 * The web's starters (ChatViews.tsx's outline buttons on a phone): each an
 * outlined card on the page's own background, its words small and muted with
 * the arrow beside them, that fills the socio's new-chat box with its text
 * (`fillStarter`), never a send. Hidden while the keyboard is up.
 */
function StarterPrompts({ socioId, starters }: { socioId: string; starters: readonly StarterPrompt[] }) {
    const { drafts } = useWorkspaceScope();
    const keyboard = useKeyboardState((state) => state.isVisible);
    if (keyboard || starters.length === 0) {
        return null;
    }
    return (
        <View accessibilityLabel={STARTERS_LABEL} accessibilityRole="list" className="gap-2" testID="new-chat-starters">
            {starters.map((starter, index) => (
                <Pressable
                    key={starter.text}
                    testID={`starter-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={starter.text}
                    accessibilityHint={STARTER_HINT}
                    accessibilityState={{ disabled: !starter.enabled }}
                    disabled={!starter.enabled}
                    onPress={() => fillStarter(drafts, socioId, starter.text)}
                    className={cx(
                        'min-h-11 flex-row items-center gap-2 rounded-lg border border-border px-3.5 py-2.5 active:bg-accent',
                        !starter.enabled && 'opacity-50',
                    )}
                >
                    <Text variant="footnote" tone="muted" className="min-w-0 flex-1">
                        {starter.text}
                    </Text>
                    <AppSymbol name="arrow-up-right" size={12} color="muted-foreground" />
                </Pressable>
            ))}
        </View>
    );
}

/**
 * The new chat's model: the trigger, the web's ModelPicker by the send
 * (small and muted, cut in the middle, disabled until the choices are known, as
 * the web's is), and above it while open the list: the socio's default first,
 * then the person's choices by where they run, one they can't run on now
 * disabled, the chosen one checked.
 */
function NewChatModel(props: {
    socioId: string;
    value: ModelChoice | null;
    open: boolean;
    setOpen: (open: boolean) => void;
    choose: (choice: ModelChoice | null) => void;
}) {
    const collections = useCollections();
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const models = useModelOptions();
    const dot = dots.find((known) => known.id === props.socioId);
    const picker = modelPickerView({ value: props.value, dotDefault: dot?.inference, models });
    const disabled = models === null;
    return (
        <>
            {props.open && !disabled ? (
                <View
                    className="rounded-xl border border-border bg-card"
                    accessibilityRole="radiogroup"
                    testID="new-chat-model-list"
                >
                    {picker.rows.map((row, index) => (
                        <Fragment key={row.key}>
                            {row.group !== null && row.group !== picker.rows[index - 1]?.group ? (
                                <Text
                                    variant="footnote"
                                    tone="muted"
                                    accessibilityRole="header"
                                    className="border-t border-border px-3 pt-3"
                                >
                                    {row.group}
                                </Text>
                            ) : null}
                            <Pressable
                                testID={`new-chat-model-${row.key}`}
                                accessibilityRole="radio"
                                accessibilityLabel={row.accessibilityLabel}
                                accessibilityState={{ checked: row.checked, disabled: row.disabled }}
                                disabled={row.disabled}
                                onPress={() => {
                                    props.choose(row.choice);
                                    props.setOpen(false);
                                }}
                                className={cx(
                                    'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent disabled:opacity-50',
                                    index > 0 && row.group === null && 'border-t border-border',
                                )}
                            >
                                <Text className="min-w-0 flex-1">{row.label}</Text>
                                <View className="w-5">
                                    {row.checked ? <AppSymbol name="check" size={20} color="primary" /> : null}
                                </View>
                            </Pressable>
                        </Fragment>
                    ))}
                </View>
            ) : null}
            <View className="flex-row justify-end">
                <Pressable
                    testID="new-chat-model-picker"
                    accessibilityRole="button"
                    accessibilityLabel={picker.accessibilityLabel}
                    accessibilityHint={disabled ? undefined : MODEL_PICKER_HINT}
                    accessibilityState={{ disabled, expanded: props.open && !disabled }}
                    disabled={disabled}
                    onPress={() => props.setOpen(!props.open)}
                    className={cx(
                        'min-h-11 max-w-full flex-row items-center gap-1 rounded-md px-2 active:bg-accent',
                        disabled && 'opacity-50',
                    )}
                >
                    <Text variant="footnote" tone="muted" numberOfLines={1} ellipsizeMode="middle" className="shrink">
                        {picker.label}
                    </Text>
                    <AppSymbol
                        name={props.open && !disabled ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color="muted-foreground"
                    />
                </Pressable>
            </View>
        </>
    );
}

/** How long the new chat waits for the keyboard to go before it opens anyway. */
const KEYBOARD_GONE_MS = 500;

/** The first run's composer: the socio's new-chat box, sent as a new chat. */
function FirstRunComposer({
    socioId,
    inference,
    label,
    placeholder,
    replace,
}: {
    socioId: string;
    /** The model chosen for the new chat; null: the socio's default. */
    inference: ModelChoice | null;
    label: string;
    placeholder: string;
    replace: boolean;
}) {
    const scope = useWorkspaceScope();
    const navigation = useNavigation();
    const collections = useCollections();
    const { data: chats } = useLiveQuery({ query: chatsQuery(collections) });
    const draft = useDraft(newChatDraft(socioId));
    const tray = useTray(newChatDraft(socioId));
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const view = composerView({
        text: draft.text,
        running: false,
        locked: draft.locked || !scope.userDb.writable,
        heldForSignIn: scope.outbox.status().heldForSignIn,
        busy,
        files: tray.items.filter((item) => !item.failed).length,
    });
    const send = () => {
        setNotice(null);
        setBusy(true);
        enqueueNewChat({
            drafts: scope.drafts,
            dotId: socioId,
            newId: randomId,
            after: newestChat(chats),
            serverAt: scope.serverClock.lastDate(),
            // The tray's files go with the first message, uploading pending until the create resolves.
            files: scope.attachments,
            // The chosen model goes in the create, so the first reply runs on it.
            inference,
        })
            .then((created) => {
                if (created !== null) {
                    // The keyboard goes first: pushed with it up, the chat on iOS kept its composer
                    // where the keyboard had been after it closed (seen on the first iOS run).
                    // At most KEYBOARD_GONE_MS: a hide event that never comes doesn't keep the chat shut.
                    let opened = false;
                    const open = () => {
                        if (!opened) {
                            opened = true;
                            if (replace) {
                                navigation.dispatch(StackActions.replace('Chat', { id: created.localId }));
                            } else {
                                navigation.dispatch(chatAction(created.localId));
                            }
                        }
                    };
                    KeyboardController.dismiss().then(open, open);
                    setTimeout(open, KEYBOARD_GONE_MS);
                }
            })
            .catch((error: unknown) => {
                console.warn('[chat] the new chat was not saved', error);
                setNotice(SEND_FAILED);
            })
            .finally(() => setBusy(false));
    };
    return (
        <View accessibilityLabel={label} className="-mx-3">
            <Composer
                text={draft.text}
                onChangeText={draft.setText}
                view={view}
                onSend={send}
                onStop={() => {}}
                notice={notice}
                placeholder={placeholder}
                inputLabel={label}
                bottomInset={false}
                tray={tray}
                testID="first-run-composer"
            />
        </View>
    );
}
