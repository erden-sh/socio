import { MenuView } from '@react-native-menu/menu';
import {
    type ComponentProps,
    type ComponentType,
    type ReactElement,
    type ReactNode,
    useEffect,
    useRef,
    useState,
} from 'react';
import {
    AccessibilityInfo,
    type AccessibilityProps,
    ActionSheetIOS,
    Alert,
    Modal,
    Platform,
    Pressable,
    type StyleProp,
    TextInput,
    useWindowDimensions,
    View,
    type ViewStyle,
} from 'react-native';

import { CANCEL, COPY, DISCARD, type MenuAction, type NotSaved, RETRY, SAVE, TOAST_MS } from '../chat/long-press';
import { chosenAction, type MenuTrigger, nativeMenuItems } from '../shell/native-menu';
import {
    MATERIAL_DIALOG,
    nativePrompt,
    notBlank,
    PROMPT_AGAIN,
    type PromptButton,
    type PromptSave,
    promptButtons,
    promptSaveStep,
    refusalOf,
} from '../shell/text-prompt';
import { useColors, useScheme } from '../theme/scheme';
import { Button, GlassSurface, Text, textMetrics } from '../ui';

// The menus (CB-421, the owner's 2026-11-18 rule: each platform's own
// components). Every ⋯ and every long-press is `ActionMenu`, the system's
// menu through @react-native-menu/menu's MenuView, T3 Code's choice: on iOS a
// UIMenu pull-down from the button, or on a long-press a context menu with the
// row lifted as its preview, SF Symbols beside the items; on Android a Material
// popup menu at the button or row. Its items are the row's accessibility
// actions too (src/chat/long-press.ts, src/shell/native-menu.ts), so VoiceOver
// and TalkBack reach each without the gesture. Destructive items are red.
// `useActionMenu().open` is for an ask with no button to hang from (File an
// issue's "Keep draft?" on a swipe down): the system's action sheet on iOS, an
// alert on Android. The prompt (`TextPrompt`) is iOS's own Alert.prompt and a
// drawn Material 3 dialog on Android, which has no prompt, and the toast floats in GlassSurface above the tab
// bar, said by screen readers as it shows. Padding is even on every side.

export interface MenuRequest {
    readonly title?: string;
    readonly actions: readonly MenuAction[];
    readonly onAction: (name: string) => void;
}

/** Whether VoiceOver or TalkBack is on, followed as it changes. */
export function useScreenReader(): boolean {
    const [on, setOn] = useState(false);
    useEffect(() => {
        let live = true;
        AccessibilityInfo.isScreenReaderEnabled()
            .then((enabled) => {
                if (live) {
                    setOn(enabled);
                }
            })
            .catch(() => {});
        const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
        return () => {
            live = false;
            subscription.remove();
        };
    }, []);
    return on;
}

// MenuView is a native view: it takes a view's accessibility props too, which its types leave out.
const NativeMenu = MenuView as ComponentType<
    ComponentProps<typeof MenuView> &
        Pick<AccessibilityProps, 'accessible' | 'accessibilityRole' | 'accessibilityLabel' | 'accessibilityActions'> & {
            readonly onAccessibilityAction?: () => void;
        }
>;

/**
 * The system's menu on `children`. `press` (a ⋯, a field's button): a tap
 * opens it, and this is the button screen readers reach, with `label`; the
 * child only draws it. `longPress` (a row): a tap is still the row's, a hold
 * opens the menu with the row as its preview, and the row's own
 * accessibility actions stay (give it `LONG_PRESS_TO_MENU` as its
 * `onLongPress`, so a hold never ends in a tap). No request, or no actions,
 * draws the child alone.
 */
export function ActionMenu(props: {
    request: MenuRequest | null;
    trigger: MenuTrigger;
    /** The button's words for screen readers (`press`). */
    label?: string;
    testID?: string;
    disabled?: boolean;
    /** The menu view's layout in its parent (a row's `flex: 1`). */
    style?: StyleProp<ViewStyle>;
    children: ReactElement;
}) {
    const scheme = useScheme();
    const colors = useColors();
    const menu = useRef<{ show: () => void }>(null);
    const { request, trigger } = props;
    if (request === null || request.actions.length === 0 || props.disabled === true) {
        return props.children;
    }
    const longPress = trigger === 'longPress';
    const choose = (id: string | undefined) => {
        const action = chosenAction(request.actions, id);
        if (action !== null) {
            request.onAction(action.name);
        }
    };
    return (
        <NativeMenu
            ref={menu}
            actions={nativeMenuItems(request.actions, Platform.OS, {
                icon: colors.foreground,
                destructive: colors.destructive,
            })}
            {...(request.title === undefined ? {} : { title: request.title })}
            shouldOpenOnLongPress={longPress}
            {...(props.style === undefined ? {} : { style: props.style })}
            themeVariant={scheme}
            isAnchoredToRight={!longPress}
            onPressAction={({ nativeEvent }) => choose(nativeEvent.event)}
            {...(longPress
                ? {}
                : {
                      testID: props.testID,
                      accessible: true,
                      accessibilityRole: 'button' as const,
                      accessibilityLabel: props.label,
                      // TalkBack's double tap isn't the popup's touch: it opens it here.
                      ...(Platform.OS === 'android'
                          ? {
                                accessibilityActions: [{ name: 'activate' as const }],
                                onAccessibilityAction: () => menu.current?.show(),
                            }
                          : {}),
                  })}
        >
            {longPress ? (
                props.children
            ) : (
                <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                    {props.children}
                </View>
            )}
        </NativeMenu>
    );
}

