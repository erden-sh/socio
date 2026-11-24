import { type StaticScreenProps, useFocusEffect, useNavigation } from '@react-navigation/native';
import { type ReactNode, useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useSyncOnFocus, useWorkspaceScope } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { moreItemAction, newChatAction, scheduleAction, taskAction } from '../navigation/tabs';
import { NetworkError } from '../net/errors';
import { NEW_CHAT } from '../shell/first-run';
import { goalsQuery, schedulesQuery, shellQuery, shellRows, sociosQuery } from '../shell/queries';
import {
    SOCIO_ARCHIVED,
    SOCIO_START_CHAT,
    type SocioPageRow,
    type SocioPageSection,
    type SocioRuns,
    socioPage,
    socioStatusLine,
} from '../shell/socio';
import { SCHEDULES_KIND } from '../sync/kinds';
import { goalRow, scheduleRow } from '../sync/schedules';
import { readSocioRuns } from '../sync/socio-runs';
import { AppSymbol, Banner, GroupedCard, RowSeparator, Screen, Text } from '../ui';
import { rowMinHeight } from '../ui/type-scale';

import { Disclosure } from './platform-symbol';
import { SocioAvatar, SocioStateLabel, StatusBanners, useOpenChat } from './shell-parts';
import { useShownChats } from './shown-chats';

// A socio's page (CB-431; the web's DotHome at `/dots/:dotId`), opened from a
// socio row on Home and from links: Contacts' and Settings' shape, built from
// the platform's parts. Its avatar, name, status (what it is doing now, in the
// system font with its dot) and description head the page; then an inset
// grouped list: Start a chat (also the bar's compose button), Now (its turns
// and tasks running), Chats and Archived chats, Scheduled (goals and schedules
// with their next runs) and Recent turns, each row with its disclosure chevron
// to the chat, schedule or task it names (src/shell/socio.ts). The name comes
// into the inline bar as it scrolls under it (Contacts').

const SYNCED = ['shell', 'conversations', 'dots', ...SCHEDULES_KIND.collections] as const;

/** The avatar at the page's head, in points (Contacts' header photo). */
const HEAD_AVATAR = 88;

export function SocioScreen({ route }: StaticScreenProps<{ socioId: string }>) {
    return useHasWorkspaceScope() ? <SocioPage socioId={route.params.socioId} /> : null;
}

/** The socio's turns, read as the page comes into view (online only, never kept). */
function useSocioRuns(socioId: string): SocioRuns {
    const scope = useWorkspaceScope();
    const [runs, setRuns] = useState<{ socioId: string; value: SocioRuns }>({
        socioId,
        value: { kind: 'loading' },
    });
    useFocusEffect(
        useCallback(() => {
            const controller = new AbortController();
            readSocioRuns(scope.fetch, socioId, controller.signal).then(
                (list) => {
                    if (!controller.signal.aborted) {
                        setRuns({ socioId, value: { kind: 'ok', runs: list } });
                    }
                },
                (error: unknown) => {
                    if (!controller.signal.aborted) {
                        // A read that failed keeps the turns it showed.
                        setRuns((current) =>
                            current.socioId === socioId && current.value.kind === 'ok'
                                ? current
                                : { socioId, value: { kind: error instanceof NetworkError ? 'offline' : 'failed' } },
                        );
                    }
                },
            );
            return () => controller.abort();
        }, [scope, socioId]),
    );
    return runs.socioId === socioId ? runs.value : { kind: 'loading' };
}

