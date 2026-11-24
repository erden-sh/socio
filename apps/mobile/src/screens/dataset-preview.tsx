import { useNavigation } from '@react-navigation/native';
import { View } from 'react-native';

import { VIEW_FIXTURES } from '@socio/shared/dataset-views/fixtures/index';
import { MODULE_IDS } from '@socio/shared/modules';

import { useNativeBar } from '../navigation/native-bar';
import { datasetFieldsAction, datasetNewRowAction, datasetViewAction } from '../navigation/tabs';
import { CALENDAR_LABELS, layoutIcon, PHONE_CALENDAR_MODES } from '../shell/dataset-view';
import { moduleEntry } from '../shell/modules';
import {
    ACME_ARCHIVE_VIEW,
    ACME_DATASET,
    ACME_OPEN_VIEW,
    ACME_TABLE,
    FIXTURE_DATASET,
    FIXTURE_TABLE,
} from '../sync/fixture-source';
import { Screen, ToneTile } from '../ui';

import { ListRow, PageIntro, Section } from './shell-parts';

// The dataset views' dev preview (CB-469): development and preview builds only
// (`variants` in the route table), at `/dataset-preview`. Every shared contract
// fixture (one per layout, one with parts from a newer release) opens in the
// real DatasetView through the fixture-backed source, and the calendar opens in
// each of its ranges on the fixtures' busy week, for the shots and for checking
// a layout against the contract until build step 8 serves views; and the write
// fixtures' Acme table (phase 2a), where every write and conflict can be met.

const DATA = moduleEntry(MODULE_IDS.data);

/** The write fixtures' table (phase 2a): each write and each conflict, from one place. */
const WRITES: readonly {
    id: string;
    title: string;
    subtitle: string;
    icon: 'table' | 'list' | 'settings-2' | 'plus';
    open: 'view' | 'fields' | 'new-row';
    viewId?: string;
}[] = [
    {
        id: 'open',
        title: 'Open tasks',
        subtitle:
            'Ada’s draft over Bo’s save: Save for everyone conflicts. Bo changed “Ship the Acme brief” too: edit its Status.',
        icon: 'table',
        open: 'view',
        viewId: ACME_OPEN_VIEW,
    },
    {
        id: 'archive',
        title: 'Archive',
        subtitle: 'Export CSV answers 413: too many rows.',
        icon: 'list',
        open: 'view',
        viewId: ACME_ARCHIVE_VIEW,
    },
    {
        id: 'default',
        title: 'All tasks',
        subtitle: 'The default view: its draft saves only as a new view.',
        icon: 'table',
        open: 'view',
        viewId: 'default',
    },
    {
        id: 'fields',
        title: 'Field settings',
        subtitle: 'Status conflicts once, then asks before removing an option rows use.',
        icon: 'settings-2',
        open: 'fields',
    },
    {
        id: 'new-row',
        title: 'New row',
        subtitle: 'A form over Open tasks’ fields: the server gives its ID.',
        icon: 'plus',
        open: 'new-row',
    },
];
/** The fixtures' first booking: a Monday with entries in every range. */
const CALENDAR_DAY = '2026-11-23';

export function DatasetPreviewScreen() {
    const navigation = useNavigation();
    useNativeBar({ title: 'Dataset views', tone: DATA.tone });
    const open = (params: Parameters<typeof datasetViewAction>[0]) => navigation.dispatch(datasetViewAction(params));
    const base = { datasetId: FIXTURE_DATASET, table: FIXTURE_TABLE, preview: true };
    const calendar = VIEW_FIXTURES.find((fixture) => fixture.definition.view.layout === 'calendar');
    return (
        <View testID="dataset-preview-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} grouped>
                <PageIntro
                    subtitle="The shared view fixtures, read as the phone reads a server's answers."
                    subtitleLines={2}
                    tile={{ tone: DATA.tone, icon: 'database' }}
                />
                <Section title="Every layout" testID="dataset-preview-views">
                    {VIEW_FIXTURES.map((fixture, index) => (
                        <ListRow
                            key={fixture.name}
                            first={index === 0}
                            testID={`dataset-preview-${fixture.name}`}
                            leadingSize={44}
                            leading={
                                <ToneTile
                                    tone={DATA.tone}
                                    icon={layoutIcon(fixture.definition.view.layout)}
                                    surface="card"
                                />
                            }
                            title={`${fixture.definition.view.name} (${fixture.name})`}
                            subtitle={fixture.about}
                            subtitleLines={2}
                            accessibilityLabel={`${fixture.definition.view.name}, ${fixture.name}`}
                            onPress={() => open({ ...base, viewId: fixture.definition.view.id })}
                        />
                    ))}
                </Section>
                <Section title="Writes and conflicts" testID="dataset-preview-writes">
                    {WRITES.map((row, index) => (
                        <ListRow
                            key={row.id}
                            first={index === 0}
                            testID={`dataset-preview-writes-${row.id}`}
                            leadingSize={44}
                            leading={<ToneTile tone={DATA.tone} icon={row.icon} surface="card" />}
                            title={row.title}
                            subtitle={row.subtitle}
                            subtitleLines={2}
                            accessibilityLabel={`${row.title}, Acme tasks`}
                            onPress={() => {
                                const acme = { datasetId: ACME_DATASET, table: ACME_TABLE, preview: true };
                                if (row.open === 'fields') {
                                    navigation.dispatch(datasetFieldsAction(acme));
                                } else if (row.open === 'new-row') {
                                    navigation.dispatch(datasetNewRowAction({ ...acme, viewId: ACME_OPEN_VIEW }));
                                } else {
                                    open({ ...acme, ...(row.viewId === undefined ? {} : { viewId: row.viewId }) });
                                }
                            }}
                        />
                    ))}
                </Section>
                {calendar === undefined ? null : (
                    <Section title="Calendar ranges" testID="dataset-preview-calendar">
                        {PHONE_CALENDAR_MODES.map((mode, index) => (
                            <ListRow
                                key={mode}
                                first={index === 0}
                                testID={`dataset-preview-calendar-${mode}`}
                                leadingSize={44}
                                leading={<ToneTile tone={DATA.tone} icon="calendar" surface="card" />}
                                title={CALENDAR_LABELS[mode]}
                                subtitle={`From ${CALENDAR_DAY}`}
                                accessibilityLabel={`Calendar, ${CALENDAR_LABELS[mode]}`}
                                onPress={() =>
                                    open({ ...base, viewId: calendar.definition.view.id, mode, day: CALENDAR_DAY })
                                }
                            />
                        ))}
                    </Section>
                )}
            </Screen>
        </View>
    );
}