/**
 * An ask with no button to hang a menu from: `open(request)` shows the
 * system's action sheet on iOS (in Liquid Glass on iOS 26) and an alert on
 * Android, its actions then Cancel. `element` is kept for the screens that
 * mount it; it draws nothing now.
 */
export function useActionMenu(): { open: (request: MenuRequest) => void; element: ReactNode } {
    const open = (next: MenuRequest) => {
        if (next.actions.length === 0) {
            return;
        }
        const pick = (action: MenuAction) => {
            if (action.disabled !== true) {
                next.onAction(action.name);
            }
        };
        if (Platform.OS === 'ios') {
            const options = [...next.actions.map((action) => action.label), CANCEL];
            const destructive = next.actions.flatMap((action, index) => (action.destructive === true ? [index] : []));
            const disabled = next.actions.flatMap((action, index) => (action.disabled === true ? [index] : []));
            ActionSheetIOS.showActionSheetWithOptions(
                {
                    options,
                    cancelButtonIndex: options.length - 1,
                    destructiveButtonIndex: destructive,
                    ...(disabled.length === 0 ? {} : { disabledButtonIndices: disabled }),
                    ...(next.title === undefined ? {} : { title: next.title }),
                },
                (index) => {
                    const action = next.actions[index];
                    if (action !== undefined) {
                        pick(action);
                    }
                },
            );
            return;
        }
        // Material's alert holds three buttons: Cancel and up to two actions.
        Alert.alert(next.title ?? '', undefined, [
            { text: CANCEL, style: 'cancel' },
            ...next.actions.slice(0, 2).map((action) => ({
                text: action.label,
                style: action.destructive === true ? ('destructive' as const) : ('default' as const),
                onPress: () => pick(action),
            })),
        ]);
    };
    return { open, element: null };
}

/** The prompt's props: the screen mounts it to ask, and unmounts it once Save took the text or on Cancel. */
export interface TextPromptProps {
    title: string;
    /** The field's name: Android's outlined field's label, and its name for screen readers. */
    label: string;
    initial: string;
    maxLength: number;
    /** A web address (the page editor's link prompt): the URL keyboard, no capitals or corrections. */
    url?: boolean;
    /** A third action beside Cancel and Save (the link prompt's Remove link). */
    extra?: { label: string; onPress: () => void; testID?: string };
    /** Whether Save takes the text; by default anything but blank. */
    canSave?: (text: string) => boolean;
    /** Saves the text; gives back why not (the app's check or the server's), and the prompt says it. */
    onSave: PromptSave;
    onCancel: () => void;
    /** Android's dialog, its field `-input` and its Save `-save`, for Maestro. */
    testID?: string;
}

/**
 * A one-field prompt (rename, a title, a link; the owner, 2026-11-19): iOS's own `Alert.prompt`,
 * and on Android, which has none, a drawn Material 3 dialog (src/shell/text-prompt.ts).
 */
export function TextPrompt(props: TextPromptProps) {
    return nativePrompt(Platform.OS) ? <IosPrompt {...props} /> : <MaterialPrompt {...props} />;
}

/**
 * iOS's prompt, shown as it mounts. Save with text it can't take asks again with the text kept; a
 * refusal is said in an alert whose OK asks again with what was typed.
 */
