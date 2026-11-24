import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';

import type {
    ViewConflict,
    ViewDefinitionResponse,
    ViewFile,
    ViewListResponse,
    ViewRow,
    ViewRowsPage,
    ViewUser,
    WriteCell,
    RowWritten,
} from '@socio/shared/dataset-views/contract';
import type { CalendarMode, ViewDefinition, ViewLayout } from '@socio/shared/dataset-views/definition';
import { readViewDefinition } from '@socio/shared/dataset-views/fallback';
import { cellItems, formatCell } from '@socio/shared/dataset-views/format';
import { MODULE_IDS } from '@socio/shared/modules';

import type { PickSource } from '../chat/attachment-tray';
import { useHasWorkspaceScope } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { datasetFieldsAction, datasetNewRowAction } from '../navigation/tabs';
import { shareCsv } from '../platform/share-file';
import {
    boardView,
    calendarEntries,
    calendarRange,
    type CellFormat,
    columnValue,
    daysOf,
    firstRequest,
    moveTargets,
    openView,
    phoneCalendarOpening,
    recordView,
    rowCard,
    stepCalendar,
    tableView,
} from '../shell/dataset-view';
import {
    type CellConflictView,
    conflictLines,
    copyName,
    newViewDefinition,
    refusalCopy,
    saveChoices,
    savedByLine,
    unresolvedPeople,
    withFile,
} from '../shell/dataset-writes';
import { moduleEntry } from '../shell/modules';
import { type Refused, type TableRef, type ViewSource, ViewSourceError } from '../sync/view-source';
import { Banner, Button, Screen, Text, usePullToRefresh } from '../ui';
import { EmptyState } from '../ui/empty-state';

import { ActionMenu } from './action-menu';
import { SaveAsNewBody, ViewConflictBody } from './dataset-conflicts';
import {
    AgendaList,
    BoardLayout,
    CalendarHead,
    CardList,
    CoverTile,
    MonthGrid,
    TableLayout,
    TimeGrid,
} from './dataset-layouts';
import { useDatasetUpload, useKnownPeople, usePeople } from './dataset-pickers';
import { type EditState, type OptionsTab, OptionsSheetBody, RecordSheetBody, ViewsSheetBody } from './dataset-sheets';
import { datasetFormat, useViewSource } from './dataset-source';
import { useRouteSheet } from './route-sheet';
import { StatusBanners } from './shell-parts';

// One view of a dataset's table (CB-469, CB-451), the `DatasetView` route
// in the Spaces tab, pushed from the dataset's screen (or the dev preview with
// `preview`, which reads the shared fixtures). It reads and writes through a
// `ViewSource` (src/sync/view-source.ts): the contract's routes on the
// workspace, or the fixtures. The view opens in its layout as the phone reads
// it (an unknown one as a list, with its note); the bar's Views switches view,
// Filter and sort opens the options sheet (Filter, Sort, Group, Fields), and ⋯
// has New row, Export CSV (the system's share sheet) and Field settings. Each
// sheet change is a personal draft ("Changed for you"): Save for everyone (a
// `view_conflict` opens the comparison sheet: Keep mine, Take theirs, Save
// mine as a new view), Save as new view, or Reset. A row opens the record
// sheet with every field and its editing, a cell's conflict shown there (a
// board card's Move in an alert); a board card's long-press moves it to any
// column. The column in focus, the calendar's range and day, the cards
// expanded and a table read as a list are this screen's state, never a draft.

const DATA = moduleEntry(MODULE_IDS.data);

type Params = {
    datasetId: string;
    table: string;
    viewId?: string;
    spaceId?: string;
    /** The dev preview: the shared fixtures, in their zone and on their day. */
    preview?: boolean;
    /** The calendar's opening range and day (the preview's shots). */
    mode?: CalendarMode;
    day?: string;
};

export function DatasetViewScreen({ route }: StaticScreenProps<Params>) {
    return useHasWorkspaceScope() ? <DatasetView params={route.params} /> : null;
}

