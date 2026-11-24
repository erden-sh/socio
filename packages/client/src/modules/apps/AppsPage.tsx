import { Bug, ExternalLink, Power, RefreshCw, Rocket, ScrollText, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import type {
    AppAttemptSummary,
    AppAttemptsState,
    AppDirectoryEntry,
    AppHealth,
    AppView,
    AppsState,
} from '@socio/shared/apps/app-types';
import { MODULE_IDS } from '@socio/shared/modules';

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

const KIND = {
    ephemeral: { label: 'Ephemeral', variant: 'outline' },
    packaged: { label: 'Packaged', variant: 'outline' },
    promoted: { label: 'Workspace app', variant: 'secondary' },
    unpublished: { label: 'Unpublished', variant: 'outline' },
} as const;

function status(app: AppView) {
    if (app.status === 'unpublished') {
        return { label: 'Stopped', variant: 'outline' as const };
    }
    if (app.status === 'promoted') {
        return app.runtime === 'running'
            ? { label: 'Running', variant: 'default' as const }
            : app.runtime === 'failed'
              ? { label: 'Failed', variant: 'destructive' as const }
              : app.runtime === 'starting'
                ? { label: 'Starting', variant: 'outline' as const }
                : { label: 'Not running', variant: 'outline' as const };
    }
    if (app.computer === 'running') {
        return app.answering
            ? { label: 'Running', variant: 'default' as const }
            : { label: 'Not answering', variant: 'outline' as const };
    }
    if (app.computer === 'stopped') {
        return { label: 'Computer stopped', variant: 'secondary' as const };
    }
    return { label: 'Unavailable', variant: 'outline' as const };
}

/**
 * Self-healing (CB-291), for its owner and admins: what the platform is
 * doing about it now, and its last repair that held. Nothing when it is
 * healthy and never needed one.
 */
function healthLine(health: AppHealth | undefined, when: (at: number) => string) {
    if (!health) {
        return null;
    }
    const last = health.lastRecoveryAt
        ? `Last recovered ${when(health.lastRecoveryAt)}: ${health.lastRecoveryReason ?? 'repaired'}.`
        : null;
    if (health.state === 'healthy') {
        return last ? { tone: 'muted' as const, text: last } : null;
    }
    const why = health.reason ? ` ${health.reason.replace(/\.?$/, '.')}` : '';
    const error = health.lastError ? ` Last error: ${health.lastError.replace(/\.?$/, '.')}` : '';
    const tries = health.attempts ? ` Attempt ${health.attempts} of ${health.maxAttempts}.` : '';
    const text =
        health.state === 'recovering'
            ? `Recovering by itself; its data is kept.${why}${tries}`
            : health.state === 'degraded'
              ? `Degraded; it is repaired automatically${health.nextAttemptAt ? `, next try ${when(health.nextAttemptAt)}` : ''}.${why}${tries}${error}`
              : `Automatic repair gave up after ${health.attempts} attempts; admins were told. Its data is kept; press Start to try again.${why}${error}`;
    return {
        tone: health.state === 'recovering' ? ('muted' as const) : ('alert' as const),
        text: last ? `${text} ${last}` : text,
    };
}

/** Deleting a promoted app: what happens to its data is said, not assumed. */
function DeleteDialog({ app, onClose, onDone }: { app: AppView; onClose: () => void; onDone: () => void }) {
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
                    ? `Deleted ${app.name} and ${result.deletedDatasets.join(', ')}.`
                    : `Deleted ${app.name}.`,
            );
            onDone();
        } catch (e) {
            failed(e, 'Could not delete the app.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="delete-app-dialog">
                <DialogHeader>
                    <DialogTitle>Delete {app.name}?</DialogTitle>
                    <DialogDescription>
                        Its address stops working, everyone signed in to it is signed out, and it leaves your apps and
                        the launcher.
                    </DialogDescription>
                </DialogHeader>
                <fieldset className="grid gap-2 text-sm">
                    <legend className="mb-1 font-medium">Its data</legend>
                    <label className="flex items-start gap-2">
                        <input
                            type="radio"
                            name="app-data"
                            checked={data === 'keep'}
                            onChange={() => setData('keep')}
                        />
                        <span>
                            Keep it
                            <span className="block text-muted-foreground">
                                {app.datasetNames.join(', ') || 'Its datasets'} stay in your data space.
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
                            Delete the data it brought
                            <span className="block text-muted-foreground">
                                Datasets created when it was promoted are deleted; datasets it only used stay.
                            </span>
                        </span>
                    </label>
                </fieldset>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button variant="destructive" disabled={!data || busy} onClick={() => void remove()}>
                        Delete
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

const time = (ms: number) => new Date(ms).toLocaleString();

/** An attempt in a line: what it was and how it ended (CB-146). */
function attemptLabel(attempt: AppAttemptSummary) {
    const what = attempt.kind === 'build' ? 'Build' : 'Start';
    const how =
        attempt.state === 'running'
            ? attempt.kind === 'start' && attempt.upAt
                ? 'running'
                : 'in progress'
            : attempt.state === 'succeeded'
              ? 'done'
              : attempt.reason === 'oom'
                ? 'out of memory'
                : attempt.reason === 'health_check'
                  ? 'never answered'
                  : attempt.reason === 'lost'
                    ? 'end unknown'
                    : attempt.state === 'stopped'
                      ? 'stopped'
                      : attempt.exitCode !== null
                        ? `failed, exit ${attempt.exitCode}`
                        : attempt.signal
                          ? `failed, ${attempt.signal}`
                          : 'failed';
    return `${what} of version ${attempt.version} · ${how}`;
}

/**
 * A promoted app's build and start attempts in the runtime (its owner's and admins',
 * CB-146): each one's exit reason, times and its own last lines; the
 * newest first.
 */
function LogsDialog({ app, onClose }: { app: AppView; onClose: () => void }) {
    const [state, setState] = useState<AppAttemptsState>();
    const [chosen, setChosen] = useState<number>();
    useEffect(() => {
        setState(undefined);
        api<AppAttemptsState>(`/apps/${encodeURIComponent(app.id)}/attempts${chosen ? `?attempt=${chosen}` : ''}`)
            .then(setState)
            .catch((e) => {
                failed(e, 'Could not load the logs.');
                setState({ attempts: [], attempt: null, note: 'No logs to show.' });
            });
    }, [app.id, chosen]);
    const attempt = state?.attempt;
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-3xl" data-slot="app-logs-dialog">
                <DialogHeader>
                    <DialogTitle>{app.name} logs</DialogTitle>
                    <DialogDescription>
                        Each build and start of a version in the workspace app runtime, with how it ended and its own
                        last lines.
                    </DialogDescription>
                </DialogHeader>
                {!state ? (
                    <Skeleton className="h-40" />
                ) : (
                    <div className="grid gap-3 text-sm">
                        {state.attempts.length > 0 && (
                            <label className="flex flex-wrap items-center gap-2">
                                Attempt
                                <select
                                    data-slot="app-attempt"
                                    className={fieldClass}
                                    value={attempt?.attempt ?? ''}
                                    onChange={(event) => setChosen(Number(event.target.value))}
                                >
                                    {!attempt && (
                                        <option value="" disabled>
                                            Choose one
                                        </option>
                                    )}
                                    {state.attempts.map((item) => (
                                        <option key={item.attempt} value={item.attempt}>
                                            {item.attempt}. {attemptLabel(item)} · {time(item.startedAt)}
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
                                        {state.runtimeLog.length ? state.runtimeLog.join('\n') : 'No output.'}
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
                                        Started {time(attempt.startedAt)}
                                        {attempt.upAt ? ` · answered ${time(attempt.upAt)}` : ''}
                                        {attempt.endedAt ? ` · ended ${time(attempt.endedAt)}` : ''}
                                    </div>
                                </div>
                                <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 text-xs">
                                    {attempt.dropped ? `[${attempt.dropped} earlier lines not kept]\n` : ''}
                                    {attempt.lines.length ? attempt.lines.join('\n') : 'No output.'}
                                </pre>
                            </>
                        )}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

/**
 * The live apps an admin can't open (CB-442): by name and owner
 * only. No open, logs, settings or report: opening one stays with its owner
 * and the people of the Space it is shared with.
 */
function OtherApps({ apps }: { apps: readonly AppDirectoryEntry[] }) {
    return (
        <Card data-slot="apps-others">
            <CardHeader>
                <CardTitle>Other apps in the workspace</CardTitle>
                <CardDescription>
                    Shown to admins by name and owner. Only the owner and the people of the Space it’s shared with can
                    open one.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ul className="grid gap-1 text-sm">
                    {apps.map((app) => (
                        <li key={app.id} data-slot="apps-other" className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-medium">{app.name}</span>
                            <span className="text-muted-foreground">by {app.ownerName}</span>
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
            .catch((e) => failed(e, 'Could not load apps.'))
            .finally(() => setBusy(false));
    }, []);
    useEffect(() => void load(), [load]);
    const share = async (app: AppView, sharedSpaceId: string | null) => {
        try {
            await api(`/apps/${encodeURIComponent(app.id)}`, 'PATCH', {
                sharedSpaceId,
            });
            await load();
        } catch (e) {
            failed(e, 'Could not change sharing.');
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
            failed(e, 'That didn’t work.');
        }
    };
    const unregister = async (app: AppView) => {
        try {
            await api(`/apps/${encodeURIComponent(app.id)}`, 'DELETE');
            toast.success(`Unregistered ${app.name}.`);
            setUnregistering(undefined);
            await load();
        } catch (e) {
            failed(e, 'Could not unregister the app.');
        }
    };
    return (
        <WorkspacePage
            slot="apps-page"
            module={MODULE_IDS.apps}
            title="Apps"
            actions={
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
                    <RefreshCw className="size-4" /> Refresh
                </Button>
            }
            description="Mini apps your socios build, each on its own address behind your sign-in. An ephemeral app runs only while its socio’s computer runs it; once the socio packages it, promote it into a workspace app that runs on its own, with its data in your data space."
        >
            {!state ? (
                <Skeleton className="h-40" />
            ) : !state.enabled ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Mini apps are not set up</CardTitle>
                        <CardDescription>
                            An operator sets APPS_HOST (and a wildcard DNS entry and proxy host for it) to serve mini
                            apps. See docs/SETUP.md.
                        </CardDescription>
                    </CardHeader>
                </Card>
            ) : !state.apps.length ? (
                <Card>
                    <CardHeader>
                        <CardTitle>No apps yet</CardTitle>
                        <CardDescription>
                            Ask a socio to build you a small app (a tracker, a dashboard, a form). It runs it in its
                            computer and registers it here once you approve.
                        </CardDescription>
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
                                        <Badge variant={KIND[app.status].variant}>{KIND[app.status].label}</Badge>
                                        <Badge variant={badge.variant}>{badge.label}</Badge>
                                    </CardTitle>
                                    <CardDescription>
                                        {app.description ? `${app.description} · ` : ''}
                                        {app.dotName}
                                        {app.owner ? '' : ` · shared by ${app.ownerName}`}
                                        {app.liveVersion ? ` · version ${app.liveVersion}` : ` · port ${app.port}`}
                                    </CardDescription>
                                    <CardAction className="flex items-center gap-1">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-8"
                                            aria-label={`Report an issue about ${app.name}`}
                                            title="Report issue"
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
                                                void openApp(app.id).catch((e) => failed(e, 'Could not open the app.'))
                                            }
                                        >
                                            <ExternalLink className="size-4" /> Open
                                        </Button>
                                    </CardAction>
                                </CardHeader>
                                <CardContent className="grid gap-3 text-sm">
                                    <div className="text-muted-foreground break-all">{app.url}</div>
                                    {!!app.needsSetup?.length && (
                                        <div className="text-destructive" data-slot="app-needs-setup">
                                            Needs setup: {app.needsSetup.join(', ')}{' '}
                                            {app.needsSetup.length === 1 ? 'isn’t' : 'aren’t'} set. A workspace admin
                                            sets secrets in Settings → Secrets.
                                        </div>
                                    )}
                                    {(() => {
                                        const line = healthLine(app.health, time);
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
                                                    {app.lastAttempt.kind === 'build'
                                                        ? `Version ${app.lastAttempt.version} didn’t build`
                                                        : 'The last start failed'}{' '}
                                                    · {time(app.lastAttempt.endedAt ?? app.lastAttempt.startedAt)}
                                                    {app.lastAttempt.message ? ` · ${app.lastAttempt.message}` : ''}
                                                </div>
                                            )}
                                            <div className="text-muted-foreground">
                                                Data it may use: {app.datasetNames.join(', ')}
                                            </div>
                                            <div className="flex flex-wrap items-center gap-3">
                                                <label className="flex items-center gap-2">
                                                    Shared with
                                                    <select
                                                        data-slot="app-share"
                                                        className={fieldClass}
                                                        value={app.sharedSpaceId ?? ''}
                                                        onChange={(event) =>
                                                            void share(app, event.target.value || null)
                                                        }
                                                    >
                                                        <option value="">Only me</option>
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
                                                        <Rocket className="size-4" /> Promote…
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
                                                                `${app.name} is back on version ${app.previousVersion}.`,
                                                            )
                                                        }
                                                    >
                                                        <Undo2 className="size-4" /> Roll back to version{' '}
                                                        {app.previousVersion}
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
                                                                `${app.name} is unpublished; its data stays.`,
                                                            )
                                                        }
                                                    >
                                                        <Power className="size-4" /> Unpublish
                                                    </Button>
                                                )}
                                                {app.status === 'unpublished' && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            void act(app, 'publish', `${app.name} is published again.`)
                                                        }
                                                    >
                                                        <Power className="size-4" /> Publish
                                                    </Button>
                                                )}
                                                {(app.status === 'promoted' ||
                                                    app.status === 'unpublished' ||
                                                    !!app.lastAttempt) && (
                                                    <Button size="sm" variant="ghost" onClick={() => setLogs(app)}>
                                                        <ScrollText className="size-4" /> Logs
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
                                                        ? 'Delete…'
                                                        : 'Unregister'}
                                                </Button>
                                            </div>
                                            {!!app.versions?.length && (
                                                <details data-slot="app-versions">
                                                    <summary className="cursor-pointer text-muted-foreground">
                                                        {app.versions.length} version
                                                        {app.versions.length === 1 ? '' : 's'}
                                                    </summary>
                                                    <ul className="mt-2 grid gap-1">
                                                        {app.versions.map((version) => (
                                                            <li key={version.version}>
                                                                Version {version.version}
                                                                {version.version === app.liveVersion
                                                                    ? ' (live)'
                                                                    : version.version === app.previousVersion
                                                                      ? ' (previous)'
                                                                      : ''}{' '}
                                                                · {version.files} files ·{' '}
                                                                {new Date(version.createdAt).toLocaleString()}
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
                                                    <ScrollText className="size-4" /> Logs
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
                <ConfirmDelete
                    title={`Unregister ${unregistering.name}?`}
                    action="Unregister"
                    slot="unregister-app-dialog"
                    onClose={() => setUnregistering(undefined)}
                    onConfirm={() => unregister(unregistering)}
                >
                    Its address stops working, everyone signed in to it is signed out, and it leaves your apps.
                </ConfirmDelete>
            )}
            {logs && <LogsDialog app={logs} onClose={() => setLogs(undefined)} />}
        </WorkspacePage>
    );
}