function IosPrompt(props: TextPromptProps) {
    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });
    useEffect(() => {
        let live = true;
        const ask = (value: string) => {
            if (!live) {
                return;
            }
            const current = latest.current;
            Alert.prompt(
                current.title,
                undefined,
                promptButtons(current.extra?.label).map((button) => ({
                    text: button.text,
                    style: button.style,
                    onPress: (text?: string) => press(button.does, text ?? ''),
                })),
                'plain-text',
                value,
                current.url === true ? 'url' : 'default',
            );
        };
        const refuse = (reason: string, value: string) => {
            if (live) {
                Alert.alert(reason, undefined, [{ text: PROMPT_AGAIN, onPress: () => ask(value) }]);
            }
        };
        const press = (does: PromptButton['does'], text: string) => {
            const current = latest.current;
            if (does === 'cancel') {
                current.onCancel();
                return;
            }
            if (does === 'extra') {
                current.extra?.onPress();
                return;
            }
            const step = promptSaveStep(text, current);
            if (step.kind === 'again') {
                ask(text);
                return;
            }
            if (step.kind === 'refuse') {
                refuse(step.reason, text);
                return;
            }
            Promise.resolve(current.onSave(text)).then(
                (outcome) => {
                    const reason = refusalOf(outcome);
                    if (reason !== null) {
                        refuse(reason, text);
                    }
                },
                (error: unknown) => console.warn('[prompt] not saved', error),
            );
        };
        ask(latest.current.initial);
        return () => {
            live = false;
        };
    }, []);
    return null;
}

/**
 * Android's prompt, Material 3's dialog: the headline, an outlined field with its label in the
 * outline, the refusal as its supporting text, and text buttons at the end.
 */
function MaterialPrompt(props: TextPromptProps) {
    const [text, setText] = useState(props.initial);
    const [error, setError] = useState<string | undefined>(undefined);
    const [saving, setSaving] = useState(false);
    const savable = !saving && (props.canSave ?? notBlank)(text);
    const save = () => {
        if (!savable) {
            return;
        }
        setError(undefined);
        setSaving(true);
        Promise.resolve(props.onSave(text))
            .then(
                (outcome) => {
                    const reason = refusalOf(outcome);
                    if (reason !== null) {
                        setError(reason);
                    }
                },
                (cause: unknown) => console.warn('[prompt] not saved', cause),
            )
            .finally(() => setSaving(false));
    };
    return (
        <Modal transparent visible animationType="fade" onRequestClose={props.onCancel} statusBarTranslucent>
            <View className="flex-1 items-center justify-center bg-black/40 p-12">
                <View
                    testID={props.testID}
                    className="w-full bg-popover"
                    style={{
                        borderRadius: MATERIAL_DIALOG.radius,
                        padding: MATERIAL_DIALOG.padding,
                        minWidth: MATERIAL_DIALOG.minWidth,
                        maxWidth: MATERIAL_DIALOG.maxWidth,
                        gap: MATERIAL_DIALOG.titleGap,
                    }}
                >
                    <Text accessibilityRole="header" variant="title1">
                        {props.title}
                    </Text>
                    <OutlinedField
                        label={props.label}
                        value={text}
                        onChangeText={(value) => {
                            setText(value);
                            setError(undefined);
                        }}
                        maxLength={props.maxLength}
                        onSubmitEditing={save}
                        url={props.url === true}
                        {...(error === undefined ? {} : { error })}
                        {...(props.testID === undefined ? {} : { testID: `${props.testID}-input` })}
                    />
                    <View
                        className="flex-row flex-wrap items-center justify-end"
                        style={{
                            gap: MATERIAL_DIALOG.buttonGap,
                            marginTop: MATERIAL_DIALOG.actionsGap - MATERIAL_DIALOG.titleGap,
                        }}
                    >
                        {props.extra === undefined ? null : (
                            <MaterialTextButton
                                label={props.extra.label}
                                onPress={props.extra.onPress}
                                {...(props.extra.testID === undefined ? {} : { testID: props.extra.testID })}
                            />
                        )}
                        <MaterialTextButton label={CANCEL} onPress={props.onCancel} />
                        <MaterialTextButton
                            label={SAVE}
                            onPress={save}
                            disabled={!savable}
                            {...(props.testID === undefined ? {} : { testID: `${props.testID}-save` })}
                        />
                    </View>
                </View>
            </View>
        </Modal>
    );
}

