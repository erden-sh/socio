import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import {
    FINISHED_PHASES,
    releasesThrough,
    UPDATE_STALE_MAX_DAYS,
    type FeedRelease,
    type UpdateFeedKind,
    type UpdatePhase,
    type UpdateStaleness,
    type UpdatesView,
} from '@socio/shared/updates/updates';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { IssueMarkdown } from '../issues/IssueMarkdown';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

const dateTime = (value: number) => new Date(value).toLocaleString();
const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
// 16 px below md, so iOS doesn't zoom in on focus (CB-96).
const field =
    'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs md:text-sm dark:bg-input/30';

const PHASE: Record<UpdatePhase, string> = {
    backing_up: 'Backing up',
    checking: 'Checking',
    applying: 'Applying',
    verifying: 'Checking health',
    rolling_back: 'Rolling back',
    succeeded: 'Updated',
    rolled_back: 'Rolled back',
    failed: 'Not applied',
    rollback_failed: 'Rollback failed',
};

const bad = (phase: UpdatePhase) => phase === 'failed' || phase === 'rolled_back' || phase === 'rollback_failed';

/** The steps a release lists, as a short label. */
function stepsLabel(release: FeedRelease) {
    if (release.upgrading === null) {
        return 'Notes unavailable';
    }
    return release.upgrading.length
        ? `${release.upgrading.length} upgrading step${release.upgrading.length === 1 ? '' : 's'}`
        : 'No upgrading steps';
}

/**
 * The Platform page's "Updates" card (operators, CB-259): the running
 * build, the releases the configured feed has beyond it with their notes
 * and Upgrading steps, the feed's settings, and, with the updater sidecar,
 * a guided update: confirm the steps, then the app backs up and the
 * updater changes the image tags, checks health and rolls back on failure.
 * Polls while an update goes on; the app restarts in the middle of one.
 */
export function UpdatesCard() {
    const [view, setView] = useState<UpdatesView>();
    const [loadError, setLoadError] = useState('');
    const [busy, setBusy] = useState('');
    const [applying, setApplying] = useState<FeedRelease>();
    const load = useCallback(
        () =>
            api<UpdatesView>('/updates')
                .then((next) => {
                    setView(next);
                    setLoadError('');
                })
                .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Could not load updates.')),
        [],
    );
    useEffect(() => void load(), [load]);
    const job = view?.updater.status?.job;
    const active =
        view?.preparing?.phase === 'backing_up' ||
        !!view?.check.running ||
        (!!job && !FINISHED_PHASES.includes(job.phase));
    // While an update goes on (the app goes away and comes back during it).
    useEffect(() => {
        if (!active) {
            return;
        }
        const timer = setInterval(() => void load(), 3000);
        return () => clearInterval(timer);
    }, [active, load]);
    const act = async (key: string, action: () => Promise<unknown>) => {
        setBusy(key);
        try {
            await action();
        } catch (e) {
            failed(e, 'Could not do that.');
        } finally {
            setBusy('');
            await load();
        }
    };
    const updaterBusy = active || !!busy;
    return (
        <Card className="mt-6" data-slot="updates">
            <CardHeader>
                <CardTitle>Updates</CardTitle>
                <CardDescription>
                    Releases newer than this server, from the release feed you set below. Read each one&apos;s Upgrading
                    steps before updating. With the updater installed, an update backs up first, changes only the image
                    tags through Portainer, checks the new version&apos;s health and rolls back if it fails.
                </CardDescription>
                <CardAction>
                    <Button
                        variant="outline"
                        disabled={!view?.settings.feed || !!busy || !!view?.check.running}
                        onClick={() => act('check', () => api<UpdatesView>('/updates/check', 'POST'))}
                    >
                        {busy === 'check' || view?.check.running ? 'Checking…' : 'Check now'}
                    </Button>
                </CardAction>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
                {!view && !loadError && <Skeleton className="h-24" />}
                {loadError && (
                    <p className="text-destructive" role="status">
                        {active ? 'The app is restarting for the update; this page reconnects on its own.' : loadError}
                    </p>
                )}
                {view && (
                    <>
                        <div className="grid gap-1" data-slot="updates-current">
                            <p className="m-0">
                                This server runs <strong>Socio v{view.current.version}</strong>
                                {view.current.commit ? ` (${view.current.commit})` : ''}.
                            </p>
                            <CheckLine view={view} />
                            <UpdaterLine view={view} />
                        </div>
                        {view.stale && <StaleWarning stale={view.stale} version={view.current.version} />}
                        {view.preparing && (
                            <p
                                data-slot="updates-preparing"
                                className={
                                    view.preparing.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                                }
                                role="status"
                            >
                                {view.preparing.phase === 'backing_up'
                                    ? `Backing up before updating to ${view.preparing.target}…`
                                    : `The update to ${view.preparing.target} did not start: ${view.preparing.error}`}
                            </p>
                        )}
                        {job && <JobPanel view={view} />}
                        {view.available.length > 0 && (
                            <div className="grid gap-3" data-slot="updates-available">
                                {view.available.map((release) => (
                                    <ReleaseRow
                                        key={release.tag}
                                        release={release}
                                        canApply={view.updater.configured && !!view.updater.reachable}
                                        disabled={updaterBusy}
                                        autoTarget={view.autoTarget === release.tag}
                                        onApply={() => setApplying(release)}
                                    />
                                ))}
                            </div>
                        )}
                        <FeedSettings view={view} onSaved={setView} />
                    </>
                )}
            </CardContent>
            {applying && view && (
                <ApplyDialog
                    view={view}
                    release={applying}
                    onClose={() => setApplying(undefined)}
                    onStarted={() => {
                        setApplying(undefined);
                        void load();
                    }}
                />
            )}
        </Card>
    );
}

