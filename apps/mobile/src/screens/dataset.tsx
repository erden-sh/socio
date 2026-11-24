import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { ViewListResponse } from '@socio/shared/dataset-views/contract';
import { MODULE_IDS } from '@socio/shared/modules';
import type { SpaceDatasetItem } from '@socio/shared/spaces/space-items';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { datasetViewAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { layoutIcon } from '../shell/dataset-view';
import { moduleEntry } from '../shell/modules';
import { itemsQuery, spacesQuery } from '../shell/queries';
import { DATASET_MISSING, DATASET_MISSING_LINE, datasetScreen, type DatasetTableRow } from '../shell/space-items';
import { createLiveViewSource, type ViewSource, ViewSourceError } from '../sync/view-source';
import { AppSymbol, Screen, Text, ToneTile, usePullToRefresh } from '../ui';
import { EmptyState, useWayBack } from '../ui/empty-state';

import { MODULE_ICONS } from './module-icons';
import { ListRow, PageIntro, Section, StatusBanners } from './shell-parts';

// A dataset (CB-469, CB-451): the `Dataset` route at the web's
// `/data/datasets/:datasetId`, pushed in the Spaces tab from its Space's tree or
// the Private group. It draws from the item the phone holds (the Space's items,
// or Private's: their name, tables and row counts, offline too), the Data
// module's tone and icon leading its first line. Its tables are listed in their
// order, each with its views (`GET …/views`), which open in DatasetView; a dataset
// in no list the phone holds says so.

const DATA = moduleEntry(MODULE_IDS.data);

export function DatasetScreen({ route }: StaticScreenProps<{ datasetId: string; spaceId?: string }>) {
    return useHasWorkspaceScope() ? (
        <Dataset datasetId={route.params.datasetId} spaceId={route.params.spaceId ?? null} />
    ) : null;
}

function Dataset({ datasetId, spaceId }: { datasetId: string; spaceId: string | null }) {
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const list = spaceId === null ? scope.pages.items.private() : scope.pages.items.space(spaceId);
    const { data: items } = useLiveQuery({ query: itemsQuery(list.collection) });
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    const found = items.find((item) => item.id === datasetId && item.kind === 'dataset') as
        | SpaceDatasetItem
        | undefined;
    const spaceName = spaceId === null ? null : (spaces.find((space) => space.id === spaceId)?.name ?? null);
    const view = found === undefined ? null : datasetScreen(found, spaceName);
    useFirstFrameWithData('Dataset', view !== null);
    const [source] = useState(() => createLiveViewSource({ fetch: scope.fetch, signal: scope.signal }));
    const [reload, setReload] = useState(0);
    const refreshControl = usePullToRefresh(() => {
        setReload((n) => n + 1);
        return list.pull();
    });
    const back = useWayBack('Dataset');
    useNativeBar({ title: view?.title ?? DATA.title, tone: DATA.tone });
    return (
        <View testID="dataset-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} grouped refreshControl={refreshControl}>
                <StatusBanners />
                {view === null ? (
                    <EmptyState
                        headline={DATASET_MISSING}
                        line={DATASET_MISSING_LINE}
                        action={back}
                        testID="dataset-missing"
                    />
                ) : (
                    <>
                        <PageIntro
                            subtitle={view.intro}
                            subtitleLines={2}
                            tile={{ tone: DATA.tone, icon: MODULE_ICONS[DATA.icon] }}
                            testID="dataset-heading"
                        />
                        {view.note === null ? null : (
                            <Text variant="footnote" tone="muted" testID="dataset-note">
                                {view.note}
                            </Text>
                        )}
                        {view.tables.map((table) => (
                            <TableSection
                                key={table.name}
                                table={table}
                                datasetId={datasetId}
                                spaceId={spaceId}
                                source={source}
                                reload={reload}
                                version={found?.version ?? 0}
                            />
                        ))}
                    </>
                )}
            </Screen>
        </View>
    );
}

/**
 * A table and its views (CB-451's `GET …/views`): each view opens DatasetView; the table
 * itself opens on its last-used view. A server that doesn't serve views yet (an older one) says so
 * under the table, which still lists its rows.
 */
function TableSection(props: {
    table: DatasetTableRow;
    datasetId: string;
    spaceId: string | null;
    source: ViewSource;
    reload: number;
    /** The item's version (#663): its table views are read again when it changes, compared for equality. */
    version: number;
}) {
    const { table, datasetId, spaceId, source } = props;
    const navigation = useNavigation();
    const [views, setViews] = useState<ViewListResponse | null>(null);
    const [note, setNote] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        source
            .list({ datasetId, table: table.name })
            .then((answer) => {
                if (live) {
                    setViews(answer);
                    setNote(null);
                }
            })
            .catch((error: unknown) => {
                if (live) {
                    setNote(
                        error instanceof ViewSourceError && error.kind === 'not-served'
                            ? 'Views open here once this server serves them.'
                            : 'Couldn’t read this table’s views. Pull to try again.',
                    );
                }
            });
        return () => {
            live = false;
        };
    }, [source, datasetId, table.name, props.reload, props.version]);
    const open = (viewId?: string) =>
        navigation.dispatch(
            datasetViewAction({
                datasetId,
                table: table.name,
                ...(viewId === undefined ? {} : { viewId }),
                ...(spaceId === null ? {} : { spaceId }),
            }),
        );
    return (
        <Section title={table.title} testID={`dataset-table-${table.name}`}>
            <ListRow
                first
                testID={`dataset-table-${table.name}-open`}
                leadingSize={44}
                leading={<ToneTile tone={DATA.tone} icon="table" surface="card" />}
                title={table.title}
                subtitle={note ?? table.line}
                subtitleLines={2}
                trailing={table.analytical ? <AppSymbol name="chart-column" color="muted-foreground" /> : null}
                accessibilityLabel={table.accessibilityLabel}
                {...(views === null ? {} : { onPress: () => open(), accessibilityHint: 'Opens its last view' })}
            />
            {(views?.views ?? []).map((item) => (
                <ListRow
                    key={item.id}
                    testID={`dataset-view-${item.id}`}
                    leadingSize={44}
                    leading={<ToneTile tone={DATA.tone} icon={layoutIcon(item.layout)} surface="card" />}
                    title={item.name}
                    subtitle={[
                        item.visibility === 'personal' ? 'Only you' : 'Shared',
                        item.hasDraft ? 'Changed for you' : null,
                    ]
                        .filter(Boolean)
                        .join(' · ')}
                    accessibilityLabel={item.name}
                    accessibilityHint="Opens the view"
                    onPress={() => open(item.id)}
                />
            ))}
        </Section>
    );
}