/** Material 3's outlined text field: the label in a gap of the outline, the outline primary while focused. */
function OutlinedField(props: {
    label: string;
    value: string;
    onChangeText: (text: string) => void;
    maxLength: number;
    onSubmitEditing: () => void;
    url: boolean;
    error?: string;
    testID?: string;
}) {
    const [focused, setFocused] = useState(true);
    const colors = useColors();
    const { fontScale } = useWindowDimensions();
    const invalid = props.error !== undefined;
    const color = invalid ? colors.destructive : focused ? colors.primary : colors['muted-foreground'];
    return (
        <View className="gap-1">
            <View
                style={{
                    borderRadius: MATERIAL_DIALOG.fieldRadius,
                    borderWidth: focused || invalid ? MATERIAL_DIALOG.outlineFocused : MATERIAL_DIALOG.outline,
                    borderColor: color,
                    minHeight: MATERIAL_DIALOG.fieldHeight,
                    justifyContent: 'center',
                }}
            >
                <TextInput
                    value={props.value}
                    onChangeText={props.onChangeText}
                    maxLength={props.maxLength}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={props.onSubmitEditing}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    accessibilityLabel={props.label}
                    accessibilityHint={props.error}
                    {...(props.url
                        ? { keyboardType: 'url' as const, autoCapitalize: 'none' as const, autoCorrect: false }
                        : {})}
                    testID={props.testID}
                    className="px-4 py-3 text-foreground"
                    style={textMetrics('body', fontScale, Platform.OS)}
                    cursorColorClassName="accent-primary"
                    selectionColorClassName="accent-primary"
                    selectionHandleColorClassName="accent-primary"
                />
                <View
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    className="absolute bg-popover px-1"
                    style={{ top: -9, left: 12 }}
                >
                    <Text variant="footnote" style={{ color }}>
                        {props.label}
                    </Text>
                </View>
            </View>
            {props.error === undefined ? null : (
                <Text
                    variant="footnote"
                    tone="destructive"
                    className="px-4"
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                >
                    {props.error}
                </Text>
            )}
        </View>
    );
}

/** Material 3's text button: the label in the primary color, 40 dp tall, a ripple on its rounded shape. */
function MaterialTextButton(props: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ disabled: props.disabled === true }}
            disabled={props.disabled}
            onPress={props.onPress}
            android_ripple={{ borderless: false }}
            className="items-center justify-center overflow-hidden rounded-full px-3 disabled:opacity-40"
            style={{ minHeight: MATERIAL_DIALOG.buttonHeight }}
        >
            <Text weight="medium" tone="primary">
                {props.label}
            </Text>
        </Pressable>
    );
}

/**
 * A line with one action at the bottom of the screen for TOAST_MS ("Chat archived" · Undo), or with
 * none ("Saved to your Files" from a Space's page menus).
 */
export function UndoToast(props: { text: string; action?: string; onAction?: () => void; onHide: () => void }) {
    const { text, onHide } = props;
    useEffect(() => {
        AccessibilityInfo.announceForAccessibility(text);
        const timer = setTimeout(onHide, TOAST_MS);
        return () => clearTimeout(timer);
    }, [text, onHide]);
    return (
        <View pointerEvents="box-none" className="absolute right-0 bottom-0 left-0 p-4">
            <GlassSurface
                testID="undo-toast"
                radius={16}
                fallbackClassName="border border-border bg-card"
                className="flex-row items-center gap-3 p-3"
            >
                <Text className="flex-1 px-1" accessibilityLiveRegion="polite">
                    {text}
                </Text>
                {props.action === undefined || props.onAction === undefined ? null : (
                    <Button
                        label={props.action}
                        variant="secondary"
                        onPress={props.onAction}
                        testID="undo-toast-action"
                    />
                )}
            </GlassSurface>
        </View>
    );
}

/**
 * A refused change (a rename, archive, delete or reaction the server
 * wouldn't take), until the person retries or discards it; the oldest
 * first, one at a time. The screen places it: above the chat list's tab bar,
 * above a chat's composer (no tab bar under a chat, CB-491).
 */
export function NotSavedNotice(props: {
    item: NotSaved;
    onRetry: (id: string) => void;
    onDiscard: (id: string) => void;
    /** Copy what the person wrote (a page made on the phone); absent, there is no Copy. */
    onCopy?: (id: string) => void;
    testID: string;
}) {
    const { item, onCopy } = props;
    useEffect(() => {
        AccessibilityInfo.announceForAccessibility(item.text);
    }, [item.text]);
    return (
        <GlassSurface
            testID={props.testID}
            radius={16}
            fallbackClassName="border border-border bg-card"
            className="flex-row items-center gap-3 p-3"
        >
            <Text className="flex-1 px-1" accessibilityLiveRegion="polite">
                {item.text}
            </Text>
            <Button
                label={DISCARD}
                variant="ghost"
                onPress={() => props.onDiscard(item.id)}
                testID={`${props.testID}-discard`}
            />
            {onCopy === undefined ? null : (
                <Button
                    label={COPY.label}
                    variant="ghost"
                    onPress={() => onCopy(item.id)}
                    testID={`${props.testID}-copy`}
                />
            )}
            <Button
                label={RETRY}
                variant="secondary"
                onPress={() => props.onRetry(item.id)}
                testID={`${props.testID}-retry`}
            />
        </GlassSurface>
    );
}
