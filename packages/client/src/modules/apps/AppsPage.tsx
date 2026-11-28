import { Bug, ExternalLink, Power, RefreshCw, Rocket, ScrollText, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type {
    AppAttemptSummary,
    AppAttemptsState,
    AppDirectoryEntry,
    AppHealth,
    AppView,
    AppsState,
} from '@socio/shared/apps/app-types';
import { dateTimeFormat } from '@socio/shared/locale';
import { MODULE_IDS } from '@socio/shared/modules';

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';
import { openReport } from '../issues/report';

import { openApp } from './launch';
import { PromoteDialog } from './PromoteDialog';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/** Native selects; `data-slot` keeps the legacy element styles off them. */
const fieldClass = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs dark:bg-input/30';

/** Each kind's badge; its words are apps' (`kind.<status>`). */
const KIND = {
    ephemeral: 'outline',
    packaged: 'outline',
    promoted: 'secondary',
    unpublished: 'outline',
} as const;

/** Whether an app runs, as its badge says it (`apps:state.<id>`). */
function status(app: AppView) {
    if (app.status === 'unpublished') {
        return { id: 'stopped', variant: 'outline' } as const;
    }
    if (app.status === 'promoted') {
        return app.runtime === 'running'
            ? ({ id: 'running', variant: 'default' } as const)
            : app.runtime === 'failed'
              ? ({ id: 'failed', variant: 'destructive' } as const)
              : app.runtime === 'starting'
                ? ({ id: 'starting', variant: 'outline' } as const)
                : ({ id: 'not-running', variant: 'outline' } as const);
    }
    if (app.computer === 'running') {
        return app.answering
            ? ({ id: 'running', variant: 'default' } as const)
            : ({ id: 'not-answering', variant: 'outline' } as const);
    }
    if (app.computer === 'stopped') {
        return { id: 'computer-stopped', variant: 'secondary' } as const;
    }
    return { id: 'unavailable', variant: 'outline' } as const;
}

/** A time on this page, in the reader's locale and zone. */
const timeFormat = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' });
const time = (ms: number) => timeFormat.format(ms);

/** A server's sentence, ending with one period. */
const sentence = (text: string) => text.replace(/\.?$/, '.');

/**
 * Self-healing (CB-291), for its owner and admins: what the platform is
 * doing about it now, and its last repair that held. Nothing when it is
 * healthy and never needed one.
 */
function useHealthLine() {
    const { t } = useTranslation(['apps']);
    return (health: AppHealth | undefined) => {
        if (!health) {
            return null;
        }
        const last = health.lastRecoveryAt
            ? t('apps:health.last-recovered', {
                  when: time(health.lastRecoveryAt),
                  reason: health.lastRecoveryReason ?? t('apps:health.repaired'),
              })
            : null;
        if (health.state === 'healthy') {
            return last ? { tone: 'muted' as const, text: last } : null;
        }
        const parts = [
            health.state === 'recovering'
                ? t('apps:health.recovering')
                : health.state === 'degraded'
                  ? health.nextAttemptAt
                      ? t('apps:health.degraded-next', { when: time(health.nextAttemptAt) })
                      : t('apps:health.degraded')
                  : t('apps:health.gave-up', { count: health.attempts }),
            health.reason ? sentence(health.reason) : '',
            health.attempts && health.state !== 'failed'
                ? t('apps:health.attempt', { attempt: health.attempts, count: health.maxAttempts })
                : '',
            health.lastError && health.state !== 'recovering'
                ? t('apps:health.last-error', { error: sentence(health.lastError) })
                : '',
            last ?? '',
        ];
        return {
            tone: health.state === 'recovering' ? ('muted' as const) : ('alert' as const),
            text: parts.filter(Boolean).join(' '),
        };
    };
}

/** Deleting a promoted app: what happens to its data is said, not assumed. Its words load on demand (apps.dialogs). */
function DeleteForm({ app, onClose, onDone }: { app: AppView; onClose: () => void; onDone: () => void }) {
    const { t } = useTranslation(['apps.dialogs']);
    const [data, setData] = useState<'keep' | 'delete'>();
    const [busy, setBusy] = useState(false);
    const remove = async () => {
        if (!data) {
            return;
        }
        setBusy(true);
        try {
            const result = await api<{ deletedDatasets?: string[] }>(
                `/apps/${encodeURIComponent(app.id)}/delete`,
                'POST',
                { data },
            );
            toast.success(
                result.deletedDatasets?.length
                    ? t('apps.dialogs:delete.deleted-with', { name: app.name, datasets: result.deletedDatasets })
                    : t('apps.dialogs:delete.deleted', { name: app.name }),
            );
            onDone();
        } catch (e) {
            failed(e, t('apps.dialogs:delete.failed'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="delete-app-dialog">
                <DialogHeader>
                    <DialogTitle>{t('apps.dialogs:delete.title', { name: app.name })}</DialogTitle>
                    <DialogDescription>{t('apps.dialogs:delete.description')}</DialogDescription>
                </DialogHeader>
                <fieldset className="grid gap-2 text-sm">
                    <legend className="mb-1 font-medium">{t('apps.dialogs:delete.data')}</legend>
                    <label className="flex items-start gap-2">
                        <input
                            type="radio"
                            name="app-data"
                            checked={data === 'keep'}
                            onChange={() => setData('keep')}
                        />
                        <span>
                            {t('apps.dialogs:delete.keep')}
                            <span className="block text-muted-foreground">
                                {app.datasetNames.length
                                    ? t('apps.dialogs:delete.keep-named', { datasets: app.datasetNames })
                                    : t('apps.dialogs:delete.keep-detail')}
                            </span>
                        </span>
                    </label>
                    <label className="flex items-start gap-2">
                        <input
                            type="radio"
                            name="app-data"
                            checked={data === 'delete'}
                            onChange={() => setData('delete')}
                        />
                        <span>
                            {t('apps.dialogs:delete.remove')}
                            <span className="block text-muted-foreground">
                                {t('apps.dialogs:delete.remove-detail')}
                            </span>
                        </span>
                    </label>
                </fieldset>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        {t('apps.dialogs:delete.cancel')}
                    </Button>
                    <Button variant="destructive" disabled={!data || busy} onClick={() => void remove()}>
                        {t('apps.dialogs:delete.delete')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** An attempt in a line: what it was and how it ended (CB-146). */
function useAttemptLabel() {
    const { t } = useTranslation(['apps.dialogs']);
    return (attempt: AppAttemptSummary) => {
        const how =
            attempt.state === 'running'
                ? attempt.kind === 'start' && attempt.upAt
                    ? t('apps.dialogs:attempt.running')
                    : t('apps.dialogs:attempt.in-progress')
                : attempt.state === 'succeeded'
                  ? t('apps.dialogs:attempt.done')
                  : attempt.reason === 'oom'
                    ? t('apps.dialogs:attempt.oom')
                    : attempt.reason === 'health_check'
                      ? t('apps.dialogs:attempt.never-answered')
                      : attempt.reason === 'lost'
                        ? t('apps.dialogs:attempt.lost')
                        : attempt.state === 'stopped'
                          ? t('apps.dialogs:attempt.stopped')
                          : attempt.exitCode !== null
                            ? t('apps.dialogs:attempt.exit', { code: attempt.exitCode })
                            : attempt.signal
                              ? t('apps.dialogs:attempt.signal', { signal: attempt.signal })
                              : t('apps.dialogs:attempt.failed');
        return t('apps.dialogs:attempt.label', { context: attempt.kind, version: attempt.version, how });
    };
}

/**
 * A promoted app's build and start attempts in the runtime (its owner's and admins',
 * CB-146): each one's exit reason, times and its own last lines; the
 * newest first.
 */
function LogsView({ app, onClose }: { app: AppView; onClose: () => void }) {
    const { t } = useTranslation(['apps.dialogs']);
    const attemptLabel = useAttemptLabel();
    const [state, setState] = useState<AppAttemptsState>();
    const [chosen, setChosen] = useState<number>();
    useEffect(() => {
        setState(undefined);
        api<AppAttemptsState>(`/apps/${encodeURIComponent(app.id)}/attempts${chosen ? `?attempt=${chosen}` : ''}`)
            .then(setState)
            .catch((e) => {
                failed(e, t('apps.dialogs:logs.load-failed'));
                setState({ attempts: [], attempt: null, note: t('apps.dialogs:logs.none') });
            });
    }, [app.id, chosen, t]);
    const attempt = state?.attempt;
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-3xl" data-slot="app-logs-dialog">
                <DialogHeader>
                    <DialogTitle>{t('apps.dialogs:logs.title', { name: app.name })}</DialogTitle>
                    <DialogDescription>{t('apps.dialogs:logs.description')}</DialogDescription>
                </DialogHeader>
                {!state ? (
                    <Skeleton className="h-40" />
                ) : (
                    <div className="grid gap-3 text-sm">
                        {state.attempts.length > 0 && (
                            <label className="flex flex-wrap items-center gap-2">
                                {t('apps.dialogs:logs.attempt')}
                                <select
                                    data-slot="app-attempt"
                                    className={fieldClass}
                                    value={attempt?.attempt ?? ''}
                                    onChange={(event) => setChosen(Number(event.target.value))}
                                >
                                    {!attempt && (
                                        <option value="" disabled>
                                            {t('apps.dialogs:logs.choose')}
                                        </option>
                                    )}
                                    {state.attempts.map((item) => (
                                        <option key={item.attempt} value={item.attempt}>
                                            {t('apps.dialogs:logs.option', {
                                                attempt: item.attempt,
                                                label: attemptLabel(item),
                                                when: time(item.startedAt),
                                            })}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        {!attempt ? (
                            <>
                                <p className="text-muted-foreground">{state.note}</p>
                                {state.runtimeLog && (
                                    <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 text-xs">
                                        {state.runtimeLog.length
                                            ? state.runtimeLog.join('\n')
                                            : t('apps.dialogs:logs.no-output')}
                                    </pre>
                                )}
                            </>
                        ) : (
                            <>
                                <div className="grid gap-1" data-slot="app-attempt-summary">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant={attempt.state === 'failed' ? 'destructive' : 'outline'}>
                                            {attemptLabel(attempt)}
                                        </Badge>
                                    </div>
                                    {attempt.message && <div>{attempt.message}</div>}
                                    <div className="text-muted-foreground">
                                        {[
                                            t('apps.dialogs:logs.started', { when: time(attempt.startedAt) }),
                                            attempt.upAt
                                                ? t('apps.dialogs:logs.answered', { when: time(attempt.upAt) })
                                                : '',
                                            attempt.endedAt
                                                ? t('apps.dialogs:logs.ended', { when: time(attempt.endedAt) })
                                                : '',
                                        ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </div>
                                </div>
                                <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 text-xs">
                                    {attempt.dropped
                                        ? `${t('apps.dialogs:logs.dropped', { count: attempt.dropped })}\n`
                                        : ''}
                                    {attempt.lines.length ? attempt.lines.join('\n') : t('apps.dialogs:logs.no-output')}
                                </pre>
                            </>
                        )}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

const DeleteDialog = onDemand(['apps.dialogs'], DeleteForm);
const LogsDialog = onDemand(['apps.dialogs'], LogsView);

/**
 * Unregistering an ephemeral or packaged app, confirmed. Its words load on
 * demand (apps.dialogs).
 */
const UnregisterDialog = onDemand(
    ['apps.dialogs'],
    function UnregisterConfirm({
        app,
        onClose,
        onConfirm,
    }: {
        app: AppView;
        onClose: () => void;
        onConfirm: () => Promise<void>;
    }) {
        const { t } = useTranslation(['apps.dialogs']);
        return (
            <ConfirmDelete
                title={t('apps.dialogs:unregister.title', { name: app.name })}
                action={t('apps.dialogs:unregister.action')}
                slot="unregister-app-dialog"
                onClose={onClose}
                onConfirm={onConfirm}
            >
                {t('apps.dialogs:unregister.description')}
            </ConfirmDelete>
        );
    },
);

/**
 * The live apps an admin can't open (CB-442): by name and owner
 * only. No open, logs, settings or report: opening one stays with its owner
 * and the people of the Space it is shared with.
 */
function OtherApps({ apps }: { apps: readonly AppDirectoryEntry[] }) {
    const { t } = useTranslation(['apps']);
    return (
        <Card data-slot="apps-others">
            <CardHeader>
                <CardTitle>{t('apps:others.title')}</CardTitle>
                <CardDescription>{t('apps:others.description')}</CardDescription>
            </CardHeader>
            <CardContent>
                <ul className="grid gap-1 text-sm">
                    {apps.map((app) => (
                        <li key={app.id} data-slot="apps-other" className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-medium">{app.name}</span>
                            <span className="text-muted-foreground">
                                {t('apps:others.by', { name: app.ownerName })}
                            </span>
                        </li>
                    ))}
                </ul>
            </CardContent>
        </Card>
    );
}

/**
 * `/apps`: the signed-in user's mini apps and those shared with their
 * Spaces. Open signs in on the app's own origin; owners share an app with a
 * Space or unregister it. Dots register apps (`app_register`) and package
 * them (`app_package`); owners promote a packaged app into the workspace
 * (`?promote=<id>` opens the wizard), roll back, unpublish or delete it.
 * "Report issue" on an app files one about it (CB-442). Admins also see,
 * apart, the apps they can't open, by name and owner only.
 */
export function AppsPage() {
    const { t } = useTranslation(['apps']);
    const healthLine = useHealthLine();
    const shell = useShell();
    const [state, setState] = useState<AppsState>();
    const [busy, setBusy] = useState(false);
    const [params, setParams] = useSearchParams();
    const [deleting, setDeleting] = useState<AppView>();
    const [unregistering, setUnregistering] = useState<AppView>();
    const [logs, setLogs] = useState<AppView>();
    const promoting = params.get('promote');
    const setPromoting = (id: string | null) =>
        setParams(
            (current) => {
                const next = new URLSearchParams(current);
                if (id) {
                    next.set('promote', id);
                } else {
                    next.delete('promote');
                }
                return next;
            },
            { replace: true },
        );
    const load = useCallback(() => {
        setBusy(true);
        return api<AppsState>('/apps')
            .then(setState)
            .catch((e) => failed(e, t('apps:load-failed')))
            .finally(() => setBusy(false));
    }, [t]);
    useEffect(() => void load(), [load]);
    const share = async (app: AppView, sharedSpaceId: string | null) => {
        try {
            await api(`/apps/${encodeURIComponent(app.id)}`, 'PATCH', {
                sharedSpaceId,
            });
            await load();
        } catch (e) {
            failed(e, t('apps:share-failed'));
        }
    };
    const act = async (app: AppView, verb: string, done: string) => {
        try {
            const result = await api<{ warning?: string }>(`/apps/${encodeURIComponent(app.id)}/${verb}`, 'POST', {});
            if (result.warning) {
                toast.warning(result.warning);
            } else {
                toast.success(done);
            }
            await load();
        } catch (e) {
            failed(e, t('apps:action-failed'));
        }
    };
    const unregister = async (app: AppView) => {
        try {
            await api(`/apps/${encodeURIComponent(app.id)}`, 'DELETE');
            toast.success(t('apps:unregistered', { name: app.name }));
            setUnregistering(undefined);
            await load();
        } catch (e) {
            failed(e, t('apps:unregister-failed'));
        }
    };
    return (
        <WorkspacePage
            slot="apps-page"
            module={MODULE_IDS.apps}
            title={t('apps:title')}
            actions={
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
                    <RefreshCw className="size-4" /> {t('apps:refresh')}
                </Button>
            }
            description={t('apps:description')}
        >
            {!state ? (
                <Skeleton className="h-40" />
            ) : !state.enabled ? (
                <Card>
                    <CardHeader>
                        <CardTitle>{t('apps:not-set-up.title')}</CardTitle>
                        <CardDescription>{t('apps:not-set-up.description')}</CardDescription>
                    </CardHeader>
                </Card>
            ) : !state.apps.length ? (
                <Card>
                    <CardHeader>
                        <CardTitle>{t('apps:empty.title')}</CardTitle>
                        <CardDescription>{t('apps:empty.description')}</CardDescription>
                    </CardHeader>
                </Card>
            ) : (
                <div className="grid gap-4" data-slot="apps-list">
                    {state.apps.map((app) => {
                        const badge = status(app);
                        return (
                            <Card key={app.id} data-slot="app-card">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        {app.name}
                                        <Badge variant={KIND[app.status]}>{t(`apps:kind.${app.status}`)}</Badge>
                                        <Badge variant={badge.variant}>{t(`apps:state.${badge.id}`)}</Badge>
                                    </CardTitle>
                                    <CardDescription>
                                        {[
                                            app.description,
                                            app.dotName,
                                            app.owner ? '' : t('apps:card.shared-by', { name: app.ownerName ?? '' }),
                                            app.liveVersion
                                                ? t('apps:card.version', { version: app.liveVersion })
                                                : t('apps:card.port', { port: app.port }),
                                        ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </CardDescription>
                                    <CardAction className="flex items-center gap-1">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-8"
                                            aria-label={t('apps:card.report-label', { name: app.name })}
                                            title={t('apps:card.report')}
                                            data-slot="app-report-issue"
                                            onClick={(event) =>
                                                openReport(
                                                    { components: [`app:${app.id}`] },
                                                    { returnFocus: event.currentTarget },
                                                )
                                            }
                                        >
                                            <Bug className="size-4" />
                                        </Button>
                                        <Button
                                            size="sm"
                                            disabled={app.status === 'unpublished'}
                                            onClick={() =>
                                                void openApp(app.id).catch((e) => failed(e, t('apps:open-failed')))
                                            }
                                        >
                                            <ExternalLink className="size-4" /> {t('apps:card.open')}
                                        </Button>
                                    </CardAction>
                                </CardHeader>
                                <CardContent className="grid gap-3 text-sm">
                                    <div className="text-muted-foreground break-all">{app.url}</div>
                                    {!!app.needsSetup?.length && (
                                        <div className="text-destructive" data-slot="app-needs-setup">
                                            {t('apps:card.needs-setup', {
                                                count: app.needsSetup.length,
                                                names: app.needsSetup,
                                            })}
                                        </div>
                                    )}
                                    {(() => {
                                        const line = healthLine(app.health);
                                        return line ? (
                                            <div
                                                className={
                                                    line.tone === 'alert' ? 'text-destructive' : 'text-muted-foreground'
                                                }
                                                data-slot="app-health"
                                            >
                                                {line.text}
                                            </div>
                                        ) : null;
                                    })()}
                                    {app.owner && (
                                        <>
                                            {app.lastAttempt?.state === 'failed' && (
                                                <div className="text-destructive" data-slot="app-last-attempt">
                                                    {[
                                                        app.lastAttempt.kind === 'build'
                                                            ? t('apps:card.build-failed', {
                                                                  version: app.lastAttempt.version,
                                                              })
                                                            : t('apps:card.start-failed'),
                                                        time(app.lastAttempt.endedAt ?? app.lastAttempt.startedAt),
                                                        app.lastAttempt.message ?? '',
                                                    ]
                                                        .filter(Boolean)
                                                        .join(' · ')}
                                                </div>
                                            )}
                                            <div className="text-muted-foreground">
                                                {t('apps:card.data', { datasets: app.datasetNames })}
                                            </div>
                                            <div className="flex flex-wrap items-center gap-3">
                                                <label className="flex items-center gap-2">
                                                    {t('apps:card.shared-with')}
                                                    <select
                                                        data-slot="app-share"
                                                        className={fieldClass}
                                                        value={app.sharedSpaceId ?? ''}
                                                        onChange={(event) =>
                                                            void share(app, event.target.value || null)
                                                        }
                                                    >
                                                        <option value="">{t('apps:card.only-me')}</option>
                                                        {shell.workspace.spaces.map((space) => (
                                                            <option key={space.id} value={space.id}>
                                                                {space.name}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </label>
                                                {app.status === 'packaged' && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() => setPromoting(app.id)}
                                                    >
                                                        <Rocket className="size-4" /> {t('apps:card.promote')}
                                                    </Button>
                                                )}
                                                {app.status === 'promoted' && app.previousVersion && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            void act(
                                                                app,
                                                                'rollback',
                                                                t('apps:card.rolled-back', {
                                                                    name: app.name,
                                                                    version: app.previousVersion ?? '',
                                                                }),
                                                            )
                                                        }
                                                    >
                                                        <Undo2 className="size-4" />{' '}
                                                        {t('apps:card.rollback', { version: app.previousVersion })}
                                                    </Button>
                                                )}
                                                {app.status === 'promoted' && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            void act(
                                                                app,
                                                                'unpublish',
                                                                t('apps:card.unpublished', { name: app.name }),
                                                            )
                                                        }
                                                    >
                                                        <Power className="size-4" /> {t('apps:card.unpublish')}
                                                    </Button>
                                                )}
                                                {app.status === 'unpublished' && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            void act(
                                                                app,
                                                                'publish',
                                                                t('apps:card.published', { name: app.name }),
                                                            )
                                                        }
                                                    >
                                                        <Power className="size-4" /> {t('apps:card.publish')}
                                                    </Button>
                                                )}
                                                {(app.status === 'promoted' ||
                                                    app.status === 'unpublished' ||
                                                    !!app.lastAttempt) && (
                                                    <Button size="sm" variant="ghost" onClick={() => setLogs(app)}>
                                                        <ScrollText className="size-4" /> {t('apps:card.logs')}
                                                    </Button>
                                                )}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() =>
                                                        app.status === 'promoted' || app.status === 'unpublished'
                                                            ? setDeleting(app)
                                                            : setUnregistering(app)
                                                    }
                                                >
                                                    <Trash2 className="size-4" />{' '}
                                                    {app.status === 'promoted' || app.status === 'unpublished'
                                                        ? t('apps:card.delete')
                                                        : t('apps:card.unregister')}
                                                </Button>
                                            </div>
                                            {!!app.versions?.length && (
                                                <details data-slot="app-versions">
                                                    <summary className="cursor-pointer text-muted-foreground">
                                                        {t('apps:versions.count', { count: app.versions.length })}
                                                    </summary>
                                                    <ul className="mt-2 grid gap-1">
                                                        {app.versions.map((version) => (
                                                            <li key={version.version}>
                                                                {t('apps:versions.line', {
                                                                    context:
                                                                        version.version === app.liveVersion
                                                                            ? 'live'
                                                                            : version.version === app.previousVersion
                                                                              ? 'previous'
                                                                              : undefined,
                                                                    version: version.version,
                                                                    count: version.files,
                                                                    when: time(version.createdAt),
                                                                })}
                                                                {version.changes.length > 0 && (
                                                                    <span className="block text-muted-foreground">
                                                                        {version.changes.join(' · ')}
                                                                    </span>
                                                                )}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </details>
                                            )}
                                        </>
                                    )}
                                    {!app.owner &&
                                        app.canReadLogs &&
                                        (app.status === 'promoted' ||
                                            app.status === 'unpublished' ||
                                            !!app.lastAttempt) && (
                                            <div>
                                                <Button size="sm" variant="ghost" onClick={() => setLogs(app)}>
                                                    <ScrollText className="size-4" /> {t('apps:card.logs')}
                                                </Button>
                                            </div>
                                        )}
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}
            {state?.enabled && !!state.others?.length && <OtherApps apps={state.others} />}
            {promoting && (
                <PromoteDialog
                    appId={promoting}
                    onClose={() => setPromoting(null)}
                    onDone={() => {
                        setPromoting(null);
                        void load();
                    }}
                />
            )}
            {deleting && (
                <DeleteDialog
                    app={deleting}
                    onClose={() => setDeleting(undefined)}
                    onDone={() => {
                        setDeleting(undefined);
                        void load();
                    }}
                />
            )}
            {unregistering && (
                <UnregisterDialog
                    app={unregistering}
                    onClose={() => setUnregistering(undefined)}
                    onConfirm={() => unregister(unregistering)}
                />
            )}
            {logs && <LogsDialog app={logs} onClose={() => setLogs(undefined)} />}
        </WorkspacePage>
    );
}
