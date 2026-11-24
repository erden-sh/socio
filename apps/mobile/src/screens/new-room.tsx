import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MODULE_IDS } from '@socio/shared/modules';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { pageSheetTopInset } from '../navigation/presets';
import { isHandOff } from '../navigation/shell-actions';
import { inOwnTabAction } from '../navigation/tabs';
import { moduleEntry } from '../shell/modules';
import {
    ADD_PEOPLE,
    ADD_SOCIOS,
    canSubmitRoom,
    CREATE_ROOM,
    DISCARD_ROOM,
    DISCARD_ROOM_QUESTION,
    LEAD,
    NEW_ROOM_INTRO,
    NEW_ROOM_TITLE,
    newRoomAsks,
    PEOPLE_HINT,
    PEOPLE_LABEL,
    peopleNote,
    roomOpenDelay,
    PICKER_DONE,
    pickerRows,
    type PickerRow,
    ROOM_BLOCK_COPY,
    ROOM_NAME_LABEL,
    ROOM_NAME_MAX,
    ROOM_NAME_PLACEHOLDER,
    type RoomChip,
    roomChips,
    type RoomChoice,
    roomCreateCopy,
    roomPeopleChoices,
    roomSocios,
    SEARCH_PEOPLE,
    SEARCH_SOCIOS,
    SOCIOS_HINT,
    SOCIOS_LABEL,
    sociosNote,
    startSocios,
    toggleChoice,
} from '../shell/new-room';
import { shellQuery, shellRows, sociosQuery } from '../shell/queries';
import type { RoomPeopleOutcome } from '../sync/room-create';
import { AppSymbol, Button, Field, GroupedCard, keyboardScroll, SearchField, Text, ToneTile } from '../ui';
import { cx } from '../ui/cx';

import { useActionMenu } from './action-menu';
import { MODULE_ICONS } from './module-icons';
import { PersonAvatar, SocioMark } from './room-parts';
import { type RouteSheetContent, useRouteSheet } from './route-sheet';

// New room (CB-470): the NewRoom page sheet, from the Chats tab's compose menu
// and Home's Rooms. The web's create dialog on a phone, in New Space's frame
// (Cancel, the title and Create on top): the name, then the socios and the
// people, each a grouped section of chips with an Add row that opens its
// picker in a native sheet (search, several at a time, a check on each one
// chosen), as Messages' new group adds its people. Create is online only
// (src/sync/room-create.ts): offline it says why and sends nothing. Once the
// chat list holds the room, it opens in the Chats tab in this sheet's place.
// View model and words: src/shell/new-room.ts.

const CHAT = moduleEntry(MODULE_IDS.chat);

type Picking = 'socios' | 'people' | null;

export function NewRoomScreen() {
    return useHasWorkspaceScope() ? <NewRoom /> : null;
}