/** A page with a written row in place of the one it had (a cell edit, Take theirs), and its names. */
function withWritten(page: ViewRowsPage, row: ViewRow, written: Pick<RowWritten, 'users' | 'files'>): ViewRowsPage {
    return {
        ...page,
        rows: page.rows.map((r) =>
            r.key === row.key ? { ...row, ...(r.group === undefined ? {} : { group: r.group }) } : r,
        ),
        users: { ...page.users, ...written.users },
        files: { ...page.files, ...written.files },
    };
}

function DatasetView({ params }: { params: Params }) {
    const navigation = useNavigation();
    const preview = params.preview === true;
    const source = useViewSource(preview);
    const { datasetId, table } = params;
    const ref: TableRef = { datasetId, table };
    const { format, today } = datasetFormat(preview);

    const [list, setList] = useState<ViewListResponse | null>(null);
    const [viewId, setViewId] = useState<string | null>(params.viewId ?? null);
    const [definition, setDefinition] = useState<ViewDefinitionResponse | null>(null);
    const [page, setPage] = useState<ViewRowsPage | null>(null);
    const [columnRows, setColumnRows] = useState<{ key: string | null; rows: readonly ViewRow[] } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [reload, setReload] = useState(0);
    // View state on the device, never a draft (CB-451).
    const [focusKey, setFocusKey] = useState<string | null | undefined>(undefined);
    const [mode, setMode] = useState<CalendarMode | null>(params.mode ?? null);
    const [day, setDay] = useState(params.day ?? today);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [asList, setAsList] = useState(false);
    const [sheet, setSheet] = useState<'views' | 'options' | null>(null);
    const [optionsTab, setOptionsTab] = useState<OptionsTab>('filter');
    const [recordKey, setRecordKey] = useState<string | null>(null);
    const [edit, setEdit] = useState<EditState>({ kind: 'idle' });
    const [cellConflict, setCellConflict] = useState<CellConflictView | null>(null);
    /** Names and files the writes' answers brought, until the next read has them. */
    const [extra, setExtra] = useState<{ users: Record<string, ViewUser>; files: Record<string, ViewFile> }>({
        users: {},
        files: {},
    });
    const [wantPeople, setWantPeople] = useState(false);
    const [viewConflict, setViewConflict] = useState<ViewConflict | null>(null);
    const [saveAsNew, setSaveAsNew] = useState<{ name: string; shared: boolean; error: string | null } | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const people = usePeople(source, wantPeople);
    const uploads = useDatasetUpload(source, datasetId);

    // Back from New row or the field settings: read the view again.
    const focused = useRef(false);
    useEffect(
        () =>
            navigation.addListener('focus', () => {
                if (focused.current) {
                    setReload((n) => n + 1);
                }
                focused.current = true;
            }),
        [navigation],
    );

    useEffect(() => {
        let live = true;
        source
            .list({ datasetId, table })
            .then((answer) => {
                if (live) {
                    setList(answer);
                    setViewId((current) => current ?? answer.lastUsedViewId);
                }
            })
            .catch((failure: unknown) => live && setError(wordError(failure)));
        return () => {
            live = false;
        };
    }, [source, datasetId, table, reload]);

    useEffect(() => {
        if (viewId === null) {
            return;
        }
        let live = true;
        (async () => {
            const answer = await source.definition({ datasetId, table }, viewId);
            const effective = answer.draft?.definition ?? answer.view;
            const layout = readViewDefinition(effective, 'phone').layout;
            const opening = mode ?? phoneCalendarOpening(effective);
            const range = layout === 'calendar' ? calendarRange(opening, day) : null;
            const rows = await source.rows({ datasetId, table }, viewId, firstRequest(effective, layout, range));
            if (live) {
                setDefinition(answer);
                setPage(rows);
                setError(null);
            }
        })().catch((failure: unknown) => live && setError(wordError(failure)));
        return () => {
            live = false;
        };
    }, [source, datasetId, table, viewId, reload, mode, day]);

    const view = definition === null ? null : (definition.draft?.definition ?? definition.view);
    const shownPage =
        page === null
            ? null
            : { ...page, users: { ...extra.users, ...page.users }, files: { ...extra.files, ...page.files } };
    const opened =
        list === null || view === null || page === null ? null : openView(list, view, page, definition?.skipped);
    const board =
        opened !== null && shownPage !== null && opened.layout === 'board'
            ? boardView(
                  shownPage,
                  opened,
                  format,
                  focusKey,
                  columnRows !== null && columnRows.key === focusKey ? columnRows.rows : undefined,
              )
            : null;

    // A hidden column in focus reads its own rows (`group`): the first page sends none of them.
    const focusedHidden =
        board?.swipeable[board.focus]?.hidden === true ? board.swipeable[board.focus]!.key : undefined;
    useEffect(() => {
        if (focusedHidden === undefined || viewId === null) {
            return;
        }
        let live = true;
        source
            .rows({ datasetId, table }, viewId, { schema: 1, group: focusedHidden })
            .then((answer) => live && setColumnRows({ key: focusedHidden, rows: answer.rows }))
            .catch((failure: unknown) => live && setError(wordError(failure)));
        return () => {
            live = false;
        };
    }, [source, datasetId, table, viewId, focusedHidden, reload]);

    const allRows = [...(page?.rows ?? []), ...(columnRows?.rows ?? [])];
    const recordRow = recordKey === null ? undefined : allRows.find((row) => row.key === recordKey);
    const personCells =
        recordRow === undefined || opened === null
            ? []
            : [...opened.fields.values()]
                  .filter((f) => f.kind === 'person' || f.kind === 'people')
                  .map((f) => recordRow.values[f.field]);
    const known = useKnownPeople(source, shownPage?.users ?? {}, unresolvedPeople(personCells, shownPage?.users ?? {}));
    const record =
        opened === null || list === null || shownPage === null || recordRow === undefined
            ? null
            : recordView(recordRow, opened, list.rights, { users: known, files: shownPage.files }, format);

    const merge = (written: Pick<RowWritten, 'users' | 'files'>) =>
        setExtra((held) => ({
            users: { ...held.users, ...written.users },
            files: { ...held.files, ...written.files },
        }));
    const refusedAlert = (title: string, refused: Refused) => Alert.alert(title, refusalCopy(refused));

    /** A cell conflict's Take theirs: its row replaces the one held. */
    const pendingTheirs = useRef<() => void>(() => {});

    const draft = async (next: ViewDefinition) => {
        if (viewId === null || definition === null) {
            return;
        }
        const result = await source.saveDraft(
            ref,
            viewId,
            next,
            definition.draft?.baseVersion ?? definition.view.version,
        );
        if (result.outcome === 'refused') {
            refusedAlert('Your change wasn’t kept', result);
        }
        setReload((n) => n + 1);
    };

    const saveCell = async (key: string, field: string, from: unknown, to: WriteCell) => {
        setEdit({ kind: 'saving', field });
        const result = await source.editCell(ref, key, { field, from, to });
        const display = opened?.fields.get(field);
        if (result.outcome === 'saved') {
            setEdit({ kind: 'idle' });
            setCellConflict(null);
            merge(result.written);
            setPage((held) => (held === null ? held : withWritten(held, result.written.row, result.written)));
            setReload((n) => n + 1);
            return;
        }
        if (result.outcome === 'conflict') {
            const { conflict } = result;
            merge(conflict);
            const ctx = {
                ...format,
                users: { ...known, ...conflict.users },
                files: { ...shownPage?.files, ...conflict.files },
            };
            const shown: CellConflictView = {
                key,
                field,
                label: display?.label ?? field,
                theirs: display === undefined ? String(conflict.current) : formatCell(conflict.current, display, ctx),
                mine: display === undefined ? String(to) : formatCell(to, display, ctx),
                retry: { from: conflict.current, to },
            };
            setEdit({ kind: 'idle' });
            const takeTheirs = () => {
                setCellConflict(null);
                setPage((held) => (held === null ? held : withWritten(held, conflict.row, conflict)));
                setReload((n) => n + 1);
            };
            if (recordKey === key) {
                setCellConflict(shown);
            } else {
                // A board card's Move: no sheet is open, so the system's alert asks.
                Alert.alert(
                    `${shown.label} changed elsewhere`,
                    `Theirs, now: ${shown.theirs || 'Empty'}.\nYours: ${shown.mine || 'Empty'}.`,
                    [
                        { text: 'Take theirs', style: 'cancel', onPress: takeTheirs },
                        { text: 'Keep mine', onPress: () => void saveCell(key, field, conflict.current, to) },
                    ],
                );
            }
            pendingTheirs.current = takeTheirs;
            return;
        }
        const message = problemLine(result) ?? refusalCopy(result);
        if (recordKey === key) {
            setEdit({ kind: 'refused', field, message });
        } else {
            setEdit({ kind: 'idle' });
            Alert.alert('Not saved', message);
        }
        if (result.code === 'row_gone') {
            setReload((n) => n + 1);
        }
    };

    const reset = async () => {
        if (viewId !== null) {
            const result = await source.dropDraft(ref, viewId);
            if (result.outcome === 'refused') {
                refusedAlert('Not reset', result);
            }
            setViewConflict(null);
            setReload((n) => n + 1);
        }
    };

    /** Save for everyone (CB-451): the draft at its base, or over theirs after a conflict's Keep mine. */
    const saveView = async (overwrite?: { baseVersion: number }) => {
        const held = definition?.draft;
        if (viewId === null || held === undefined) {
            return;
        }
        setSaving(true);
        setSaveError(null);
        const result = await source.saveView(
            ref,
            viewId,
            held.definition,
            overwrite?.baseVersion ?? held.baseVersion,
            overwrite !== undefined,
        );
        setSaving(false);
        if (result.outcome === 'saved') {
            setViewConflict(null);
            setNotice(held.definition.visibility === 'personal' ? 'View saved.' : 'Saved for everyone.');
            setReload((n) => n + 1);
        } else if (result.outcome === 'conflict') {
            setViewConflict(result.conflict);
        } else if (viewConflict !== null) {
            setSaveError(refusalCopy(result));
        } else {
            refusedAlert('Not saved', result);
        }
    };

    const saveNew = async () => {
        if (saveAsNew === null || view === null || viewId === null) {
            return;
        }
        if (saveAsNew.name.trim() === '') {
            setSaveAsNew({ ...saveAsNew, error: 'A view needs a name.' });
            return;
        }
        setSaving(true);
        const result = await source.createView(
            ref,
            newViewDefinition(view, saveAsNew.name, saveAsNew.shared ? 'dataset' : 'personal'),
            definition?.draft === undefined ? undefined : viewId,
        );
        setSaving(false);
        if (result.outcome === 'saved') {
            setSaveAsNew(null);
            setViewConflict(null);
            setNotice(`Saved as “${result.saved.view.name}”.`);
            setViewId(result.saved.view.id);
            setReload((n) => n + 1);
        } else {
            setSaveAsNew({ ...saveAsNew, error: refusalCopy(result) });
        }
    };

    const exportCsv = () => {
        if (viewId === null || view === null || exporting) {
            return;
        }
        setExporting(true);
        void exportAndShare(source, ref, viewId, view.name).finally(() => setExporting(false));
    };

    const addFile = async (key: string, field: string, raw: unknown, from: PickSource) => {
        const uploaded = await uploads.upload(from);
        if (uploaded === null) {
            return;
        }
        if (!uploaded.ok) {
            setEdit({ kind: 'refused', field, message: uploaded.message });
            return;
        }
        merge({ users: {}, files: { [uploaded.id]: uploaded.file } });
        await saveCell(key, field, raw, withFile(raw, uploaded.id));
    };

    const rights = list?.rights;
    const canCreate =
        rights !== undefined &&
        rights.write &&
        rights.writtenBy === undefined &&
        list?.table.hasKey === true &&
        !list.table.analytical;
    const choices = view === null || rights === undefined ? null : saveChoices(view, rights);

    useNativeBar({
        title: view?.name ?? list?.table.title ?? DATA.title,
        tone: DATA.tone,
        right:
            list === null
                ? []
                : [
                      {
                          id: 'dataset-views',
                          label: 'Views',
                          symbol: 'square.grid.2x2',
                          icon: 'layout-grid' as const,
                          iconOnly: true,
                          onPress: () => setSheet('views'),
                      },
                      {
                          id: 'dataset-options',
                          label: 'Filter and sort',
                          symbol: 'line.3.horizontal.decrease',
                          icon: 'list-filter' as const,
                          iconOnly: true,
                          onPress: () => setSheet('options'),
                      },
                      {
                          id: 'dataset-more',
                          label: 'More',
                          symbol: 'ellipsis',
                          icon: 'ellipsis' as const,
                          iconOnly: true,
                          onPress: () => {},
                          menu: {
                              actions: [
                                  ...(canCreate ? [{ name: 'new-row', label: 'New row', icon: 'plus' }] : []),
                                  {
                                      name: 'export',
                                      label: exporting ? 'Exporting…' : 'Export CSV',
                                      icon: 'square.and.arrow.up',
                                      disabled: exporting || viewId === null,
                                  },
                                  { name: 'fields', label: 'Field settings', icon: 'slider.horizontal.3' },
                              ],
                              onAction: (name) => {
                                  if (name === 'new-row' && viewId !== null) {
                                      navigation.dispatch(datasetNewRowAction({ datasetId, table, viewId, preview }));
                                  } else if (name === 'export') {
                                      exportCsv();
                                  } else if (name === 'fields') {
                                      navigation.dispatch(datasetFieldsAction({ datasetId, table, preview }));
                                  }
                              },
                          },
                      },
                  ],
    });

    useRouteSheet(
        sheet === 'views' && list !== null && viewId !== null
            ? {
                  testID: 'dataset-views-sheet',
                  title: list.table.title,
                  body: (
                      <ViewsSheetBody
                          views={list.views}
                          current={viewId}
                          onPick={(id) => {
                              setSheet(null);
                              setViewId(id);
                              setFocusKey(undefined);
                              setMode(null);
                              setExpanded(new Set());
                          }}
                      />
                  ),
              }
            : null,
        () => setSheet(null),
    );
    useRouteSheet(
        sheet === 'options' && opened !== null && list !== null
            ? {
                  testID: 'dataset-options-sheet',
                  title: view?.name ?? 'View',
                  tall: true,
                  actions:
                      definition?.draft === undefined ? undefined : (
                          <Button
                              label="Reset"
                              variant="ghost"
                              onPress={() => void reset()}
                              testID="dataset-options-reset"
                          />
                      ),
                  body: (
                      <OptionsSheetBody
                          opened={opened}
                          fields={list.fields}
                          board={board}
                          tab={optionsTab}
                          onTab={setOptionsTab}
                          onDraft={(next) => void draft(next).catch((failure: unknown) => setError(wordError(failure)))}
                      />
                  ),
              }
            : null,
        () => setSheet(null),
    );
    useRouteSheet(
        record === null || recordRow === undefined || shownPage === null
            ? null
            : {
                  testID: 'dataset-record-sheet',
                  title: record.title,
                  tall: true,
                  body: (
                      <RecordSheetBody
                          record={record}
                          state={edit}
                          conflict={cellConflict?.key === recordRow.key ? cellConflict : null}
                          pickers={{
                              directory: people.people,
                              directoryError: people.error,
                              onNeedPeople: () => setWantPeople(true),
                              known,
                              files: shownPage.files,
                              uploading: uploads.busy,
                              onAddFile: (field, from) => void addFile(recordRow.key, field.field, field.raw, from),
                              timeZone: format.timeZone,
                          }}
                          onEdit={(field, to) => {
                              setCellConflict(null);
                              void saveCell(recordRow.key, field.field, field.raw, to);
                          }}
                          onKeepMine={() => {
                              const c = cellConflict;
                              if (c !== null) {
                                  setCellConflict(null);
                                  void saveCell(c.key, c.field, c.retry.from, c.retry.to);
                              }
                          }}
                          onTakeTheirs={() => pendingTheirs.current()}
                      />
                  ),
              },
        () => {
            setRecordKey(null);
            setCellConflict(null);
            setEdit({ kind: 'idle' });
        },
    );
    useRouteSheet(
        viewConflict === null || list === null || saveAsNew !== null
            ? null
            : {
                  testID: 'dataset-view-conflict-sheet',
                  title: 'Changed by someone else',
                  tall: true,
                  body: (
                      <ViewConflictBody
                          savedLine={savedByLine(viewConflict.savedBy, viewConflict.users)}
                          lines={conflictLines(viewConflict.diff, list.fields)}
                          canOverwrite={choices?.save !== null}
                          busy={saving}
                          error={saveError}
                          onKeepMine={() => void saveView({ baseVersion: viewConflict.current.version })}
                          onTakeTheirs={() => void reset()}
                          onSaveAsNew={() =>
                              setSaveAsNew({ name: copyName(view?.name ?? 'View'), shared: false, error: null })
                          }
                      />
                  ),
              },
        () => {
            setViewConflict(null);
            setSaveError(null);
        },
    );
    useRouteSheet(
        saveAsNew === null
            ? null
            : {
                  testID: 'dataset-save-new-sheet',
                  title: 'Save as new view',
                  body: (
                      <SaveAsNewBody
                          name={saveAsNew.name}
                          onName={(name) => setSaveAsNew({ ...saveAsNew, name, error: null })}
                          shared={saveAsNew.shared}
                          onShared={(shared) => setSaveAsNew({ ...saveAsNew, shared })}
                          canShare={rights?.saveShared === true}
                          busy={saving}
                          error={saveAsNew.error}
                          onSave={() => void saveNew()}
                      />
                  ),
              },
        () => setSaveAsNew(null),
    );

    useEffect(() => {
        if (notice === null) {
            return;
        }
        const timer = setTimeout(() => setNotice(null), 4_000);
        return () => clearTimeout(timer);
    }, [notice]);

    const refreshControl = usePullToRefresh(async () => setReload((n) => n + 1));
    const toggle = (key: string) => {
        const next = new Set(expanded);
        if (!next.delete(key)) {
            next.add(key);
        }
        setExpanded(next);
    };
    const open = (key: string) => {
        setEdit({ kind: 'idle' });
        setCellConflict(null);
        setRecordKey(key);
    };

    return (
        <View testID="dataset-view-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} refreshControl={refreshControl}>
                <StatusBanners />
                {error !== null ? (
                    <EmptyState headline="This view didn’t open" line={error} testID="dataset-view-error" />
                ) : opened === null || shownPage === null || list === null || view === null ? (
                    <Text variant="subheadline" tone="muted" className="py-8 text-center">
                        Opening the view…
                    </Text>
                ) : (
                    <>
                        {opened.notes.map((note) => (
                            <Banner key={note} tone="info" testID="dataset-view-note">
                                {note}
                            </Banner>
                        ))}
                        {notice === null ? null : (
                            <Banner tone="info" testID="dataset-view-notice">
                                {notice}
                            </Banner>
                        )}
                        {definition?.draft === undefined || choices === null ? null : (
                            <View
                                className="flex-row items-center gap-2 rounded-xl bg-accent p-3"
                                testID="dataset-view-draft"
                            >
                                <Text variant="subheadline" className="min-w-0 flex-1">
                                    {choices.save === 'everyone'
                                        ? 'Changed for you. Save it for everyone, or reset.'
                                        : choices.save === 'mine'
                                          ? 'Changed for you. Save it, or reset.'
                                          : 'Changed for you. Save it as a new view, or reset.'}
                                </Text>
                                <Button
                                    label="Reset"
                                    variant="ghost"
                                    onPress={() => void reset()}
                                    testID="dataset-view-reset"
                                />
                                <ActionMenu
                                    trigger="press"
                                    label="Save"
                                    testID="dataset-view-save"
                                    disabled={saving}
                                    request={{
                                        actions: [
                                            ...(choices.save === null
                                                ? []
                                                : [
                                                      {
                                                          name: 'save',
                                                          label:
                                                              choices.save === 'everyone'
                                                                  ? 'Save for everyone'
                                                                  : 'Save',
                                                          icon: 'checkmark.circle',
                                                      },
                                                  ]),
                                            { name: 'new', label: 'Save as new view', icon: 'plus.square.on.square' },
                                        ],
                                        onAction: (name) =>
                                            name === 'save'
                                                ? void saveView()
                                                : setSaveAsNew({
                                                      name: copyName(view.name),
                                                      shared: false,
                                                      error: null,
                                                  }),
                                    }}
                                >
                                    <View className="min-h-11 flex-row items-center rounded-full bg-primary px-4">
                                        <Text tone="on-primary" weight="semibold">
                                            {saving ? 'Saving…' : 'Save'}
                                        </Text>
                                    </View>
                                </ActionMenu>
                            </View>
                        )}
                        {opened.layout === 'table' ? (
                            <View className="flex-row justify-end">
                                <Button
                                    label={asList ? 'Show as table' : 'Show as list'}
                                    icon={asList ? 'table' : 'list'}
                                    variant="ghost"
                                    onPress={() => setAsList(!asList)}
                                    testID="dataset-view-as-list"
                                />
                            </View>
                        ) : null}
                        <Layout
                            layout={opened.layout === 'table' && asList ? 'list' : opened.layout}
                            page={shownPage}
                            opened={opened}
                            format={format}
                            board={board}
                            expanded={expanded}
                            onToggle={toggle}
                            onOpen={open}
                            onFocus={setFocusKey}
                            onMove={(key, column) => {
                                const groupField =
                                    view.options.groupField === undefined
                                        ? undefined
                                        : opened.fields.get(view.options.groupField);
                                const row = allRows.find((r) => r.key === key);
                                if (groupField !== undefined && row !== undefined) {
                                    void saveCell(
                                        key,
                                        groupField.field,
                                        row.values[groupField.field] ?? null,
                                        columnValue(column, groupField) as WriteCell,
                                    );
                                }
                            }}
                            calendar={{
                                mode: mode ?? phoneCalendarOpening(view),
                                day,
                                today,
                                onMode: setMode,
                                onDay: (d) => {
                                    setDay(d);
                                    setMode('day');
                                },
                                onStep: (by) => setDay(stepCalendar(mode ?? phoneCalendarOpening(view), day, by)),
                                onToday: () => setDay(today),
                            }}
                        />
                        <Text variant="footnote" tone="muted" className="text-center" testID="dataset-view-count">
                            {`${shownPage.rows.length} ${shownPage.rows.length === 1 ? 'row' : 'rows'}${shownPage.truncated ? ', more on the next read' : ''}`}
                        </Text>
                    </>
                )}
            </Screen>
        </View>
    );
}

