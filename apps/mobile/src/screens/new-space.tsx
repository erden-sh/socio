import { StackActions, useNavigation, usePreventRemove } from '@react-navigation/native';
import { useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, type TextInputInstance, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MODULE_IDS } from '@socio/shared/modules';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { pageSheetTopInset } from '../navigation/presets';
import { isHandOff } from '../navigation/shell-actions';
import { moduleEntry } from '../shell/modules';
import {
    AUDIENCE_LEGEND,
    audienceChoices,
    canSubmitSpace,
    CREATE_ACTION,
    DISCARD_SPACE,
    DISCARD_SPACE_QUESTION,
    DESCRIPTION_LABEL,
    NAME_LABEL,
    NEW_SPACE_TITLE,
    newSpaceAsks,
    newSpaceStart,
    SPACE_BLOCK_COPY,
    SPACE_DESCRIPTION_MAX,
    SPACE_NAME_MAX,
    spaceCreateCopy,
} from '../shell/new-space';
import { shellQuery, shellRows } from '../shell/queries';
import { Button, Field, AppSymbol, keyboardScroll, Text, ToneTile } from '../ui';
import { cx } from '../ui/cx';

import { useActionMenu } from './action-menu';
import { MODULE_ICONS } from './module-icons';

// New Space (CB-410): the NewSpace modal, from the Spaces list's New Space
// (shown only to whom the server's `permissions.createSpaces` lets in). The
// web's create dialog on a phone, in FileIssue's frame (Cancel, the title and
// Create on top): Name, "What belongs here?" and "Who can see it", the web's
// two radio cards. Create is online only (src/sync/space-create.ts): offline
// it says why and sends nothing, so nothing waits that the server could refuse
// later. Once the Spaces list holds the new Space, it opens in this modal's
// place. View model and words: src/shell/new-space.ts.

const SPACES = moduleEntry(MODULE_IDS.spaces);

export function NewSpaceScreen() {
    return useHasWorkspaceScope() ? <NewSpace /> : null;
}