function NewRoom() {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const { roomCreate } = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { state } = shellRows(shell);
    const blocked = useSyncExternalStore(roomCreate.subscribe, () => roomCreate.blocked());
    const busy = useSyncExternalStore(roomCreate.subscribe, () => roomCreate.busy());
    const socios = roomSocios(dots);
    const [start] = useState(() => startSocios(dots, state));
    const [title, setTitle] = useState('');
    const [socioIds, setSocioIds] = useState<string[]>(start);
    const [userIds, setUserIds] = useState<string[]>([]);
    const [notice, setNotice] = useState<string | null>(null);
    const [picking, setPicking] = useState<Picking>(null);
    const [query, setQuery] = useState('');
    const [people, setPeople] = useState<RoomPeopleOutcome | null>(null);
    const peopleChoices = people?.kind === 'done' ? roomPeopleChoices(people.people) : [];
    const ask = useActionMenu();
    // Read the people one may invite as the form opens, and again as the connection comes back.
    const reading = people === null || (people.kind === 'blocked' && blocked === null);
    useEffect(() => {
        if (!reading) {
            return;
        }
        let live = true;
        roomCreate
            .people()
            .then((outcome) => {
                if (live) {
                    setPeople(outcome);
                }
            })
            .catch(() => {
                if (live) {
                    setPeople({ kind: 'no-answer' });
                }
            });
        return () => {
            live = false;
        };
    }, [reading, roomCreate]);
    // Something chosen: Cancel, the page sheet's swipe down and Back ask first;
    // Create, which hands the sheet over to the room, never does.
    usePreventRemove(newRoomAsks(title, socioIds, userIds, start), ({ data }) => {
        if (data.action.type === 'REPLACE' || isHandOff(data.action)) {
            navigation.dispatch(data.action);
            return;
        }
        ask.open({
            title: DISCARD_ROOM_QUESTION,
            actions: [DISCARD_ROOM],
            onAction: () => navigation.dispatch(data.action),
        });
    });
    // The keyboard goes as a picker opens, so iOS doesn't give the name its focus (and the
    // keyboard, over the form) back as the sheet closes.
    const openPicker = (kind: 'socios' | 'people') => {
        Keyboard.dismiss();
        setPicking(kind);
    };
    const closePicker = () => {
        setPicking(null);
        setQuery('');
    };
    useRouteSheet(
        picking === null
            ? null
            : pickerSheet({
                  kind: picking,
                  choices: picking === 'socios' ? socios : peopleChoices,
                  chosen: picking === 'socios' ? socioIds : userIds,
                  query,
                  onQuery: setQuery,
                  note:
                      picking === 'socios'
                          ? sociosNote(socios.length, pickerRows(socios, socioIds, query).length)
                          : peopleNote(people, pickerRows(peopleChoices, userIds, query).length, query),
                  onToggle: (id) =>
                      picking === 'socios'
                          ? setSocioIds((chosen) => toggleChoice(chosen, id))
                          : setUserIds((chosen) => toggleChoice(chosen, id)),
                  onClose: closePicker,
              }),
        closePicker,
    );
    const create = () => {
        setNotice(null);
        roomCreate
            .create({ title, socioIds, userIds })
            .then((outcome) => {
                if (outcome.kind === 'done') {
                    // The room, in the Chats tab, in this sheet's place: Back goes to the chat list. On
                    // Android only once the chat list under the sheet has drawn its new row (ROOM_OPEN_DELAY_MS).
                    setTimeout(
                        () => navigation.dispatch(inOwnTabAction('Chats', 'Chat', { id: outcome.room.id })),
                        roomOpenDelay(Platform.OS),
                    );
                    return;
                }
                setNotice(roomCreateCopy(outcome));
            })
            .catch((error: unknown) => {
                console.warn('[new-room] not created', error);
                setNotice(roomCreateCopy({ kind: 'refused', reason: 'error' }));
            });
    };
    const shown = notice ?? (blocked === null ? null : ROOM_BLOCK_COPY[blocked]);
    return (
        <View testID="new-room-screen" className="flex-1 bg-screen" collapsable={false}>
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
                        testID="new-room-cancel"
                    />
                    <Text accessibilityRole="header" numberOfLines={1} className="min-w-0 flex-1 text-center">
                        {NEW_ROOM_TITLE}
                    </Text>
                    <Button
                        label={CREATE_ROOM}
                        onPress={create}
                        disabled={!canSubmitRoom(title, socioIds, busy, blocked)}
                        busy={busy}
                        testID="new-room-submit"
                    />
                </View>
            </View>
            <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
                <ScrollView
                    className="flex-1"
                    contentContainerClassName="gap-5 p-4"
                    contentContainerStyle={{ paddingBottom: 16 + insets.bottom }}
                    {...keyboardScroll(Platform.OS)}
                    testID="new-room-scroll"
                >
                    <View className="flex-row items-center gap-3">
                        <ToneTile tone={CHAT.tone} icon={MODULE_ICONS[CHAT.icon]} />
                        <Text variant="subheadline" tone="muted" className="min-w-0 flex-1" testID="new-room-intro">
                            {NEW_ROOM_INTRO}
                        </Text>
                    </View>
                    {shown === null ? null : (
                        <Text tone="destructive" accessibilityLiveRegion="polite" testID="new-room-notice">
                            {shown}
                        </Text>
                    )}
                    <Field
                        label={ROOM_NAME_LABEL}
                        value={title}
                        onChangeText={setTitle}
                        placeholder={ROOM_NAME_PLACEHOLDER}
                        maxLength={ROOM_NAME_MAX}
                        autoFocus
                        editable={!busy}
                        returnKeyType="done"
                        testID="new-room-name"
                    />
                    <ChoiceSection
                        id="socios"
                        title={SOCIOS_LABEL}
                        hint={SOCIOS_HINT}
                        add={ADD_SOCIOS}
                        chips={roomChips(socios, socioIds, true)}
                        disabled={busy || socios.length === 0}
                        onAdd={() => openPicker('socios')}
                        onRemove={(id) => setSocioIds((chosen) => toggleChoice(chosen, id))}
                    />
                    <ChoiceSection
                        id="people"
                        title={PEOPLE_LABEL}
                        hint={PEOPLE_HINT}
                        add={ADD_PEOPLE}
                        chips={roomChips(peopleChoices, userIds)}
                        disabled={busy}
                        onAdd={() => openPicker('people')}
                        onRemove={(id) => setUserIds((chosen) => toggleChoice(chosen, id))}
                    />
                </ScrollView>
            </KeyboardAvoidingView>
        </View>
    );
}

