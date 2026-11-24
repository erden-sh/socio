import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { Fragment } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MODEL_SHEET_TITLE, modelPickerView } from '../chat/model-picker';
import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { randomId } from '../platform/crypto';
import { sociosQuery } from '../shell/queries';
import { setChatModel } from '../sync/chat-manage';
import { AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';

import { useModelOptions } from './chat-header';
import { useShownChats } from './shown-chats';

// A chat's model picker (the web's ModelPicker; ChatGPT's at the top of a
// chat): a sheet over the chat, with no path, from the socio bar's model. The
// socio's default first ("Automatic: …" or "Socio default: …"), then the
// person's choices by where they run, the one in use checked, one they can't
// run on now disabled ("not connected"). A pick is the chat's `inference`
// through the outbox (`setChatModel`, `PATCH /api/conversations/:id`, the
// web's write), shown at once, offline too; a refused one shows on Chats with
// Retry and Discard. Its root is the ScrollView (iOS takes the first one as the sheet's).

export function ChatModelScreen({ route }: StaticScreenProps<{ id: string }>) {
    return useHasWorkspaceScope() ? <ChatModel id={route.params.id} /> : null;
}

function ChatModel({ id }: { id: string }) {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const { outbox } = useWorkspaceScope();
    const collections = useCollections();
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const chats = useShownChats();
    const models = useModelOptions();
    const chat = chats.find((known) => known.id === id);
    const dot = dots.find((known) => known.id === chat?.dotId);
    const view = modelPickerView({ value: chat?.inference, dotDefault: dot?.inference, models });
    return (
        <ScrollView
            testID="chat-model"
            className="bg-sheet"
            contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 8 }}
        >
            <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                {MODEL_SHEET_TITLE}
            </Text>
            <View className="rounded-xl border border-border bg-card" accessibilityRole="radiogroup">
                {view.rows.map((row, index) => (
                    <Fragment key={row.key}>
                        {row.group !== null && row.group !== view.rows[index - 1]?.group ? (
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
                            testID={`chat-model-${row.key}`}
                            accessibilityRole="radio"
                            accessibilityLabel={row.accessibilityLabel}
                            accessibilityState={{ checked: row.checked, disabled: row.disabled }}
                            disabled={row.disabled}
                            onPress={() => {
                                if (!row.checked && chat !== undefined) {
                                    setChatModel(outbox, {
                                        threadId: id,
                                        inference: row.choice,
                                        newId: randomId,
                                    }).catch((error: unknown) => console.warn('[chat] the model was not saved', error));
                                }
                                navigation.goBack();
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
            {view.note === null ? null : (
                <Text variant="footnote" tone="muted" testID="chat-model-note">
                    {view.note}
                </Text>
            )}
        </ScrollView>
    );
}