function SocioPage({ socioId }: { socioId: string }) {
    const navigation = useNavigation();
    const collections = useCollections();
    useSyncOnFocus(SYNCED);
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { data: scheduleData } = useLiveQuery({ query: schedulesQuery(collections) });
    const { data: goalData } = useLiveQuery({ query: goalsQuery(collections) });
    const chats = useShownChats();
    const runs = useSocioRuns(socioId);
    const [expanded, setExpanded] = useState<ReadonlySet<'chats' | 'archived'>>(new Set());
    const [nameGone, setNameGone] = useState(false);
    const { state } = shellRows(shell);
    const view = socioPage({
        socioId,
        dots,
        state,
        chats,
        runs,
        schedules: scheduleData.map((row) => scheduleRow(row.id, row)),
        goals: goalData.map((row) => goalRow(row.id, row)),
        expanded,
        now: Date.now(),
    });
    const startChat = () => navigation.dispatch(newChatAction(socioId));
    useNativeBar({
        // The name comes into the bar once the head's has scrolled under it.
        title: nameGone && view !== null ? view.name : '',
        right:
            view === null || view.archived
                ? []
                : [
                      {
                          id: 'socio-new-chat',
                          label: NEW_CHAT,
                          symbol: 'square.and.pencil',
                          icon: 'square-pen',
                          iconOnly: true,
                          onPress: startChat,
                      },
                  ],
    });
    const openChat = useOpenChat();
    const open = (row: SocioPageRow) => {
        const target = row.target;
        switch (target?.kind) {
            case 'chat':
                openChat({ id: target.id, room: target.room });
                return;
            case 'schedule':
                navigation.dispatch(scheduleAction(target.id));
                return;
            case 'task':
                navigation.dispatch(taskAction(target.id));
                return;
            case 'schedules':
                navigation.dispatch(moreItemAction(MODULE_IDS.schedules, 'Schedules'));
                return;
            case 'runs':
                navigation.dispatch(moreItemAction(MODULE_IDS.runs, 'Runs'));
                return;
            default:
                return;
        }
    };
    if (view === null) {
        return (
            <View testID="socio-screen" className="flex-1 bg-screen" collapsable={false}>
                <Screen edges={['right', 'bottom', 'left']}>
                    <Text variant="subheadline" tone="muted" testID="socio-missing">
                        This socio isn’t here. It may have been archived for you, or it isn’t yours.
                    </Text>
                </Screen>
            </View>
        );
    }
    return (
        <View testID="socio-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} grouped onScrollY={(y) => setNameGone(y > HEAD_AVATAR + 40)}>
                <StatusBanners />
                <View
                    className="items-center gap-2"
                    accessible
                    accessibilityLabel={view.accessibilityLabel}
                    testID="socio-head"
                >
                    <SocioAvatar character={view.character} size={HEAD_AVATAR} />
                    <Text accessibilityRole="header" variant="title" className="text-center" testID="socio-name">
                        {view.name}
                    </Text>
                    <View testID="socio-status">
                        <SocioStateLabel state={view.state} label={socioStatusLine(view)} />
                    </View>
                    <Text
                        variant="subheadline"
                        tone="muted"
                        className="text-center"
                        numberOfLines={4}
                        testID="socio-description"
                    >
                        {view.description}
                    </Text>
                </View>
                {view.archived ? (
                    <Banner tone="warning" testID="socio-archived">
                        {SOCIO_ARCHIVED}
                    </Banner>
                ) : (
                    <Group>
                        <Pressable
                            testID="socio-start-chat"
                            accessibilityRole="button"
                            accessibilityLabel={`${SOCIO_START_CHAT} with ${view.name}`}
                            onPress={startChat}
                            className="flex-row items-center gap-3 px-4 active:bg-accent"
                            style={rowMinHeight(44)}
                        >
                            <AppSymbol name="square-pen" size={20} color="primary" />
                            <Text tone="primary" className="min-w-0 flex-1">
                                {SOCIO_START_CHAT}
                            </Text>
                        </Pressable>
                    </Group>
                )}
                {view.sections.map((section) => (
                    <SectionGroup
                        key={section.id}
                        section={section}
                        onOpen={open}
                        onShowAll={() => {
                            if (section.id === 'chats' || section.id === 'archived') {
                                setExpanded(new Set([...expanded, section.id]));
                            }
                        }}
                    />
                ))}
            </Screen>
        </View>
    );
}

/** An inset group: rows on the system's grouped colors, rounded, hairlines between them, no border (Settings'). */
function Group({ children, testID }: { children: ReactNode; testID?: string }) {
    return <GroupedCard testID={testID}>{children}</GroupedCard>;
}

function SectionGroup(props: {
    section: SocioPageSection;
    onOpen: (row: SocioPageRow) => void;
    onShowAll: () => void;
}) {
    const { section } = props;
    const rows = section.rows;
    return (
        <View className="gap-1.5" testID={`socio-${section.id}`}>
            <Text accessibilityRole="header" variant="section" className="px-4">
                {section.title}
            </Text>
            <Group>
                {rows.length === 0 ? (
                    <View
                        className="justify-center px-4"
                        style={rowMinHeight(44)}
                        accessible
                        testID={`socio-${section.id}-empty`}
                    >
                        <Text variant="subheadline" tone="muted">
                            {section.empty}
                        </Text>
                    </View>
                ) : null}
                {rows.map((row, index) => (
                    <Row key={row.key} row={row} first={index === 0} onPress={() => props.onOpen(row)} />
                ))}
                {section.more > 0 ? (
                    <Pressable
                        testID={`socio-${section.id}-all`}
                        accessibilityRole="button"
                        accessibilityLabel={`Show all ${section.title.toLowerCase()}, ${section.more} more`}
                        onPress={props.onShowAll}
                        className="justify-center px-4 active:bg-accent"
                        style={rowMinHeight(44)}
                    >
                        <RowSeparator inset={16} />
                        <Text tone="primary">{`Show all (${section.more} more)`}</Text>
                    </Pressable>
                ) : null}
                {section.footer === null ? null : (
                    <Row
                        row={section.footer}
                        first={false}
                        onPress={() => props.onOpen(section.footer as SocioPageRow)}
                    />
                )}
            </Group>
        </View>
    );
}

/** A row: its title and detail, then the disclosure chevron. */
function Row({ row, first, onPress }: { row: SocioPageRow; first: boolean; onPress: () => void }) {
    return (
        <Pressable
            testID={`socio-row-${row.key}`}
            accessibilityRole="button"
            accessibilityLabel={row.accessibilityLabel}
            onPress={onPress}
            className="flex-row items-center gap-3 px-4 py-2.5 active:bg-accent"
            style={rowMinHeight(44)}
        >
            {first ? null : <RowSeparator inset={16} />}
            <View className="min-w-0 flex-1 gap-0.5">
                <Text numberOfLines={1}>{row.title}</Text>
                {row.detail === null ? null : (
                    <Text variant="footnote" tone="muted" numberOfLines={1}>
                        {row.detail}
                    </Text>
                )}
            </View>
            <Disclosure />
        </Pressable>
    );
}