/**
 * The staleness warning (CB-323): a newer release is marked security, or
 * the newest came out more than the window after this one. A warning
 * only: nothing updates because of it.
 */
function StaleWarning({ stale, version }: { stale: UpdateStaleness; version: string }) {
    return (
        <div
            role="status"
            data-slot="updates-stale"
            data-reason={stale.reason}
            className="grid gap-1 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
        >
            <p className="m-0 font-medium">
                {stale.reason === 'security'
                    ? `${stale.security.join(', ')} ${stale.security.length === 1 ? 'fixes a security issue' : 'fix security issues'}: update soon.`
                    : `This server is ${stale.behindDays} days behind ${stale.newest}.`}
            </p>
            <p className="m-0">
                v{version}
                {stale.behindDays !== undefined && stale.behindDays > 0
                    ? ` came out ${stale.behindDays} day${stale.behindDays === 1 ? '' : 's'} before ${stale.newest}`
                    : ` is older than ${stale.newest}`}
                {stale.reason === 'age'
                    ? `, past the ${stale.staleDays}-day window set below.`
                    : '. Security releases warn right away.'}{' '}
                Read the notes below, then update.
            </p>
        </div>
    );
}

function CheckLine({ view }: { view: UpdatesView }) {
    const { check, settings } = view;
    if (!settings.feed) {
        return <p className="m-0 text-muted-foreground">No release feed is set: set one below to see new releases.</p>;
    }
    return (
        <p
            className={check.ok === false ? 'm-0 text-destructive' : 'm-0 text-muted-foreground'}
            data-slot="updates-check"
        >
            {check.at === undefined
                ? 'Not checked yet.'
                : check.ok
                  ? view.available.length
                      ? `${view.available.length} newer release${view.available.length === 1 ? '' : 's'}.`
                      : 'Up to date.'
                  : `The last check failed: ${check.error}`}
            {check.at !== undefined && (
                <>
                    {' '}
                    Checked <LocalTime value={check.at} format={dateTime} />.
                </>
            )}
            {settings.checkHours
                ? ` Checks every ${settings.checkHours} hour${settings.checkHours === 1 ? '' : 's'}.`
                : ' Checks only when you ask.'}
        </p>
    );
}

