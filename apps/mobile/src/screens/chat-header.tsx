import { useNavigation } from '@react-navigation/native';
import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import type { ModelChoice, ModelOptions } from '@socio/shared/inference';
import type { LocalId } from '@socio/shared/mascot';

import {
    chatMenu,
    PAGE_TITLE_MAX,
    SAVE_PAGE_LABEL,
    SAVE_PAGE_TITLE,
    scheduleTaskHref,
    socioLineLabel,
} from '../chat/chat-header';
import {
    keptModelOptions,
    MODEL_OPTIONS_KEY,
    MODEL_OPTIONS_PATH,
    modelPickerView,
    modelTrigger,
    parseModelOptions,
} from '../chat/model-picker';
import { useSyncStatus, useViewState, useWorkspaceScope } from '../live';
import { pageAction } from '../navigation/tabs';
import { isLocalChat } from '../sync/local-ids';
import { readAnswer } from '../sync/outbox-answers';
import { SAVE_CHAT_PAGE_COPY, saveChatAsPage, savedPageTitle } from '../sync/save-chat-page';
import { AppSymbol, LocalAvatar, Text } from '../ui';

import { type MenuRequest, TextPrompt, UndoToast } from './action-menu';
import { useOpenLink } from './open-link';
import { online } from './schedule-parts';

// A private chat's bar (the web's ChatHeader, modules/chat/Chat.tsx; the PWA
// comparison's 2.1; CB-420, ChatGPT's iOS bar), over src/chat/chat-header.ts
// and model-picker.ts. One system bar, the transcript scrolling under it:
// - `ChatTitle`: the bar's title, the socio's mascot and name, and under the
//   name the model the chat runs on with a chevron (ChatGPT's "ChatGPT 5 ⌄"):
//   the title is the model picker, which opens the `ChatModel` sheet. The model's
//   name is cut at its end, as the web's `truncate`; the sheet and the label keep
//   it whole. While a reply runs it can't be opened, as on the web; a new chat not
//   created yet has no picker. While the socio is paused the line says so first.
// - `useChatMenu`: the bar's "…" (`open`), with Save as page (a title prompt,
//   then `POST …/page` online only, then the page opens; not while a reply runs,
//   as on the web) and Schedule a task, which opens the chat on the web (8.9:
//   the app makes no tasks): the web's two socio bar buttons, in its menu.
// - `useModelOptions`: the person's model choices, read once per chat screen and
//   kept in the scope's view state so the picker reads offline too.

/** The socio's mascot in the chat's bar, in points. */
const SOCIO_SIZE = 30;

export function ChatTitle(props: {
    chatId: string;
    socio: string | null;
    character: LocalId;
    status: string;
    paused: boolean;
    value: ModelChoice | null | undefined;
    dotDefault: ModelChoice | null | undefined;
    models: ModelOptions | null;
    /** A reply is still being written: the picker can't be opened (the web's). */
    running: boolean;
    /** Opens the model sheet (the screen's navigation: the bar's title sits outside its screen). */
    onPick: () => void;
}) {
    const { width } = useWindowDimensions();
    const picker = modelPickerView({ value: props.value, dotDefault: props.dotDefault, models: props.models });
    const trigger = modelTrigger({ local: isLocalChat(props.chatId), running: props.running });
    const line = props.paused ? `${props.status} · ${picker.label}` : picker.label;
    return (
        <Pressable
            testID="chat-model-picker"
            accessibilityRole="button"
            accessibilityLabel={`${socioLineLabel(props.socio, props.status)}. ${picker.accessibilityLabel}`}
            accessibilityHint={trigger.hint}
            accessibilityState={{ disabled: trigger.disabled }}
            disabled={trigger.disabled}
            onPress={props.onPick}
            // Back and the bar's buttons take the rest; iOS centers the title between them.
            style={{ maxWidth: width - 150 }}
            className="flex-row items-center gap-2 rounded-full px-1 active:opacity-60"
        >
            <View testID="chat-socio">
                <LocalAvatar character={props.character} size={SOCIO_SIZE} />
            </View>
            <View className="min-w-0 shrink">
                <Text weight="semibold" numberOfLines={1}>
                    {props.socio ?? ''}
                </Text>
                <View className="flex-row items-center gap-0.5">
                    <Text
                        variant="footnote"
                        tone="muted"
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        className="shrink"
                        testID="chat-socio-status"
                    >
                        {line}
                    </Text>
                    {trigger.chevron ? <AppSymbol name="chevron-down" size={12} color="muted-foreground" /> : null}
                </View>
            </View>
        </Pressable>
    );
}