function NewSpace() {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const { spaceCreate } = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { workspace } = shellRows(shell);
    const blocked = useSyncExternalStore(spaceCreate.subscribe, () => spaceCreate.blocked());
    const busy = useSyncExternalStore(spaceCreate.subscribe, () => spaceCreate.busy());
    const [start] = useState(() => newSpaceStart(workspace));
    const admin = workspace === null ? start.admin : newSpaceStart(workspace).admin;
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [privateSpace, setPrivateSpace] = useState(start.private);
    const [notice, setNotice] = useState<string | null>(null);
    const descriptionField = useRef<TextInputInstance>(null);
    const ask = useActionMenu();
    // Something typed: Cancel, the page sheet's swipe down and Back ask first;
    // Create, which replaces the sheet with the Space, never does.
    usePreventRemove(newSpaceAsks(name, description), ({ data }) => {
        if (data.action.type === 'REPLACE' || isHandOff(data.action)) {
            navigation.dispatch(data.action);
            return;
        }
        ask.open({
            title: DISCARD_SPACE_QUESTION,
            actions: [DISCARD_SPACE],
            onAction: () => navigation.dispatch(data.action),
        });
    });
    // Anyone but an admin makes a private Space, whatever was chosen before the row came.
    const shut = admin ? privateSpace : true;
    const create = () => {
        setNotice(null);
        spaceCreate
            .create({ name, description, private: shut })
            .then((outcome) => {
                if (outcome.kind === 'done') {
                    // The new Space, in this modal's place: Back goes to the Spaces list.
                    navigation.dispatch(StackActions.replace('Space', { spaceId: outcome.space.id }));
                    return;
                }
                setNotice(spaceCreateCopy(outcome));
            })
            .catch((error: unknown) => {
                console.warn('[new-space] not created', error);
                setNotice(spaceCreateCopy({ kind: 'refused', reason: 'error' }));
            });
    };
    const shown = notice ?? (blocked === null ? null : SPACE_BLOCK_COPY[blocked]);
    return (
        <View testID="new-space-screen" className="flex-1 bg-screen" collapsable={false}>
            <View
                className="bg-header"
                style={{
                    paddingTop: pageSheetTopInset(Platform.OS, insets.top),
                    paddingLeft: insets.left,
                    paddingRight: insets.right,
                }}
            >
                <View className="h-16 flex-row items-center gap-2 px-4">
                    <Button
                        variant="ghost"
                        label="Cancel"
                        onPress={() => navigation.goBack()}
                        testID="new-space-cancel"
                    />
                    <Text accessibilityRole="header" numberOfLines={1} className="min-w-0 flex-1 text-center">
                        New Space
                    </Text>
                    <Button
                        label={CREATE_ACTION}
                        onPress={create}
                        disabled={!canSubmitSpace(name, busy, blocked)}
                        busy={busy}
                        testID="new-space-submit"
                    />
                </View>
            </View>
            <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
                <ScrollView
                    className="flex-1"
                    contentContainerClassName="gap-5 p-4"
                    contentContainerStyle={{ paddingBottom: 16 + insets.bottom }}
                    {...keyboardScroll(Platform.OS)}
                >
                    <View className="flex-row items-center gap-3">
                        <ToneTile tone={SPACES.tone} icon={MODULE_ICONS[SPACES.icon]} />
                        <Text variant="title" className="min-w-0 flex-1" testID="new-space-title">
                            {NEW_SPACE_TITLE}
                        </Text>
                    </View>
                    {shown === null ? null : (
                        <Text tone="destructive" accessibilityLiveRegion="polite" testID="new-space-notice">
                            {shown}
                        </Text>
                    )}
                    <Field
                        label={NAME_LABEL}
                        value={name}
                        onChangeText={setName}
                        maxLength={SPACE_NAME_MAX}
                        autoFocus
                        editable={!busy}
                        returnKeyType="next"
                        submitBehavior="submit"
                        onSubmitEditing={() => descriptionField.current?.focus()}
                        testID="new-space-name"
                    />
                    <Field
                        ref={descriptionField}
                        label={DESCRIPTION_LABEL}
                        value={description}
                        onChangeText={setDescription}
                        maxLength={SPACE_DESCRIPTION_MAX}
                        editable={!busy}
                        multiline
                        numberOfLines={4}
                        textAlignVertical="top"
                        testID="new-space-description"
                    />
                    <View className="gap-2" accessibilityRole="radiogroup" accessibilityLabel={AUDIENCE_LEGEND}>
                        <Text weight="medium" accessibilityElementsHidden importantForAccessibility="no">
                            {AUDIENCE_LEGEND}
                        </Text>
                        {audienceChoices(admin).map((choice) => {
                            const on = choice.private === shut;
                            const off = choice.disabled || busy;
                            return (
                                <Pressable
                                    key={choice.testID}
                                    testID={choice.testID}
                                    accessibilityRole="radio"
                                    accessibilityLabel={choice.title}
                                    accessibilityHint={choice.detail}
                                    accessibilityState={{ checked: on, disabled: off }}
                                    disabled={off}
                                    onPress={() => setPrivateSpace(choice.private)}
                                    className={cx(
                                        'flex-row items-start gap-3 rounded-lg border p-3',
                                        on ? 'border-primary/60 bg-accent/60' : 'border-border active:bg-accent/50',
                                        choice.disabled && 'opacity-60',
                                    )}
                                >
                                    <View
                                        className={cx(
                                            'mt-0.5 size-4 items-center justify-center rounded-full border',
                                            on ? 'border-primary' : 'border-input',
                                        )}
                                    >
                                        {on ? <View className="size-2 rounded-full bg-primary" /> : null}
                                    </View>
                                    <View className="min-w-0 flex-1 gap-0.5">
                                        <View className="flex-row items-center gap-1.5">
                                            <Text weight="medium">{choice.title}</Text>
                                            {choice.private ? (
                                                <AppSymbol name="lock" size={14} color="muted-foreground" />
                                            ) : null}
                                        </View>
                                        <Text variant="footnote" tone="muted">
                                            {choice.detail}
                                        </Text>
                                    </View>
                                </Pressable>
                            );
                        })}
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </View>
    );
}