/** Export CSV (CB-451): the view's file to the share sheet, or why not in the system's alert. */
async function exportAndShare(source: ViewSource, ref: TableRef, viewId: string, name: string): Promise<void> {
    try {
        const result = await source.exportCsv(ref, viewId, { name });
        if (result.outcome === 'csv') {
            if ((await shareCsv(result.name, result.text, name)) === 'unavailable') {
                Alert.alert('Can’t share here', 'This phone has no app to share the file with.');
            }
        } else if (result.outcome === 'too-large') {
            Alert.alert('Too many rows to export', refusalCopy({ code: result.tooLarge.code, body: result.tooLarge }));
        } else {
            Alert.alert('Not exported', refusalCopy(result));
        }
    } catch (failure) {
        console.warn('[datasets] the export was not shared', failure);
        Alert.alert('Not exported', 'The file couldn’t be written on this phone. Try again.');
    }
}

/** A 400's first problem, which names the value's trouble ("…is not an option of Status."). */
function problemLine(refused: Refused): string | null {
    if (refused.code !== 'invalid') {
        return null;
    }
    const problems = (refused.body as { problems?: unknown } | null)?.problems;
    const first = Array.isArray(problems) ? (problems[0] as { message?: unknown } | undefined) : undefined;
    return typeof first?.message === 'string' ? first.message : null;
}