function UpdaterLine({ view }: { view: UpdatesView }) {
    const { updater } = view;
    if (!updater.configured) {
        return (
            <p className="m-0 text-muted-foreground" data-slot="updates-updater">
                No updater is installed, so updates are notify-only: apply them through your deployment (Help → Upgrades
                and recovery).
                {updater.error ? ` ${updater.error}.` : ''}
            </p>
        );
    }
    if (!updater.reachable) {
        return (
            <p className="m-0 text-destructive" data-slot="updates-updater">
                The updater is unreachable: {updater.error}
            </p>
        );
    }
    return (
        <p className="m-0 text-muted-foreground" data-slot="updates-updater">
            The updater changes {updater.status?.tagKeys.join(', ')} on stack {updater.status?.stack}
            {view.backups.offsite ? ', after a backup that includes the off-site copy.' : ', after a local backup.'}
        </p>
    );
}

function JobPanel({ view }: { view: UpdatesView }) {
    const job = view.updater.status!.job!;
    const done = FINISHED_PHASES.includes(job.phase);
    return (
        <div className="grid gap-2 rounded-lg border p-3" data-slot="updates-job" data-phase={job.phase} role="status">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                    {done ? 'Last update' : 'Updating'}: v{job.from} → {job.target}
                </span>
                <Badge variant={bad(job.phase) ? 'destructive' : 'secondary'}>{PHASE[job.phase]}</Badge>
                <span className="text-muted-foreground">
                    <LocalTime value={job.startedAt} format={dateTime} />
                    {job.requestedBy === 'auto' ? ' · automatic' : ''}
                </span>
            </div>
            {job.error && <p className="m-0 text-destructive">{job.error}</p>}
            <ol className="m-0 grid gap-0.5 pl-5 text-muted-foreground">
                {job.steps.slice(-6).map((step) => (
                    <li key={`${step.at}-${step.line}`} className="break-words">
                        {step.line}
                    </li>
                ))}
            </ol>
        </div>
    );
}

/** A release's Upgrading steps, as the sanitized Markdown they are written in. */
function StepList({ steps }: { steps: string[] }) {
    return (
        <div data-slot="update-step-list" className="break-words">
            <IssueMarkdown text={steps.map((step) => `- ${step}`).join('\n')} />
        </div>
    );
}