/** A grouped section: its header, the chosen ones as chips, then the Add row that opens the picker. */
function ChoiceSection(props: {
    id: 'socios' | 'people';
    title: string;
    hint: string;
    add: string;
    chips: readonly RoomChip[];
    disabled: boolean;
    onAdd: () => void;
    onRemove: (id: string) => void;
}) {
    return (
        <View className="gap-1.5" testID={`new-room-${props.id}`}>
            <Text accessibilityRole="header" variant="section" className="px-1">
                {props.title}
            </Text>
            <GroupedCard>
                {props.chips.length === 0 ? null : (
                    <View className="flex-row flex-wrap gap-2 px-3 pt-3" testID={`new-room-${props.id}-chips`}>
                        {props.chips.map((chip) => (
                            <Chip key={chip.id} chip={chip} disabled={props.disabled} onRemove={props.onRemove} />
                        ))}
                    </View>
                )}
                <Pressable
                    testID={`new-room-add-${props.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={props.add}
                    accessibilityState={{ disabled: props.disabled }}
                    disabled={props.disabled}
                    onPress={props.onAdd}
                    className={cx(
                        'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent',
                        props.disabled && 'opacity-50',
                    )}
                >
                    <AppSymbol name="plus" size={18} color="primary" />
                    <Text className="min-w-0 flex-1" tone="primary">
                        {props.add}
                    </Text>
                </Pressable>
            </GroupedCard>
            <Text variant="footnote" tone="muted" className="px-1">
                {props.hint}
            </Text>
        </View>
    );
}

/** A chosen socio or person: its mark, its name ("lead" for the first socio) and a remove button. */
function Chip(props: { chip: RoomChip; disabled: boolean; onRemove: (id: string) => void }) {
    const { chip } = props;
    return (
        <View
            testID={`new-room-chip-${chip.id}`}
            className="flex-row items-center gap-1.5 rounded-full bg-accent py-1 pr-1 pl-1"
        >
            <Mark choice={chip} size={24} />
            <Text variant="subheadline" numberOfLines={1} className="max-w-40">
                {chip.name}
            </Text>
            {chip.lead ? (
                <Text variant="footnote" tone="muted">
                    {LEAD}
                </Text>
            ) : null}
            <Pressable
                testID={`new-room-remove-${chip.id}`}
                accessibilityRole="button"
                accessibilityLabel={chip.removeLabel}
                disabled={props.disabled}
                hitSlop={8}
                onPress={() => props.onRemove(chip.id)}
                className="size-6 items-center justify-center rounded-full active:bg-border"
            >
                <AppSymbol name="x" size={14} color="muted-foreground" />
            </Pressable>
        </View>
    );
}

function Mark({ choice, size }: { choice: RoomChoice; size: number }) {
    return (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {choice.character !== null ? <SocioMark character={choice.character} size={size} /> : null}
            {choice.person !== null ? <PersonAvatar mark={choice.person} size={size} /> : null}
        </View>
    );
}

/** A picker's native sheet (CB-421): search, then the choices, a check on each one chosen; Done closes it. */
function pickerSheet(props: {
    kind: 'socios' | 'people';
    choices: readonly RoomChoice[];
    chosen: readonly string[];
    query: string;
    onQuery: (query: string) => void;
    note: string | null;
    onToggle: (id: string) => void;
    onClose: () => void;
}): RouteSheetContent {
    const socios = props.kind === 'socios';
    const rows = pickerRows(props.choices, props.chosen, props.query, socios);
    return {
        testID: `new-room-${props.kind}-sheet`,
        title: socios ? ADD_SOCIOS : ADD_PEOPLE,
        subtitle: props.chosen.length === 0 ? undefined : `${props.chosen.length} chosen`,
        tall: true,
        actions: <Button label={PICKER_DONE} onPress={props.onClose} testID={`new-room-${props.kind}-done`} />,
        body: (
            <>
                <SearchField
                    label={socios ? SEARCH_SOCIOS : SEARCH_PEOPLE}
                    value={props.query}
                    onChangeText={props.onQuery}
                    testID={`new-room-${props.kind}-search`}
                />
                {rows.length === 0 ? null : (
                    <View accessibilityRole="list">
                        <GroupedCard>
                            {rows.map((row, index) => (
                                <PickerRowView
                                    key={row.id}
                                    row={row}
                                    first={index === 0}
                                    testID={`new-room-pick-${row.id}`}
                                    onToggle={props.onToggle}
                                />
                            ))}
                        </GroupedCard>
                    </View>
                )}
                {props.note === null ? null : (
                    <Text variant="subheadline" tone="muted" testID={`new-room-${props.kind}-note`}>
                        {props.note}
                    </Text>
                )}
            </>
        ),
    };
}

function PickerRowView(props: { row: PickerRow; first: boolean; testID: string; onToggle: (id: string) => void }) {
    const { row } = props;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="checkbox"
            accessibilityLabel={row.accessibilityLabel}
            accessibilityState={{ checked: row.checked }}
            onPress={() => props.onToggle(row.id)}
            className={cx(
                'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent',
                !props.first && 'border-t border-border',
            )}
        >
            <Mark choice={row} size={32} />
            <Text weight={row.checked ? 'medium' : 'normal'} numberOfLines={1} className="min-w-0 flex-1">
                {row.name}
            </Text>
            {row.lead ? (
                <Text variant="footnote" tone="muted">
                    {LEAD}
                </Text>
            ) : null}
            {row.checked ? <AppSymbol name="check" size={18} color="primary" /> : null}
        </Pressable>
    );
}
