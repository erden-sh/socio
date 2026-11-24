import { type ReactNode, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { EditorSession, EditorView } from '../editor/session';
import {
    FORMAT_BUTTONS,
    HISTORY_BUTTONS,
    LINK_PROMPT_EDIT_TITLE,
    LINK_PROMPT_LABEL,
    LINK_PROMPT_TITLE,
    LINK_REMOVE,
    linkInput,
    PASTE_IMAGE_BUTTON,
    linkSaveEnabled,
    type ToolbarAction,
    toolbarButtons,
    type ToolbarButtonView,
} from '../editor/toolbar';
import { AppSymbol } from '../ui';
import { cx } from '../ui/cx';
import type { SymbolName } from '../ui/symbols';

import { TextPrompt } from './action-menu';
import { useTapHaptic } from './chat-composer';

// The page editor's toolbar: the web's formatting
// buttons as the keyboard's accessory bar (CB-417; the owner, 2026-11-18:
// Apple Notes): in keyboard-controller's KeyboardStickyView, flush on the
// keyboard, the screen's full width, thin, in the system keyboard toolbar's
// look (the muted surface, a hairline above, no floating capsule). The screen
// shows it only while the keyboard is up, so the page fills the screen
// otherwise. Each button is a 44 pt target with its label for screen readers
// and its on state (`toolbarButtons`, from the WebView's `socio-state`), and
// ticks with a selection haptic (the Haptics setting). The formatting row
// scrolls sideways; Undo and Redo stay at its end. Link opens the text prompt
// with the web's rule (`linkInput`): a web address or a workspace page, written
// as `/#/spaces/…`; Remove link when the selection has one. The screen keeps the prompt
// (`useLinkPrompt`): it takes or hides the keyboard, and with it this toolbar.
//
// The screen gives the editor's body room above it: `onHeight` reports the
// bar's height, which the screen's KeyboardAvoidingView adds to the keyboard's.

/** Every command's icon, the toolbar's and the rest of the bridge's (a new command needs one). */
const ICONS: Record<ToolbarAction, SymbolName> = {
    bold: 'bold',
    italic: 'italic',
    strike: 'strikethrough',
    code: 'code',
    paragraph: 'pilcrow',
    heading1: 'heading-1',
    heading2: 'heading-2',
    heading3: 'heading-3',
    bulletList: 'list',
    orderedList: 'list-ordered',
    taskList: 'list-todo',
    blockquote: 'quote',
    codeBlock: 'code-xml',
    link: 'link-2',
    pasteImage: 'image-plus',
    undo: 'undo-2',
    redo: 'redo-2',
};

export function EditorToolbar(props: {
    session: EditorSession;
    view: EditorView;
    onHeight: (height: number) => void;
    /** Paste image, on a page's editor: on while the clipboard holds an image. */
    pasteImage?: { readonly enabled: boolean; readonly onPress: () => void };
    /** Link: the screen's link prompt (`useLinkPrompt`), which outlives the toolbar. */
    onLink: (existing: string | null) => void;
}) {
    const { session, view, onHeight, pasteImage, onLink } = props;
    const insets = useSafeAreaInsets();
    const tick = useTapHaptic();
    // Off while the session would drop a command (a load out, a dead WebView): nothing tapped is lost.
    const ready = view.editable;
    const format = toolbarButtons(
        pasteImage === undefined ? FORMAT_BUTTONS : [...FORMAT_BUTTONS, PASTE_IMAGE_BUTTON],
        view.state,
        ready,
        pasteImage?.enabled ?? false,
    );
    const history = toolbarButtons(HISTORY_BUTTONS, view.state, ready);
    const existing = view.state?.link ?? null;

    const press = (action: ToolbarAction) => {
        tick();
        if (action === 'link') {
            onLink(existing);
            return;
        }
        if (action === 'pasteImage') {
            pasteImage?.onPress();
            return;
        }
        session.command(action);
    };
    return (
        <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
            <View
                className="flex-row items-center border-t border-border bg-muted"
                style={{ paddingLeft: insets.left + 4, paddingRight: insets.right + 4 }}
                onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
                testID="page-editor-toolbar"
            >
                <View accessibilityRole="toolbar" accessibilityLabel="Text formatting" className="flex-1">
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="always"
                        contentContainerClassName="flex-row items-center"
                    >
                        {format.map((button) => (
                            <ToolbarButton key={button.action} button={button} onPress={press} />
                        ))}
                    </ScrollView>
                </View>
                <View className="mx-1 h-6 w-px bg-border" />
                {history.map((button) => (
                    <ToolbarButton key={button.action} button={button} onPress={press} />
                ))}
            </View>
        </KeyboardStickyView>
    );
}

/**
 * The toolbar's link prompt, kept by the screen: the toolbar shows only while the keyboard is up,
 * and the prompt takes the keyboard (Android's dialog field) or hides it (iOS's alert), which would
 * take the toolbar and its prompt with it. `open` takes the selection's link as Link was tapped.
 */
export function useLinkPrompt(
    session: EditorSession,
    origin: string,
): { open: (existing: string | null) => void; element: ReactNode } {
    const [linking, setLinking] = useState<{ initial: string; existing: string | null } | null>(null);
    const existing = linking?.existing ?? null;
    const saveLink = (text: string) => {
        const input = linkInput(text, origin);
        if (input.kind === 'invalid') {
            // The prompt says it and asks again with the text kept (TextPrompt).
            return input.error;
        }
        session.link(input.kind === 'link' ? input.href : null);
        setLinking(null);
        return undefined;
    };
    const element = (
        <>
            {linking === null ? null : (
                <TextPrompt
                    title={existing === null ? LINK_PROMPT_TITLE : LINK_PROMPT_EDIT_TITLE}
                    label={LINK_PROMPT_LABEL}
                    initial={linking.initial}
                    maxLength={2048}
                    url
                    canSave={(text) => linkSaveEnabled(text, existing)}
                    {...(existing === null
                        ? {}
                        : {
                              extra: {
                                  label: LINK_REMOVE,
                                  onPress: () => {
                                      session.link(null);
                                      setLinking(null);
                                  },
                                  testID: 'page-editor-link-remove',
                              },
                          })}
                    onSave={saveLink}
                    onCancel={() => setLinking(null)}
                    testID="page-editor-link"
                />
            )}
        </>
    );
    return { open: (link) => setLinking({ initial: link ?? '', existing: link }), element };
}

function ToolbarButton({ button, onPress }: { button: ToolbarButtonView; onPress: (action: ToolbarAction) => void }) {
    return (
        <Pressable
            testID={`page-editor-tool-${button.action}`}
            accessibilityRole={button.toggle ? 'togglebutton' : 'button'}
            accessibilityLabel={button.label}
            accessibilityState={
                button.toggle ? { checked: button.active, disabled: button.disabled } : { disabled: button.disabled }
            }
            disabled={button.disabled}
            onPress={() => onPress(button.action)}
            className={cx(
                'size-11 items-center justify-center rounded-md active:bg-accent disabled:opacity-40',
                button.active && 'bg-accent',
            )}
        >
            <AppSymbol
                name={ICONS[button.action]}
                size={18}
                color={button.active ? 'foreground' : 'muted-foreground'}
            />
        </Pressable>
    );
}