/** The person's model choices: the kept ones at once, then the server's once it answers. */
export function useModelOptions(): ModelOptions | null {
    const scope = useWorkspaceScope();
    const viewState = useViewState();
    const [options, setOptions] = useState(() => keptModelOptions(viewState.get(MODEL_OPTIONS_KEY)));
    useEffect(() => {
        let live = true;
        scope
            .fetch(MODEL_OPTIONS_PATH)
            .then((response) => readAnswer(response))
            .then((answer) => {
                const read = answer.status === 200 ? parseModelOptions(answer.body) : null;
                if (live && read !== null) {
                    setOptions(read);
                    viewState.set(MODEL_OPTIONS_KEY, JSON.stringify(read));
                }
            })
            .catch(() => {
                // Offline or away: the kept choices stay.
            });
        return () => {
            live = false;
        };
    }, [scope, viewState]);
    return options;
}

/**
 * The bar's "…" (`menu`, the native menu its button opens; null on a new chat not created yet): Save as page and
 * Schedule a task; `overlay` (the title prompt and the outcome's toast) goes at
 * the end of the screen, so the toast sits at its bottom.
 */
export function useChatMenu(
    id: string,
    title: string,
    running: boolean,
): { menu: MenuRequest | null; overlay: ReactNode; savePage: () => void; schedule: () => void } {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const { reconnecting } = useSyncStatus();
    const openLink = useOpenLink();
    const [saving, setSaving] = useState(false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const actions = chatMenu(isLocalChat(id), running);
    const savePage = () => setSaving(true);
    const schedule = () => openLink(scheduleTaskHref(id));
    // Gives back why the title can't be saved: the prompt says it and asks again (TextPrompt).
    const save = (text: string): Promise<string | undefined> | string => {
        if (savedPageTitle(text) === null) {
            return SAVE_CHAT_PAGE_COPY.invalid;
        }
        setBusy(true);
        return online(reconnecting)
            .then((connected) => saveChatAsPage({ fetch: scope.fetch, connected }, { threadId: id, title: text }))
            .then(
                (result) => {
                    if (result.outcome === 'done') {
                        setSaving(false);
                        navigation.dispatch(pageAction(result.spaceId, result.pageId));
                        return undefined;
                    }
                    if (result.outcome === 'invalid') {
                        return SAVE_CHAT_PAGE_COPY.invalid;
                    }
                    setSaving(false);
                    // The toast says it, to screen readers too.
                    setNotice(SAVE_CHAT_PAGE_COPY[result.outcome]);
                    return undefined;
                },
                (cause: unknown) => {
                    console.warn('[chat] not saved as a page', cause);
                    return SAVE_CHAT_PAGE_COPY.failed;
                },
            )
            .finally(() => setBusy(false));
    };
    // The bar's ⋯ is a native menu (CB-421): a UIMenu from the bar button on iOS, Material's popup on Android.
    const menu: MenuRequest | null =
        actions.length === 0
            ? null
            : {
                  actions,
                  onAction: (name) => {
                      if (name === 'save-page') {
                          savePage();
                      } else if (name === 'schedule') {
                          schedule();
                      }
                  },
              };
    const overlay = (
        <>
            {saving ? (
                <TextPrompt
                    title={SAVE_PAGE_TITLE}
                    label={SAVE_PAGE_LABEL}
                    initial={title}
                    maxLength={PAGE_TITLE_MAX}
                    canSave={(text) => !busy && !running && text.trim() !== ''}
                    onCancel={() => setSaving(false)}
                    onSave={save}
                    testID="chat-save-page"
                />
            ) : null}
            {notice === null ? null : <UndoToast key={notice} text={notice} onHide={() => setNotice(null)} />}
        </>
    );
    return { menu, overlay, savePage, schedule };
}
