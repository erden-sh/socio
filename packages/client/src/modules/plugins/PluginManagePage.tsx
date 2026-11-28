import { ArrowLeft, Bug } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { dateTimeFormat } from '@socio/shared/locale';
import { MODULE_IDS } from '@socio/shared/modules';
import { pluginUpdateAck, type PluginUpdateReview } from '@socio/shared/plugins/plugin-update';

import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';
import { openReport } from '../issues/report';

import {
    BackupBadge,
    backupAlarm,
    failed,
    INSTALLED_PATH,
    OpenAnyHttpsScope,
    OpenPlugin,
    PluginMark,
    usePluginWords,
    type InstalledRow,
    type PluginBackupInfo,
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
    const { t } = useTranslation(['plugins.manage']);
    const missing = egress.settings.filter((setting) => !setting.host);
    return (
        <Section
            title={t('plugins.manage:egress.title')}
            intro={egress.hosts.length ? t('plugins.manage:egress.intro') : t('plugins.manage:egress.intro-none')}
            slot="plugin-egress"
        >
            {saved && (
                <p className="text-muted-foreground" data-slot="plugin-egress-pending">
                    {t('plugins.manage:egress.pending')}
                </p>
            )}
            {egress.hosts.length > 0 && (
                <ul className="grid gap-1" data-slot="plugin-egress-hosts">
                    {egress.hosts.map((host) => {
                        const from = egress.settings.find((setting) => setting.host === host);
                        return (
                            <li key={host} className="flex flex-wrap items-baseline gap-2">
                                <code className="font-mono">{host}</code>
                                {from && (
                                    <span className="text-muted-foreground">
                                        {t('plugins.manage:egress.from', { field: from.field })}
                                    </span>
                                )}
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
                    {t('plugins.manage:egress.problem', { field: setting.field, problem: setting.problem ?? '' })}
                </p>
            ))}
        </Section>
    );
}

/** A time on this page, in the reader's locale and zone. */
const when = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' });

/** What the plugin's page says about its backups (CB-458), in the reader's language. */
function useBackupDetail() {
    const { t } = useTranslation(['plugins.manage']);
    return (backup: PluginBackupInfo) => {
        const volumes = backup.volumes;
        const last =
            backup.lastSuccessAt !== undefined
                ? t('plugins.manage:backup.last', {
                      when: when.format(backup.lastSuccessAt),
                      context: backup.sizeBytes !== undefined ? 'size' : undefined,
                      size: backup.sizeBytes ?? 0,
                  })
                : t('plugins.manage:backup.none-yet');
        switch (backup.state) {
            case 'ok':
                return t('plugins.manage:backup.ok', { volumes, last });
            case 'stale':
                return t('plugins.manage:backup.stale', { volumes, last });
            case 'failing':
                return t('plugins.manage:backup.failing', {
                    context: backup.lastErrorAt !== undefined ? 'when' : undefined,
                    when: backup.lastErrorAt !== undefined ? when.format(backup.lastErrorAt) : '',
                    reason: backup.lastError ?? t('plugins.manage:backup.no-reason'),
                    last,
                });
            case 'disabled':
                return t('plugins.manage:backup.disabled', {
                    context: backup.since !== undefined ? 'since' : undefined,
                    when: backup.since !== undefined ? when.format(backup.since) : '',
                    last,
                });
            case 'not_backed_up':
                return backup.declared
                    ? t('plugins.manage:backup.first', { volumes })
                    : t('plugins.manage:backup.undeclared', { volumes });
        }
    };
}

/** How often the page asks how a snapshot it started is going. */
const BACKUP_POLL_MS = 3_000;

/**
 * A plugin's own storage, backed up by the workspace (CB-458 step 5): its
 * status, **Back up now**, and the snapshots the workspace keeps of it.
 */
function PluginBackupsSection({ id, enabled }: { id: string; enabled: boolean }) {
    const { t } = useTranslation(['plugins.manage']);
    const backupDetail = useBackupDetail();
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
            failed(error, t('plugins.manage:backups.load-failed'));
        }
    }, [id, t]);
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
            toast.success(t('plugins.manage:backups.started'));
            await load();
        } catch (error) {
            failed(error, t('plugins.manage:backups.start-failed'));
        } finally {
            setStarting(false);
        }
    };
    if (!backups) {
        return (
            <Section title={t('plugins.manage:backups.title')} slot="plugin-backups">
                <Skeleton className="h-16" />
            </Section>
        );
    }
    const { backup, history } = backups;
    return (
        <Section
            title={t('plugins.manage:backups.title')}
            intro={t('plugins.manage:backups.intro')}
            slot="plugin-backups"
        >
            <p
                className={backupAlarm(backup) ? 'text-destructive' : 'text-muted-foreground'}
                data-slot="plugin-backup-status"
                data-state={backup.state}
            >
                {running ? `${t('plugins.manage:backups.running')} ` : ''}
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
                    {t('plugins.manage:backups.now')}
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
                            <span>{when.format(entry.takenAt)}</span>
                            <span className="text-muted-foreground">
                                {t('plugins.manage:backups.entry', {
                                    reason: entry.note
                                        ? t('plugins.manage:backups.noted', {
                                              reason: t(`plugins.manage:backups.reasons.${entry.reason}`),
                                              note: entry.note,
                                          })
                                        : t(`plugins.manage:backups.reasons.${entry.reason}`),
                                    size: entry.bytes,
                                    version: entry.version,
                                })}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-muted-foreground" data-slot="plugin-backup-history-empty">
                    {t('plugins.manage:backups.empty')}
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
    const { t } = useTranslation(['plugins', 'plugins.manage']);
    const words = usePluginWords();
    const backupDetail = useBackupDetail();
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
            failed(error, t('plugins.manage:load-failed'));
        }
    }, [id, t]);
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
            failed(error, t('plugins:update-failed'));
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
            <ArrowLeft className="size-4" aria-hidden="true" /> {t('plugins.manage:back')}
        </Link>
    );

    if (!loaded) {
        return (
            <WorkspacePage
                slot="plugin-page"
                module={MODULE_IDS.plugins}
                title={t('plugins:crumb-fallback')}
                measure="form"
            >
                <div className="grid gap-4" aria-busy="true" aria-label={t('plugins.manage:loading')}>
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
                title={t('plugins.manage:missing.title')}
                description={t('plugins.manage:missing.description')}
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
            description={t('plugins:meta', {
                author: plugin.author,
                version: plugin.version,
                context: inCatalog ? undefined : 'removed',
            })}
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
                            {t('plugins:update-to', { version: plugin.update.version })}
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
                        <Bug /> {t('plugins.manage:report')}
                    </Button>
                    {plugin.enabled && <OpenPlugin plugin={plugin} />}
                </>
            }
        >
            <div className="grid gap-6" data-plugin={plugin.id}>
                {back}
                <Section title={t('plugins.manage:overview.title')} slot="plugin-overview">
                    <div className="flex items-start gap-3">
                        <PluginMark id={plugin.id} />
                        <div className="grid min-w-0 flex-1 gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge variant={plugin.enabled ? 'default' : 'secondary'}>
                                    {words.runLabel(plugin)}
                                </Badge>
                                <Badge variant="outline">{words.displayLabel(plugin.display, plugin.mode)}</Badge>
                                <Badge variant="outline">{words.modeLabel(plugin.mode)}</Badge>
                                <BackupBadge backup={plugin.backup} />
                            </div>
                            <p>{plugin.description}</p>
                            <p className="text-muted-foreground">{words.permissionLine(plugin.permissions)}</p>
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
                            <span className="font-medium">{t('plugins.manage:overview.enabled')}</span>
                            <span className="text-muted-foreground">
                                {bundled
                                    ? t('plugins.manage:overview.off-bundled')
                                    : t('plugins.manage:overview.off-service')}
                            </span>
                        </span>
                        <Switch
                            checked={plugin.enabled}
                            aria-label={
                                plugin.enabled
                                    ? t('plugins.manage:overview.disable', { name: plugin.name })
                                    : t('plugins.manage:overview.enable', { name: plugin.name })
                            }
                            onCheckedChange={(checked) => void act(`${base}/${checked ? 'enable' : 'disable'}`, 'POST')}
                        />
                    </label>
                </Section>
                <Section
                    title={t('plugins.manage:access.title')}
                    intro={t('plugins.manage:access.intro')}
                    slot="plugin-access"
                >
                    <div className="grid gap-1.5">
                        <label id={`${plugin.id}-audience`} className="font-medium">
                            {t('plugins.manage:access.audience')}
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
                                        {words.audienceLabel(value)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </Section>
                <Section
                    title={t('plugins.manage:settings.title')}
                    intro={fields.length ? t('plugins.manage:settings.intro') : t('plugins.manage:settings.none')}
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
                        title={t('plugins.manage:datasets.title')}
                        intro={t('plugins.manage:datasets.intro')}
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
                    title={t('plugins.manage:danger.title')}
                    intro={t('plugins.manage:danger.intro')}
                    slot="plugin-danger-zone"
                    danger
                >
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
                        <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
                            <span className="font-medium">
                                {t('plugins.manage:danger.uninstall-title', { name: plugin.name })}
                            </span>
                            <span className="text-muted-foreground">
                                {bundled
                                    ? t('plugins.manage:danger.uninstall-bundled')
                                    : t('plugins.manage:danger.uninstall-service')}
                            </span>
                        </div>
                        <Button variant="destructive" onClick={() => setRemoving(true)}>
                            {t('plugins.manage:danger.uninstall')}
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
                            failed(error, t('plugins.manage:danger.failed'));
                            return;
                        }
                        toast.success(t('plugins.manage:danger.done', { name: plugin.name }));
                        setRemoving(false);
                        await shell.refresh();
                        void navigate(INSTALLED_PATH);
                    }}
                />
            )}
        </WorkspacePage>
    );
}