function ReleaseRow({
    release,
    canApply,
    disabled,
    autoTarget,
    onApply,
}: {
    release: FeedRelease;
    canApply: boolean;
    disabled: boolean;
    autoTarget: boolean;
    onApply: () => void;
}) {
    const [open, setOpen] = useState(false);
    const steps = release.upgrading;
    return (
        <div className="grid gap-2 rounded-lg border p-3" data-slot="update-release" data-tag={release.tag}>
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{release.tag}</span>
                {release.date && <span className="text-muted-foreground">{release.date}</span>}
                <Badge variant={steps === null || steps.length ? 'outline' : 'secondary'}>{stepsLabel(release)}</Badge>
                {release.security && <Badge variant="destructive">Security</Badge>}
                {autoTarget && <Badge>Automatic update target</Badge>}
                {canApply && (
                    <Button
                        className="ml-auto"
                        size="sm"
                        disabled={disabled}
                        aria-label={`Update to ${release.tag}`}
                        onClick={onApply}
                    >
                        Update to {release.tag}
                    </Button>
                )}
            </div>
            {release.title && release.title !== release.tag && <p className="m-0 break-words">{release.title}</p>}
            {steps && steps.length > 0 && (
                <div data-slot="update-steps">
                    <p className="m-0 font-medium">Upgrading</p>
                    <StepList steps={steps} />
                </div>
            )}
            {release.notesMarkdown ? (
                <div>
                    <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0"
                        aria-expanded={open}
                        onClick={() => setOpen(!open)}
                    >
                        {open ? 'Hide the notes' : 'Read the notes'}
                    </Button>
                    {open && (
                        <div className="mt-2 max-h-96 overflow-y-auto rounded-md bg-muted/40 p-3">
                            <IssueMarkdown text={release.notesMarkdown} />
                        </div>
                    )}
                </div>
            ) : (
                <p className="m-0 text-muted-foreground">
                    This feed has no notes for it: read the release before updating.
                </p>
            )}
            {release.url && (
                <a
                    href={release.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="w-fit text-primary underline-offset-4 hover:underline"
                >
                    The release on GitHub
                </a>
            )}
        </div>
    );
}

function ApplyDialog({
    view,
    release,
    onClose,
    onStarted,
}: {
    view: UpdatesView;
    release: FeedRelease;
    onClose: () => void;
    onStarted: () => void;
}) {
    const through = releasesThrough(view.available, view.current.version, release.version);
    const needs = through.some((item) => item.upgrading === null || item.upgrading.length > 0);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const start = async () => {
        setBusy(true);
        try {
            await api('/updates/apply', 'POST', {
                tag: release.tag,
                ...(needs ? { confirmUpgrading: confirmed } : {}),
            });
            toast.success(`Backing up, then updating to ${release.tag}.`);
            onStarted();
        } catch (e) {
            failed(e, 'Could not start the update.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Update to {release.tag}?</DialogTitle>
                    <DialogDescription>
                        From v{view.current.version}. The app takes a backup first
                        {view.backups.offsite ? ', with its off-site copy' : ''}; if that fails, nothing changes. Then
                        the updater sets {view.updater.status?.tagKeys.join(', ')} to {release.tag}, keeping every other
                        stack setting, and the app restarts. If the new version isn&apos;t healthy in time, the previous
                        one is put back.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 text-sm" data-slot="apply-steps">
                    {through.map((item) => (
                        <div key={item.tag} className="grid gap-1">
                            <p className="m-0 font-medium">
                                {item.tag}: {stepsLabel(item).toLowerCase()}
                            </p>
                            {item.upgrading === null ? (
                                <p className="m-0 text-muted-foreground">
                                    Its notes aren&apos;t in the feed: read the release first.
                                </p>
                            ) : (
                                item.upgrading.length > 0 && <StepList steps={item.upgrading} />
                            )}
                        </div>
                    ))}
                </div>
                {needs && (
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox
                            checked={confirmed}
                            onCheckedChange={(value) => setConfirmed(value === true)}
                            aria-label="I have read these steps"
                            className="mt-0.5"
                        />
                        I have read these steps and done the ones that come before an update (secrets, images,
                        settings).
                    </label>
                )}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button disabled={busy || (needs && !confirmed)} onClick={start}>
                        {busy ? 'Starting…' : `Update to ${release.tag}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function FeedSettings({ view, onSaved }: { view: UpdatesView; onSaved: (view: UpdatesView) => void }) {
    const { settings } = view;
    const [kind, setKind] = useState<UpdateFeedKind | ''>(settings.feed?.kind ?? '');
    const [repository, setRepository] = useState(settings.feed?.repository ?? '');
    const [token, setToken] = useState('');
    const [removeToken, setRemoveToken] = useState(false);
    const [hours, setHours] = useState(String(settings.checkHours));
    const [autoApply, setAutoApply] = useState(settings.autoApply);
    const [staleDays, setStaleDays] = useState(String(settings.staleDays));
    const [saving, setSaving] = useState(false);
    const save = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        try {
            const next = await api<UpdatesView>('/updates/settings', 'PUT', {
                feed: kind ? { kind, repository: repository.trim() } : null,
                checkHours: Number(hours),
                autoApply,
                staleDays: Number(staleDays),
                ...(token.trim() ? { token: token.trim() } : removeToken ? { token: null } : {}),
            });
            setToken('');
            setRemoveToken(false);
            onSaved(next);
            toast.success('Update settings saved.');
        } catch (e) {
            failed(e, 'Could not save the update settings.');
        } finally {
            setSaving(false);
        }
    };
    const reset = async () => {
        setSaving(true);
        try {
            const next = await api<UpdatesView>('/updates/settings', 'PUT', {
                reset: true,
            });
            setKind(next.settings.feed?.kind ?? '');
            setRepository(next.settings.feed?.repository ?? '');
            setHours(String(next.settings.checkHours));
            setAutoApply(next.settings.autoApply);
            setStaleDays(String(next.settings.staleDays));
            onSaved(next);
        } catch (e) {
            failed(e, 'Could not reset the update settings.');
        } finally {
            setSaving(false);
        }
    };
    const tokenLine = {
        settings: 'A read token is saved (sealed; it is never shown).',
        environment: 'The read token comes from UPDATES_FEED_TOKEN_FILE.',
        none: 'No read token: only a public feed can be read.',
        unreadable: 'The saved token can’t be opened (its data key is gone): enter it again.',
    }[view.token];
    return (
        <form className="grid gap-3 rounded-lg border p-3" onSubmit={save} data-slot="updates-settings">
            <p className="m-0 font-medium">Release feed</p>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
                <label className="grid gap-1">
                    Source
                    <select
                        data-slot="native-select"
                        className={field}
                        value={kind}
                        onChange={(e) => setKind(e.target.value as UpdateFeedKind | '')}
                    >
                        <option value="">None</option>
                        <option value="github">GitHub releases</option>
                        <option value="ghcr">GHCR image tags</option>
                    </select>
                </label>
                <label className="grid gap-1">
                    {kind === 'ghcr' ? 'Image (owner/image)' : 'Repository (owner/repo)'}
                    <Input
                        value={repository}
                        disabled={!kind}
                        required={!!kind}
                        maxLength={300}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setRepository(e.target.value)}
                        placeholder={kind === 'ghcr' ? 'owner/socio' : 'owner/socio'}
                    />
                </label>
            </div>
            <label className="grid gap-1">
                Read token
                <Input
                    type="password"
                    autoComplete="off"
                    value={token}
                    disabled={!kind || removeToken}
                    maxLength={1000}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={
                        view.token === 'settings'
                            ? 'Saved; leave blank to keep it'
                            : 'For a private repository: read-only access'
                    }
                />
                <span className="text-muted-foreground">
                    {tokenLine} It goes only to {kind === 'ghcr' ? 'ghcr.io' : 'api.github.com'}; checks send no
                    workspace or personal details.
                </span>
            </label>
            {view.token === 'settings' && (
                <label className="flex items-center gap-2">
                    <Switch checked={removeToken} onCheckedChange={setRemoveToken} />
                    Remove the saved token
                </label>
            )}
            <label className="grid gap-1 sm:max-w-xs">
                Check every (hours)
                <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={168}
                    required
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                />
                <span className="text-muted-foreground">0 checks only when you ask.</span>
            </label>
            <label className="grid gap-1 sm:max-w-xs">
                Warn when behind by (days)
                <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={UPDATE_STALE_MAX_DAYS}
                    required
                    value={staleDays}
                    onChange={(e) => setStaleDays(e.target.value)}
                />
                <span className="text-muted-foreground">
                    When the newest release came out more than this many days after the one running, this card and a
                    notice say so. A release marked security warns right away. 0 turns the warning off.
                </span>
            </label>
            <label className="flex items-start gap-2">
                <Switch
                    checked={autoApply}
                    onCheckedChange={setAutoApply}
                    disabled={!view.updater.configured}
                    className="mt-0.5"
                />
                <span className="grid gap-0.5">
                    Update automatically
                    <span className="text-muted-foreground">
                        Off by default. Only releases whose notes list no Upgrading steps, each after its backup; a
                        release whose update failed is never retried on its own.
                        {!view.updater.configured && ' Needs the updater.'}
                    </span>
                </span>
            </label>
            <div className="flex flex-wrap justify-end gap-2">
                {settings.source === 'settings' && (
                    <Button type="button" variant="ghost" disabled={saving} onClick={reset}>
                        Use the environment&apos;s
                    </Button>
                )}
                <Button type="submit" disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </div>
        </form>
    );
}
