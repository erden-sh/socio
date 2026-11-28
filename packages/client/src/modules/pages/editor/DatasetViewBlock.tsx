import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { BarChart3, Database, LineChart, Lock, Pencil, RefreshCw, Table2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { DatasetView } from '@socio/shared/data-types';
import { VIEW_DISPLAYS, type ViewDisplay, type ViewDraft } from '@socio/shared/dataset-view';

import { api } from '../../../lib/api';
import { DatasetViewDisplay } from '../../../views/DatasetViewDisplay';
import { useDatasetView } from '../../../views/use-dataset-view';
import { openAppPath } from '../page-navigation';

import { useDatasetViewPage } from './dataset-view-context';
import { nodeDraft, viewAttrs } from './dataset-view-node';
import './dataset-view.css';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Auto-refresh's choices, in seconds (0 is off). */
const REFRESH_CHOICES = [0, 30, 60, 300, 900, 3600] as const;

/**
 * The live "Dataset view" block in the page editor. It reads its
 * query for whoever is looking (`use-dataset-view.ts`): owners and Space
 * members the dataset is shared with see data, anyone else a placeholder.
 * Read-only until someone who can edit the page opens Edit, which changes
 * the dataset, the query and how it is drawn.
 */
export function DatasetViewBlock({ node, editor, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
    const { t } = useTranslation(['pages.editor']);
    const page = useDatasetViewPage();
    const saved = nodeDraft(node.attrs);
    const editable = editor.isEditable;
    const [editing, setEditing] = useState(editable && (!saved.datasetId || !saved.query));
    // While editing, "Run" previews the draft without saving it.
    const [preview, setPreview] = useState<ViewDraft>();
    const shown = editing && preview ? preview : saved;
    const { state, refresh } = useDatasetView(page, shown);
    const [asTable, setAsTable] = useState(false);
    const result = 'result' in state ? state.result : undefined;
    const display: ViewDisplay = asTable ? 'table' : shown.display;
    const title = shown.title || result?.dataset.name || t('pages.editor:view.title');
    return (
        <NodeViewWrapper
            className={`dataset-view${selected ? ' selected' : ''}`}
            data-slot="dataset-view"
            data-status={state.status}
            contentEditable={false}
        >
            <div className="dataset-view-header">
                <span className="dataset-view-icon" aria-hidden>
                    {shown.display === 'bar' ? (
                        <BarChart3 size={15} />
                    ) : shown.display === 'line' ? (
                        <LineChart size={15} />
                    ) : (
                        <Database size={15} />
                    )}
                </span>
                <div className="dataset-view-heading">
                    <strong>{title}</strong>
                    {result && (
                        <span>
                            {[
                                shown.title ? result.dataset.name : '',
                                result.truncated
                                    ? t('pages.editor:view.rows-more', { count: result.rows.length })
                                    : t('pages.editor:view.rows', { count: result.rows.length }),
                                t('pages.editor:view.as-of', { at: new Date(result.at) }),
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </span>
                    )}
                </div>
                <TooltipProvider delayDuration={500}>
                    <div className="flex gap-0.5">
                        {result && shown.display !== 'table' && (
                            <ViewAction
                                label={asTable ? t('pages.editor:view.show-chart') : t('pages.editor:view.show-table')}
                                pressed={asTable}
                                onClick={() => setAsTable(!asTable)}
                            >
                                <Table2 />
                            </ViewAction>
                        )}
                        {state.status !== 'incomplete' && state.status !== 'denied' && (
                            <ViewAction
                                label={t('pages.editor:view.refresh')}
                                hint={t('pages.editor:view.refresh-hint')}
                                disabled={state.status === 'loading'}
                                onClick={refresh}
                            >
                                <RefreshCw
                                    className={
                                        state.status === 'loading'
                                            ? 'animate-spin motion-reduce:animate-none'
                                            : undefined
                                    }
                                />
                            </ViewAction>
                        )}
                        {editable && !editing && (
                            <ViewAction
                                label={t('pages.editor:view.edit')}
                                onClick={() => {
                                    setPreview(undefined);
                                    setEditing(true);
                                }}
                            >
                                <Pencil />
                            </ViewAction>
                        )}
                    </div>
                </TooltipProvider>
            </div>
            {editing && (
                <ViewEditor
                    saved={saved}
                    spaceId={page?.spaceId}
                    columns={result?.columns ?? []}
                    onRun={setPreview}
                    onSave={(draft) => {
                        updateAttributes(viewAttrs(draft));
                        setPreview(undefined);
                        setEditing(false);
                    }}
                    onCancel={
                        saved.datasetId && saved.query
                            ? () => {
                                  setPreview(undefined);
                                  setEditing(false);
                              }
                            : undefined
                    }
                    onRemove={deleteNode}
                />
            )}
            <div className="dataset-view-body" data-reloading={state.status === 'loading' && !!result}>
                {state.status === 'incomplete' ? (
                    <p className="dataset-view-state" data-state="incomplete">
                        {editable ? t('pages.editor:view.incomplete-editable') : t('pages.editor:view.incomplete')}
                    </p>
                ) : state.status === 'denied' ? (
                    <p className="dataset-view-state" data-state="denied" role="note">
                        <Lock size={15} aria-hidden /> {state.message}
                    </p>
                ) : state.status === 'error' ? (
                    <>
                        <p className="dataset-view-state" data-state="error" role="alert">
                            {state.message}
                        </p>
                        {result && (
                            <DatasetViewDisplay
                                result={result}
                                display={display}
                                x={shown.x}
                                y={shown.y}
                                title={title}
                            />
                        )}
                    </>
                ) : result ? (
                    <DatasetViewDisplay result={result} display={display} x={shown.x} y={shown.y} title={title} />
                ) : (
                    <div className="dataset-view-loading" data-state="loading" aria-busy="true">
                        {t('pages.editor:view.loading')}
                    </div>
                )}
            </div>
            {result?.dataset.owned && !result.dataset.sharedHere && (
                <p className="dataset-view-note" data-slot="view-private">
                    <Trans
                        t={t}
                        i18nKey="pages.editor:view.private"
                        components={{
                            link: (
                                <a
                                    href={`/data/datasets/${result.dataset.id}`}
                                    onClick={(event) => {
                                        if (event.button || event.metaKey || event.ctrlKey) {
                                            return;
                                        }
                                        event.preventDefault();
                                        openAppPath(`/data/datasets/${result.dataset.id}`);
                                    }}
                                />
                            ),
                        }}
                    />
                </p>
            )}
        </NodeViewWrapper>
    );
}

/** Datasets a view on this page can use: the viewer's own, and those shared with its Space. */
export function usableDatasets(datasets: DatasetView[], spaceId?: string) {
    return datasets.filter((dataset) => dataset.access === 'owner' || (spaceId && dataset.sharedSpaceId === spaceId));
}

/** One of the block's header actions: an icon button with its tooltip. */
function ViewAction({
    label,
    hint = label,
    pressed,
    disabled,
    onClick,
    children,
}: {
    label: string;
    hint?: string;
    pressed?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    aria-label={label}
                    aria-pressed={pressed}
                    disabled={disabled}
                    className="size-7.5 rounded-md p-0 text-muted-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground dark:hover:bg-accent [&_svg:not([class*='size-'])]:size-[15px]"
                    onClick={onClick}
                >
                    {children}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
    );
}

/** The view editor's labeled fields, the native select and the inputs. */
const fieldLabel = 'grid gap-[3px] text-xs text-muted-foreground';
const field =
    'h-8 w-full min-w-35 rounded-md border border-input bg-background px-2 text-base text-foreground shadow-none outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-[13px] dark:bg-background';
const formButton = 'h-7 rounded-md px-2.5 text-[13px] font-normal shadow-none';

function ViewEditor({
    saved,
    spaceId,
    columns,
    onRun,
    onSave,
    onCancel,
    onRemove,
}: {
    saved: ViewDraft;
    spaceId?: string;
    columns: string[];
    onRun: (draft: ViewDraft) => void;
    onSave: (draft: ViewDraft) => void;
    onCancel?: () => void;
    onRemove: () => void;
}) {
    const { t } = useTranslation(['pages.editor']);
    const [draft, setDraft] = useState<ViewDraft>(saved);
    const [datasets, setDatasets] = useState<DatasetView[]>();
    const [loadError, setLoadError] = useState('');
    useEffect(() => {
        let live = true;
        api<DatasetView[]>('/data/datasets').then(
            (all) => live && setDatasets(usableDatasets(all, spaceId)),
            (error: unknown) =>
                live && setLoadError(error instanceof Error ? error.message : t('pages.editor:view.form.list-failed')),
        );
        return () => {
            live = false;
        };
    }, [spaceId, t]);
    /** Auto-refresh's choice, in words: off, or every so many seconds, minutes or hours. */
    const every = (seconds: number) =>
        !seconds
            ? t('pages.editor:view.refresh-every.off')
            : seconds % 3600 === 0
              ? t('pages.editor:view.refresh-every.hours', { count: seconds / 3600 })
              : seconds % 60 === 0
                ? t('pages.editor:view.refresh-every.minutes', { count: seconds / 60 })
                : t('pages.editor:view.refresh-every.seconds', { count: seconds });
    const set = (patch: Partial<ViewDraft>) => setDraft({ ...draft, ...patch });
    const ready = !!(draft.datasetId && draft.query.trim());
    const known = datasets?.some((dataset) => dataset.id === draft.datasetId);
    const columnField = (key: 'x' | 'y', label: string) =>
        columns.length ? (
            <label className={fieldLabel}>
                {label}
                <select
                    data-slot="native-select"
                    className={field}
                    value={draft[key] ?? ''}
                    onChange={(event) => set({ [key]: event.target.value || undefined })}
                >
                    <option value="">
                        {key === 'x'
                            ? t('pages.editor:view.form.first-column')
                            : t('pages.editor:view.form.first-numbers')}
                    </option>
                    {columns.map((column) => (
                        <option key={column} value={column}>
                            {column}
                        </option>
                    ))}
                    {draft[key] && !columns.includes(draft[key]) && <option value={draft[key]}>{draft[key]}</option>}
                </select>
            </label>
        ) : (
            <label className={fieldLabel}>
                {label}
                <Input
                    className={field}
                    value={draft[key] ?? ''}
                    placeholder={
                        key === 'x'
                            ? t('pages.editor:view.form.first-column')
                            : t('pages.editor:view.form.first-numbers')
                    }
                    onChange={(event) => set({ [key]: event.target.value || undefined })}
                />
            </label>
        );
    return (
        <form
            className="grid gap-2.5 border-b bg-muted p-3"
            aria-label={t('pages.editor:view.form.label')}
            onSubmit={(event) => {
                event.preventDefault();
                if (ready) {
                    onSave(draft);
                }
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape' && onCancel) {
                    event.stopPropagation();
                    onCancel();
                }
            }}
        >
            <div className="flex flex-wrap gap-2.5">
                <label className={fieldLabel}>
                    {t('pages.editor:view.form.dataset')}
                    <select
                        data-slot="native-select"
                        className={field}
                        aria-label={t('pages.editor:view.form.dataset')}
                        value={draft.datasetId}
                        onChange={(event) => set({ datasetId: event.target.value })}
                    >
                        <option value="">
                            {datasets ? t('pages.editor:view.form.choose') : t('pages.editor:view.form.loading')}
                        </option>
                        {datasets?.map((dataset) => (
                            <option key={dataset.id} value={dataset.id}>
                                {dataset.access !== 'owner'
                                    ? t('pages.editor:view.form.shared-by', {
                                          name: dataset.name,
                                          owner: dataset.ownerName ?? t('pages.editor:view.form.another-user'),
                                      })
                                    : dataset.sharedSpaceId === spaceId
                                      ? t('pages.editor:view.form.shared-here', { name: dataset.name })
                                      : dataset.name}
                            </option>
                        ))}
                        {draft.datasetId && datasets && !known && (
                            <option value={draft.datasetId}>{t('pages.editor:view.form.unknown')}</option>
                        )}
                    </select>
                </label>
                <label className={fieldLabel}>
                    {t('pages.editor:view.form.display')}
                    <select
                        data-slot="native-select"
                        className={field}
                        aria-label={t('pages.editor:view.form.display')}
                        value={draft.display}
                        onChange={(event) => set({ display: event.target.value as ViewDisplay })}
                    >
                        {VIEW_DISPLAYS.map((display) => (
                            <option key={display} value={display}>
                                {t(`pages.editor:view.displays.${display}`)}
                            </option>
                        ))}
                    </select>
                </label>
                {draft.display !== 'table' && (
                    <>
                        {columnField('x', t('pages.editor:view.form.x'))}
                        {columnField('y', t('pages.editor:view.form.values'))}
                    </>
                )}
                <label className={fieldLabel}>
                    {t('pages.editor:view.form.title')}
                    <Input
                        className={field}
                        aria-label={t('pages.editor:view.form.title-label')}
                        value={draft.title ?? ''}
                        maxLength={160}
                        placeholder={t('pages.editor:view.form.title-placeholder')}
                        onChange={(event) => set({ title: event.target.value || undefined })}
                    />
                </label>
                <label className={fieldLabel}>
                    {t('pages.editor:view.form.auto-refresh')}
                    <select
                        data-slot="native-select"
                        className={field}
                        aria-label={t('pages.editor:view.form.auto-refresh')}
                        value={draft.refresh ?? 0}
                        onChange={(event) => set({ refresh: Number(event.target.value) || undefined })}
                    >
                        {REFRESH_CHOICES.map((seconds) => (
                            <option key={seconds} value={seconds}>
                                {every(seconds)}
                            </option>
                        ))}
                        {draft.refresh && !REFRESH_CHOICES.some((s) => s === draft.refresh) && (
                            <option value={draft.refresh}>
                                {t('pages.editor:view.refresh-every.seconds', { count: draft.refresh })}
                            </option>
                        )}
                    </select>
                </label>
            </div>
            <label className={fieldLabel}>
                {t('pages.editor:view.form.query')}
                <Textarea
                    className={cn(field, 'field-sizing-fixed h-auto min-h-0 resize-y py-2 font-mono')}
                    aria-label={t('pages.editor:view.form.query-label')}
                    spellCheck={false}
                    rows={3}
                    maxLength={20_000}
                    value={draft.query}
                    placeholder={t('pages.editor:view.form.query-placeholder')}
                    onChange={(event) => set({ query: event.target.value })}
                    onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault();
                            if (ready) {
                                onRun(draft);
                            }
                        }
                    }}
                />
            </label>
            <p className="m-0 text-xs text-muted-foreground">{t('pages.editor:view.form.rule')}</p>
            {loadError && (
                <p className="dataset-view-state" data-state="error" role="alert">
                    {loadError}
                </p>
            )}
            <div className="flex gap-2">
                <Button
                    type="button"
                    variant="outline"
                    className={formButton}
                    disabled={!ready}
                    onClick={() => onRun(draft)}
                    title={t('pages.editor:view.form.run-hint')}
                >
                    {t('pages.editor:view.form.run')}
                </Button>
                <Button type="submit" className={formButton} disabled={!ready}>
                    {t('pages.editor:view.form.save')}
                </Button>
                {onCancel && (
                    <Button type="button" variant="outline" className={formButton} onClick={onCancel}>
                        {t('pages.editor:view.form.cancel')}
                    </Button>
                )}
                <Button
                    type="button"
                    variant="outline"
                    className={cn(formButton, 'ml-auto text-destructive hover:text-destructive')}
                    onClick={onRemove}
                >
                    {t('pages.editor:view.form.remove')}
                </Button>
            </div>
        </form>
    );
}
