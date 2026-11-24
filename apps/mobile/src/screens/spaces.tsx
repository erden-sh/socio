import { useNavigation } from '@react-navigation/native';

import { MODULE_IDS } from '@socio/shared/modules';

import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    usePrivateItems,
    useSyncOnFocus,
    useSyncRefresh,
} from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { datasetAction, spaceAction } from '../navigation/tabs';
import { moduleEntry } from '../shell/modules';
import { LONG_PRESS_TO_MENU } from '../shell/native-menu';
import { canCreateSpace, NEW_SPACE_LABEL } from '../shell/new-space';
import { itemsQuery, shellQuery, shellRows, spacesQuery } from '../shell/queries';
import { datasetsInSpaces, PRIVATE_EMPTY, PRIVATE_GROUP, privateRows } from '../shell/space-items';
import { SPACES_INTRO, spaceList } from '../shell/spaces';
import { AppSymbol, Screen, Text, ToneTile, usePullToRefresh } from '../ui';

import { ActionMenu } from './action-menu';
import { SpacesAttention } from './attention';
import { MOVE_ACTION, useDatasetMove } from './dataset-move';
import { MODULE_ICONS } from './module-icons';
import { ListRow, PageIntro, StatusBanners, Section, useRememberScreen } from './shell-parts';
import { TAB_ROOT_KEYBOARD, TAB_STACK_EDGES } from './tab-edges';

// The Spaces: each one the person can read, in the server's order,
// a private one marked (src/shell/spaces.ts). The Spaces tab's root (CB-459),
// which Home's tile and Search switch to, under the system's bar with "Spaces"
// as its large title (CB-420). What needs attention about Spaces leads the
// list (`SpacesAttention`: the pages changed elsewhere, which the tab's badge
// counts), as the attention section leads Chats. A row opens the Space's library
// (screens/space.tsx). New Space in the bar (CB-410) opens the NewSpace modal, shown only to whom the server's
// `permissions.createSpaces` lets in, as the web's sidebar does. With the
// `datasets-in-spaces` flag (CB-469), the Private group leads the Spaces: the
// person's datasets in no Space (`/api/data/private-items`), each opening the
// dataset, its long-press Move to a Space they edit.

const SYNCED = ['spaces'] as const;
const SPACES = moduleEntry(MODULE_IDS.spaces);
const DATA = moduleEntry(MODULE_IDS.data);

export function SpacesScreen() {
    return useHasWorkspaceScope() ? <Spaces /> : null;
}

function Spaces() {
    const navigation = useNavigation();
    const collections = useCollections();
    useRememberScreen('Spaces');
    useSyncOnFocus(SYNCED);
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    const rows = spaceList(spaces);
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const workspace = shellRows(shell).workspace;
    const creates = canCreateSpace(workspace);
    // CB-469: the person's datasets in no Space, at the top of the list, with the web's flag.
    const datasets = datasetsInSpaces(workspace);
    const privateItems = usePrivateItems(datasets);
    const { data: held } = useLiveQuery({ query: itemsQuery(privateItems.collection) });
    const mine = datasets ? privateRows(held) : [];
    const move = useDatasetMove(spaces);
    const refreshSpaces = useSyncRefresh(SYNCED);
    const refreshControl = usePullToRefresh(() =>
        Promise.all([refreshSpaces(), datasets ? privateItems.pull() : null]).then(() => undefined),
    );
    useNativeBar({
        title: SPACES.title,
        tone: SPACES.tone,
        right: creates
            ? [
                  {
                      id: 'spaces-new',
                      label: NEW_SPACE_LABEL,
                      symbol: 'plus',
                      icon: 'plus',
                      onPress: () => navigation.navigate('NewSpace'),
                  },
              ]
            : [],
    });
    return (
        <Screen
            testID="spaces-screen"
            edges={TAB_STACK_EDGES}
            grouped
            refreshControl={refreshControl}
            keyboardAware={TAB_ROOT_KEYBOARD}
        >
            <StatusBanners />
            <PageIntro
                subtitle={SPACES_INTRO}
                subtitleLines={0}
                tile={{ tone: SPACES.tone, icon: MODULE_ICONS[SPACES.icon] }}
                testID="spaces-heading"
            />
            {/* What needs attention about Spaces, at the top of the list (the owner, 2026-11-20). */}
            <SpacesAttention />
            {datasets ? (
                <Section title={PRIVATE_GROUP} testID="spaces-private">
                    {mine.length === 0 ? (
                        <ListRow
                            first
                            testID="spaces-private-empty"
                            title={PRIVATE_EMPTY}
                            subtitle="Datasets you make outside a Space show here. Only you see them."
                            subtitleLines={2}
                            leadingSize={44}
                            leading={<ToneTile tone={SPACES.tone} icon="lock" surface="card" />}
                            accessibilityLabel={PRIVATE_EMPTY}
                        />
                    ) : (
                        mine.map((item, index) => (
                            <ActionMenu
                                key={item.id}
                                trigger="longPress"
                                request={
                                    item.opens ? move.menu({ id: item.id, title: item.title, from: null }, true) : null
                                }
                            >
                                <ListRow
                                    first={index === 0}
                                    testID={`spaces-private-${item.id}`}
                                    leadingSize={44}
                                    leading={<ToneTile tone={DATA.tone} icon="table" surface="card" />}
                                    title={item.title}
                                    subtitle={[item.subtitle, item.badge].filter(Boolean).join(' · ')}
                                    accessibilityLabel={item.accessibilityLabel}
                                    accessibilityHint={item.opens ? 'Opens the dataset' : undefined}
                                    accessibilityActions={item.opens ? [MOVE_ACTION] : undefined}
                                    onAccessibilityAction={() =>
                                        move.open({ id: item.id, title: item.title, from: null })
                                    }
                                    onLongPress={item.opens ? LONG_PRESS_TO_MENU : undefined}
                                    onPress={
                                        item.opens ? () => navigation.dispatch(datasetAction(item.id, null)) : undefined
                                    }
                                />
                            </ActionMenu>
                        ))
                    )}
                </Section>
            ) : null}
            {rows.length === 0 ? (
                <Text variant="subheadline" tone="muted" className="text-center" testID="spaces-empty">
                    No spaces yet.
                </Text>
            ) : (
                <Section title={`${rows.length} ${rows.length === 1 ? 'space' : 'spaces'}`}>
                    {rows.map((space, index) => (
                        <ListRow
                            key={space.id}
                            first={index === 0}
                            testID={`space-${space.id}`}
                            leadingSize={44}
                            leading={<ToneTile tone={SPACES.tone} icon={MODULE_ICONS[SPACES.icon]} surface="card" />}
                            title={space.name}
                            subtitle={space.description}
                            trailing={space.private ? <AppSymbol name="lock" color="muted-foreground" /> : null}
                            accessibilityLabel={space.accessibilityLabel}
                            onPress={() => navigation.dispatch(spaceAction(space.id))}
                        />
                    ))}
                </Section>
            )}
        </Screen>
    );
}
