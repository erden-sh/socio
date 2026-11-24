import { ArrowLeft, Bug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { MODULE_IDS } from '@socio/shared/modules';
import { pluginUpdateAck, type PluginUpdateReview } from '@socio/shared/plugins/plugin-update';

import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';
import { openReport } from '../issues/report';

import {
    AUDIENCE_LABEL,
    BackupBadge,
    backupAlarm,
    backupDetail,
    backupSize,
    displayLabel,
    failed,
    INSTALLED_PATH,
    modeLabel,
    OpenAnyHttpsScope,
    OpenPlugin,
    permissionLine,
    PluginMark,
    runLabel,
    type InstalledRow,
    type PluginBackups,
    type PluginList,
} from './plugin-rows';
import { PluginDataBudgetField } from './PluginDataBudget';
import { PluginDatasetsSection } from './PluginDatasetBindings';
import { PluginSettingsForm, pluginSavesSettled, type PluginSaveResult } from './PluginSettingsForm';
import { UninstallPluginDialog } from './UninstallPluginDialog';
import { UpdateReviewDialog } from './UpdateReviewDialog';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** What loading the plugin gave: its row, or that it isn't installed. */
type Loaded = { plugin: InstalledRow; inCatalog: boolean } | { missing: true };

/** One section of the page, as a Settings card: a title, a line under it, then its fields. */
function Section({
    title,
    intro,
    slot,
    danger,
    children,
}: {
    title: string;
    intro?: ReactNode;
    slot: string;
    danger?: boolean;
    children: ReactNode;
}) {
    return (
        <Card
            className={cn('gap-4 px-6 text-sm', danger && 'border-destructive/50')}
            data-slot={slot}
            aria-labelledby={`${slot}-title`}
            role="region"
        >
            <div className="grid gap-1">
                <h2 id={`${slot}-title`} className={cn('font-medium', danger && 'text-destructive')}>
                    {title}
                </h2>
                {intro && <p className="text-muted-foreground">{intro}</p>}
            </div>
            {children}
        </Card>
    );
}

/**
 * The hosts a service plugin may reach (CB-441): the allow list its
 * service gets, a url setting's host included, and each url setting that
 * added none, with why.
 */
function EgressSection({ egress, saved }: { egress: NonNullable<InstalledRow['egress']>; saved: boolean }) {
    const missing = egress.settings.filter((setting) => !setting.host);
    return (
        <Section
            title="Outbound network"
            intro={
                egress.hosts.length
                    ? 'The hosts outside Socio its settings allow its service to reach, over HTTPS. A host from a setting reaches the service once the settings apply.'
                    : 'Its settings allow its service nothing outside Socio, once they apply.'
            }
            slot="plugin-egress"
        >
            {saved && (
                <p className="text-muted-foreground" data-slot="plugin-egress-pending">
                    From the settings just saved. Until they apply, the running service keeps the hosts it had.
                </p>
            )}
            {egress.hosts.length > 0 && (
                <ul className="grid gap-1" data-slot="plugin-egress-hosts">
                    {egress.hosts.map((host) => {
                        const from = egress.settings.find((setting) => setting.host === host);
                        return (
                            <li key={host} className="flex flex-wrap items-baseline gap-2">
                                <code className="font-mono">{host}</code>
                                {from && <span className="text-muted-foreground">from the setting {from.field}</span>}
                            </li>
                        );
                    })}
                </ul>
            )}
            {missing.map((setting) => (
                <p
                    key={setting.field}
                    className="text-muted-foreground"
                    data-slot="plugin-egress-problem"
                    data-field={setting.field}
                >
                    No host added from {setting.field}: {setting.problem}. Set it to an https address to allow its host.
                </p>
            ))}
        </Section>
    );
}

const REASON_LABEL: Record<PluginBackups['history'][number]['reason'], string> = {
    scheduled: 'Scheduled',
    manual: 'Back up now',
    request: 'Asked for by the plugin',
    'pre-update': 'Before an update',
    uninstall: 'Before uninstall',
};

/** How often the page asks how a snapshot it started is going. */
const BACKUP_POLL_MS = 3_000;

/**
 * A plugin's own storage, backed up by the workspace (CB-458 step 5): its
 * status, **Back up now**, and the snapshots the workspace keeps of it.
 */
function PluginBackupsSection({ id, enabled }: { id: string; enabled: boolean }) {
    const [backups, setBackups] = useState<PluginBackups>();
    const [starting, setStarting] = useState(false);
    const shown = useRef(id);
    shown.current = id;
    const load = useCallback(async () => {
        try {
            const data = await api<PluginBackups>(`/plugins/${encodeURIComponent(id)}/backups`);
            if (shown.current === id) {
                setBackups(data);
            }
        } catch (error) {
            failed(error, 'Could not load the plugin’s backups.');
        }
    }, [id]);
    useEffect(() => {
        void load();
    }, [load]);
    // While a snapshot runs, ask again until it is done.
    const running = backups?.backup.running === true;
    useEffect(() => {
        if (!running) {
            return;
        }
        const timer = setTimeout(() => void load(), BACKUP_POLL_MS);
        return () => clearTimeout(timer);
    }, [running, backups, load]);
    const backUpNow = async () => {
        setStarting(true);
        try {
            await api(`/plugins/${encodeURIComponent(id)}/backup`, 'POST');
            toast.success('Backup started');
            await load();
        } catch (error) {
            failed(error, 'Could not start the backup.');
        } finally {
            setStarting(false);
        }
    };
    if (!backups) {
        return (
            <Section title="Backups" slot="plugin-backups">
                <Skeleton className="h-16" />
            </Section>
        );
    }
    const { backup, history } = backups;
    return (
        <Section
            title="Backups"
            intro="The workspace backs up this plugin’s own storage with every scheduled backup, sealed under the data key, and off-site with the rest."
            slot="plugin-backups"
        >
            <p
                className={backupAlarm(backup) ? 'text-destructive' : 'text-muted-foreground'}
                data-slot="plugin-backup-status"
                data-state={backup.state}
            >
                {running ? 'Backing up now… ' : ''}
                {backupDetail(backup)}
            </p>
            <div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-slot="plugin-backup-now"
                    disabled={!enabled || running || starting}
                    onClick={() => void backUpNow()}
                >
                    Back up now
                </Button>
            </div>
            {history.length > 0 ? (
                <ul className="grid gap-1" data-slot="plugin-backup-history">
                    {history.map((entry) => (
                        <li
                            key={entry.snapshotId}
                            className="flex flex-wrap items-baseline gap-x-2"
                            data-snapshot={entry.snapshotId}
                        >
                            <span>{new Date(entry.takenAt).toLocaleString()}</span>
                            <span className="text-muted-foreground">
                                {REASON_LABEL[entry.reason]}
                                {entry.note ? `: ${entry.note}` : ''} · {backupSize(entry.bytes)} · version{' '}
                                {entry.version}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-muted-foreground" data-slot="plugin-backup-history-empty">
                    No backups kept yet.
                </p>
            )}
        </Section>
    );
}

/**
 * `/settings/plugins/:pluginId` (CB-393; under Settings since CB-446): one installed plugin's page, for
 * admins. What it is and whether it runs, who can use it, its settings, and,
 * apart at the foot, Uninstall in a danger zone (CB-397). Replicas are the
 * operator's, not set here (CB-396).
 */
export function PluginManagePage({ id }: { id: string }) {
    const shell = useShell();
    const navigate = useNavigate();
    const [loaded, setLoaded] = useState<Loaded>();
    const [removing, setRemoving] = useState(false);
    /** An update that adds a sensitive scope, under review. */
    const [reviewing, setReviewing] = useState(false);
    // The outbound hosts on screen came from a save, not from the running service (CB-441).
    const [egressSaved, setEgressSaved] = useState(false);
    const egressSaves = useRef(0);
    // The plugin on screen now: a load that answers after a navigation to
    // another plugin is dropped.
    const shown = useRef(id);
    shown.current = id;
    const load = useCallback(async () => {
        try {
            // A save this plugin's page left on its way lands first (CB-398).
            await pluginSavesSettled(id);
            const data = await api<PluginList>('/plugins');
            if (shown.current !== id) {
                return;
            }
            const plugin = data.installed.find((row) => row.id === id);
            setLoaded(plugin ? { plugin, inCatalog: data.catalog.some((row) => row.id === id) } : { missing: true });
            setEgressSaved(false);
        } catch (error) {
            failed(error, 'Could not load the plugin.');
        }
    }, [id]);
    useEffect(() => {
        setLoaded(undefined);
        void load();
    }, [load]);
    const act = async (path: string, method: string, body?: unknown) => {
        try {
            await api(path, method, body);
            await shell.refresh();
            await load();
            return true;
        } catch (error) {
            failed(error, 'Could not update the plugin.');
            return false;
        }
    };
    const base = `/plugins/${encodeURIComponent(id)}`;
    /**
     * Update from the catalog, from its review (CB-531): when it adds
     * anything, the request acknowledges exactly the additions the review
     * listed, bound to its revisions. The server refuses a stale one (the
     * catalog or the install may have changed since this page loaded), and
     * the page reloads so the review shows the update as it is now.
     */
    const update = async (review: PluginUpdateReview) => {
        const done = await act(
            `${base}/update`,
            'POST',
            review.additions.length ? { acknowledged: pluginUpdateAck(review) } : undefined,
        );
        if (!done) {
            await load();
        }
        return done;
    };
    const back = (
        <Link
            to={INSTALLED_PATH}
            className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            data-slot="plugin-back"
        >
            <ArrowLeft className="size-4" aria-hidden="true" /> Installed plugins
        </Link>
    );

    if (!loaded) {
        return (
            <WorkspacePage slot="plugin-page" module={MODULE_IDS.plugins} title="Plugin" measure="form">
                <div className="grid gap-4" aria-busy="true" aria-label="Loading the plugin">
                    {back}
                    <Skeleton className="h-32" />
                    <Skeleton className="h-48" />
                </div>
            </WorkspacePage>
        );
    }
    if ('missing' in loaded) {
        return (
            <WorkspacePage
                slot="plugin-page"
                module={MODULE_IDS.plugins}
                title="Plugin not installed"
                description="No plugin with this id is installed on this instance."
                measure="form"
            >
                <div className="grid gap-4" data-slot="plugin-missing">
                    {back}
                </div>
            </WorkspacePage>
        );
    }
    const { plugin, inCatalog } = loaded;
    const bundled = plugin.mode === 'bundled';
    const fields = Object.keys(plugin.configFields ?? {});
    return (
        <WorkspacePage
            slot="plugin-page"
            module={MODULE_IDS.plugins}
            title={plugin.name}
            description={`${plugin.author} · ${plugin.version}${inCatalog ? '' : ' · no longer in the catalog'}`}
            measure="form"
            actions={
                <>
                    {plugin.update && (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-slot="plugin-update"
                            onClick={() => setReviewing(true)}
                        >
                            Update to {plugin.update.version}
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-slot="plugin-report-issue"
                        onClick={(event) =>
                            openReport({ components: [`plugin:${plugin.id}`] }, { returnFocus: event.currentTarget })
                        }
                    >
                        <Bug /> Report issue
                    </Button>
                    {plugin.enabled && <OpenPlugin plugin={plugin} />}
                </>
            }
        >
            <div className="grid gap-6" data-plugin={plugin.id}>
                {back}
                <Section title="Overview" slot="plugin-overview">
                    <div className="flex items-start gap-3">
                        <PluginMark id={plugin.id} />
                        <div className="grid min-w-0 flex-1 gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge variant={plugin.enabled ? 'default' : 'secondary'}>{runLabel(plugin)}</Badge>
                                <Badge variant="outline">{displayLabel(plugin.display, plugin.mode)}</Badge>
                                <Badge variant="outline">{modeLabel(plugin.mode)}</Badge>
                                <BackupBadge backup={plugin.backup} />
                            </div>
                            <p>{plugin.description}</p>
                            <p className="text-muted-foreground">{permissionLine(plugin.permissions)}</p>
                            {plugin.openAnyHttps && <OpenAnyHttpsScope />}
                            {plugin.backup && (
                                <p
                                    className={
                                        backupAlarm(plugin.backup) ? 'text-destructive' : 'text-muted-foreground'
                                    }
                                    data-slot="plugin-backup"
                                >
                                    {backupDetail(plugin.backup)}
                                </p>
                            )}
                        </div>
                    </div>
                    <label className="flex items-center justify-between gap-3 border-t pt-4">
                        <span className="grid gap-0.5">
                            <span className="font-medium">Enabled</span>
                            <span className="text-muted-foreground">
                                {bundled
                                    ? 'Off, nobody can open it. Its data stays.'
                                    : 'Off, its service scales to zero. Its data and settings stay.'}
                            </span>
                        </span>
                        <Switch
                            checked={plugin.enabled}
                            aria-label={plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}
                            onCheckedChange={(checked) => void act(`${base}/${checked ? 'enable' : 'disable'}`, 'POST')}
                        />
                    </label>
                </Section>
                <Section
                    title="Who can use it"
                    intro="Admins can always manage it. Members see it in their sidebar only when it is for everyone."
                    slot="plugin-access"
                >
                    <div className="grid gap-1.5">
                        <label id={`${plugin.id}-audience`} className="font-medium">
                            Audience
                        </label>
                        <Select
                            value={plugin.audience ?? 'admins'}
                            onValueChange={(value) => void act(`${base}/audience`, 'PUT', { audience: value })}
                        >
                            <SelectTrigger
                                className="w-full max-w-md"
                                aria-labelledby={`${plugin.id}-audience`}
                                data-slot="plugin-audience"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {(['admins', 'members'] as const).map((value) => (
                                    <SelectItem key={value} value={value}>
                                        {AUDIENCE_LABEL[value]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </Section>
                <Section
                    title="Settings"
                    intro={
                        fields.length
                            ? 'What this plugin lets you change. Changes save as you make them; a field left empty uses its default.'
                            : 'This plugin has no settings.'
                    }
                    slot="plugin-settings-card"
                >
                    {fields.length > 0 && (
                        <PluginSettingsForm
                            // Kept while the page is open, with its undo history: saves
                            // don't reload it. An update that retypes a setting starts it
                            // again, so a kept value that no longer fits shows its error.
                            key={JSON.stringify(plugin.configFields ?? {})}
                            plugin={plugin}
                            onSave={async (config) => {
                                const result = await api<PluginSaveResult>(`${base}/config`, 'PUT', { config });
                                // The hosts a url setting allows follow it (CB-441).
                                const egress = result?.egress;
                                if (egress) {
                                    egressSaves.current += 1;
                                    setEgressSaved(true);
                                    setLoaded((now) =>
                                        now && 'plugin' in now && now.plugin.id === id
                                            ? { ...now, plugin: { ...now.plugin, egress } }
                                            : now,
                                    );
                                }
                                return result;
                            }}
                            // A service plugin restarts to take them, once the saves settle (CB-398 follow-up).
                            {...(bundled
                                ? {}
                                : {
                                      onApply: async () => {
                                          const saves = egressSaves.current;
                                          await api(`${base}/apply`, 'POST');
                                          // The running service has what was saved now, unless a save came since.
                                          if (egressSaves.current === saves) {
                                              setEgressSaved(false);
                                          }
                                      },
                                      onLeave: () =>
                                          void fetch(`/api${base}/apply`, {
                                              method: 'POST',
                                              keepalive: true,
                                              headers: { 'Content-Type': 'application/json' },
                                              body: '{}',
                                          }).catch(() => undefined),
                                  })}
                        />
                    )}
                </Section>
                {plugin.egress && <EgressSection egress={plugin.egress} saved={egressSaved} />}
                {!bundled && (
                    <Section
                        title="Datasets"
                        intro="The workspace datasets it reads or writes, and how many data operations it may make a minute. Each dataset has one plugin that writes it; a read need may stay unbound. Uninstalling keeps them."
                        slot="plugin-datasets-card"
                    >
                        <div className="grid gap-6">
                            <PluginDatasetsSection pluginId={plugin.id} />
                            <PluginDataBudgetField pluginId={plugin.id} />
                        </div>
                    </Section>
                )}
                {plugin.backup?.declared && <PluginBackupsSection id={plugin.id} enabled={plugin.enabled} />}
                <Section
                    title="Danger zone"
                    intro="Uninstalling can’t be undone from here. Installing it again starts with default settings."
                    slot="plugin-danger-zone"
                    danger
                >
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
                        <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
                            <span className="font-medium">Uninstall {plugin.name}</span>
                            <span className="text-muted-foreground">
                                {bundled
                                    ? 'Removes it from this instance.'
                                    : 'Removes its service, volumes and identity.'}{' '}
                                Rows it saved stay, and its datasets stay the workspace’s.
                            </span>
                        </div>
                        <Button variant="destructive" onClick={() => setRemoving(true)}>
                            Uninstall…
                        </Button>
                    </div>
                </Section>
            </div>
            {reviewing && plugin.update && (
                <UpdateReviewDialog
                    name={plugin.name}
                    review={plugin.update}
                    onClose={() => setReviewing(false)}
                    onConfirm={async (review) => {
                        if (await update(review)) {
                            setReviewing(false);
                        }
                    }}
                />
            )}
            {removing && (
                <UninstallPluginDialog
                    plugin={plugin}
                    onClose={() => setRemoving(false)}
                    onConfirm={async () => {
                        try {
                            await api(base, 'DELETE');
                        } catch (error) {
                            failed(error, 'Could not uninstall the plugin.');
                            return;
                        }
                        toast.success(`${plugin.name} uninstalled. Its saved rows stay.`);
                        setRemoving(false);
                        await shell.refresh();
                        void navigate(INSTALLED_PATH);
                    }}
                />
            )}
        </WorkspacePage>
    );
}