function wordError(error: unknown): string {
    if (error instanceof ViewSourceError) {
        if (error.kind === 'not-served') {
            return 'This server doesn’t serve dataset views yet. Update Socio on the server to open them here.';
        }
        if (error.kind === 'refused') {
            return 'You can’t read this table.';
        }
        return error.message;
    }
    return 'Couldn’t reach the server. Pull to try again.';
}

function Layout(props: {
    layout: ViewLayout;
    page: ViewRowsPage;
    opened: NonNullable<ReturnType<typeof openView>>;
    format: CellFormat;
    board: ReturnType<typeof boardView> | null;
    expanded: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onOpen: (key: string) => void;
    onFocus: (key: string | null) => void;
    onMove: (key: string, column: string | null) => void;
    calendar: {
        mode: CalendarMode;
        day: string;
        today: string;
        onMode: (mode: CalendarMode) => void;
        onDay: (day: string) => void;
        onStep: (by: 1 | -1) => void;
        onToday: () => void;
    };
}) {
    const { page, opened, format } = props;
    const empty = 'No rows match this view.';
    switch (props.layout) {
        case 'table':
            return <TableLayout table={tableView(page, opened, format)} onOpen={props.onOpen} />;
        case 'board': {
            const board = props.board;
            if (board === null) {
                return null;
            }
            return (
                <BoardMoves board={board} onMove={props.onMove}>
                    {(wrap) => (
                        <BoardLayout
                            board={board}
                            expanded={props.expanded}
                            onToggle={props.onToggle}
                            onOpen={props.onOpen}
                            onFocus={props.onFocus}
                            empty={empty}
                            wrap={wrap}
                        />
                    )}
                </BoardMoves>
            );
        }
        case 'calendar': {
            const { mode, day, today } = props.calendar;
            const entries = calendarEntries(page, opened, format);
            const range = calendarRange(mode, day);
            return (
                <View className="gap-3" testID="dataset-calendar">
                    <CalendarHead
                        mode={mode}
                        day={day}
                        today={today}
                        onMode={props.calendar.onMode}
                        onStep={props.calendar.onStep}
                        onToday={props.calendar.onToday}
                        onDay={props.calendar.onDay}
                    />
                    {mode === 'month' ? (
                        <MonthGrid day={day} entries={entries} today={today} onDay={props.calendar.onDay} />
                    ) : mode === 'agenda' ? (
                        <AgendaList
                            day={day}
                            entries={entries}
                            expanded={props.expanded}
                            onToggle={props.onToggle}
                            onOpen={props.onOpen}
                        />
                    ) : (
                        <TimeGrid days={daysOf(range)} entries={entries} today={today} onOpen={props.onOpen} />
                    )}
                </View>
            );
        }
        case 'gallery': {
            const coverField = opened.reading.view.options.cardCover;
            return (
                <CardList
                    cards={page.rows.map((row) => rowCard(row, opened, page, format))}
                    expanded={props.expanded}
                    onToggle={props.onToggle}
                    onOpen={props.onOpen}
                    empty={empty}
                    testID="dataset-gallery"
                    cover={(key) => {
                        const row = page.rows.find((r) => r.key === key);
                        const id =
                            coverField === undefined || row === undefined
                                ? undefined
                                : cellItems(row.values[coverField])[0];
                        const file = id === undefined ? undefined : page.files[String(id)];
                        return (
                            <CoverTile
                                name={file?.name ?? (id === undefined ? null : 'File not available')}
                                image={file?.type.startsWith('image/') === true}
                            />
                        );
                    }}
                />
            );
        }
        default:
            return (
                <CardList
                    cards={page.rows.map((row) => rowCard(row, opened, page, format))}
                    expanded={props.expanded}
                    onToggle={props.onToggle}
                    onOpen={props.onOpen}
                    empty={empty}
                    testID="dataset-list"
                />
            );
    }
}

/** A board card's long-press: "Move to" with every column as a target (dragging is optional, CB-451). */
function BoardMoves(props: {
    board: NonNullable<ReturnType<typeof boardView>>;
    onMove: (key: string, column: string | null) => void;
    children: (wrap: (key: string, card: React.ReactElement) => React.ReactNode) => React.ReactNode;
}) {
    const current = props.board.swipeable[props.board.focus]?.key ?? null;
    const wrap = (key: string, card: React.ReactElement) => {
        const targets = moveTargets(props.board, current);
        return (
            <ActionMenu
                key={key}
                trigger="longPress"
                request={{
                    title: 'Move to',
                    actions: targets.map((t) => ({
                        name: `move:${String(t.key)}`,
                        label: t.label,
                        checked: t.checked,
                        disabled: t.checked,
                    })),
                    onAction: (name) => {
                        const raw = name.slice('move:'.length);
                        props.onMove(key, raw === 'null' ? null : raw);
                    },
                }}
            >
                {card}
            </ActionMenu>
        );
    };
    return <>{props.children(wrap)}</>;
}
