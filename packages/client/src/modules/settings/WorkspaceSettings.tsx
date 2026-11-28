import { useState, type ReactNode } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { isAdmin } from '@socio/shared/roles';
import type { BackupSchedule, RestoreDrillStatus, State, WorkspaceState } from '@socio/shared/types';

import { onDemand } from '../../i18n/on-demand';
import { useHydrated } from '../../lib/client-only';
import { utcTime } from '../../lib/local-time';
import { DictationAllowedSetting, TranscriptionSetting } from '../voice/DictationSettings';
import { VoiceCallsSetting } from '../voice/VoiceCallSettings';

import { SettingsCard } from './AccountSettings';
import { WorkspaceAppearance } from './AppearanceSettings';
import { AppInviteLinksSetting } from './AppInviteLinksSetting';
import { AppLogsSetting } from './AppLogsSetting';
import { AppPolicySetting } from './AppPolicySetting';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';
import { AutoTriageSetting } from './AutoTriageSetting';
import { BrandingSetting } from './BrandingSetting';
import { ContextSetting } from './ContextSetting';
import { DataKeySetup, RecoveryKeyCheckSetup } from './DataKeySetup';
import { GitHubAppSetting } from './GitHubAppSetting';
import { LimitSettings } from './LimitSettings';
import { ModelFallbackSetting } from './ModelFallbackSetting';
import { RoomsSetting } from './RoomsSetting';
import { pluginBackupsAlarm, useSetupLines } from './setup-lines';
import { SpaceCreatorsSetting } from './SpaceCreatorsSetting';
import { TracingSetting } from './TracingSetting';

import { PermissionRow } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Settings → Workspace → General (the old Settings dialog, CB-18): public
 * research and saved memories for every Dot, and what the server has set
 * up. Members read it; only admins change it.
 */
export function WorkspaceSettings({
    state,
    workspace,
    mutate,
}: {
    state: State;
    workspace: WorkspaceState;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const readOnly = !isAdmin(workspace.user);
    const { setup } = workspace;
    return (
        <>
            {!readOnly && (
                <>
                    <BrandingSetting branding={state.settings.branding} mutate={mutate} />
                    <WorkspaceAppearance defaultThemeId={state.settings.defaultThemeId} mutate={mutate} />
                </>
            )}
            <PermissionsCard
                researchAllowed={state.settings.researchAllowed}
                memoryAllowed={state.settings.memoryAllowed}
                readOnly={readOnly}
                mutate={mutate}
            />
            <SpaceCreatorsSetting settings={state.settings} readOnly={readOnly} mutate={mutate} />
            <DailyLimits {...DOT_LIMITS} limits={state.settings.dotDailyLimits} readOnly={readOnly} mutate={mutate} />
            <AutoTriageSetting settings={state.settings.autoTriage} readOnly={readOnly} mutate={mutate} />
            <DailyLimits
                {...NOTIFICATION_LIMITS}
                limits={state.settings.notificationDailyLimits}
                readOnly={readOnly}
                mutate={mutate}
            />
            <LimitSettings state={state} readOnly={readOnly} mutate={mutate} />
            {!readOnly && <GitHubAppSetting />}
            <ModelFallbackSetting enabled={state.settings.modelFallback} readOnly={readOnly} mutate={mutate} />
            <AppInviteLinksSetting enabled={state.settings.appInviteLinks} readOnly={readOnly} mutate={mutate} />
            <AppPolicySetting policy={state.settings.appPolicy} readOnly={readOnly} mutate={mutate} />
            <RoomsSetting settings={state.settings.rooms} readOnly={readOnly} mutate={mutate} />
            <DictationAllowedSetting state={state} readOnly={readOnly} mutate={mutate} />
            <TranscriptionSetting state={state} available={!!setup.transcription} readOnly={readOnly} mutate={mutate} />
            <VoiceCallsSetting state={state} setup={setup} readOnly={readOnly} mutate={mutate} />
            <TracingSetting settings={state.settings.tracing} readOnly={readOnly} mutate={mutate} />
            <ContextSetting settings={state.settings.context} readOnly={readOnly} mutate={mutate} />
            <AppLogsSetting settings={state.settings.appLogs} readOnly={readOnly} mutate={mutate} />
            {state.settings.backupSchedule && (
                <BackupScheduleSetting schedule={state.settings.backupSchedule} readOnly={readOnly} mutate={mutate} />
            )}
            <ServiceSetup setup={setup} readOnly={readOnly} mutate={mutate} />
        </>
    );
}

/**
 * What the server has set up, the page's last card. Its words
 * (`settings.workspace-setup`) load on demand, like the other cards below
 * the fold, so the page's inlined dictionaries stay within the budget.
 */
const ServiceSetup = onDemand(
    ['settings.workspace-setup'],
    function ServiceSetup({
        setup,
        readOnly,
        mutate,
    }: {
        setup: WorkspaceState['setup'];
        readOnly: boolean;
        mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
    }) {
        const { t } = useTranslation(['settings.workspace-setup']);
        const { backupLine, continuousLine, continuousOffsiteLine, pluginBackupsLine } = useSetupLines();
        // Match the server before switching setup timestamps to the reader’s zone.
        const when = useHydrated() ? undefined : utcTime;
        return (
            <SettingsCard>
                <section className="grid gap-2" data-slot="service-setup">
                    <h3 className="font-medium">{t('settings.workspace-setup:title')}</h3>
                    <div className="grid gap-1 text-muted-foreground">
                        <p>
                            {setup.missing.length
                                ? t('settings.workspace-setup:missing', { names: setup.missing.join(', ') })
                                : t('settings.workspace-setup:ready')}
                        </p>
                        {setup.inference && (
                            <p>
                                {t('settings.workspace-setup:lines.model', {
                                    line: setup.inference.available
                                        ? setup.inference.source === 'byo'
                                            ? t('settings.workspace-setup:model.byo', {
                                                  label: setup.inference.label ?? '',
                                              })
                                            : (setup.inference.label ?? '')
                                        : setup.inference.byoAllowed
                                          ? t('settings.workspace-setup:model.noneByo')
                                          : t('settings.workspace-setup:model.none'),
                                })}
                            </p>
                        )}
                        <p>
                            {t('settings.workspace-setup:lines.telegram', {
                                line:
                                    setup.telegram === 'not_configured'
                                        ? t('settings.workspace-setup:telegram.notConfigured')
                                        : setup.telegram === 'online'
                                          ? setup.telegramBot
                                              ? t('settings.workspace-setup:telegram.onlineAs', {
                                                    bot: setup.telegramBot,
                                                })
                                              : t('settings.workspace-setup:telegram.online')
                                          : setup.telegram === 'connecting'
                                            ? t('settings.workspace-setup:telegram.connecting')
                                            : t('settings.workspace-setup:telegram.offline'),
                            })}
                        </p>
                        <p>
                            {t('settings.workspace-setup:lines.voice', {
                                line:
                                    setup.voiceBackend === 'self-hosted'
                                        ? setup.voice
                                            ? setup.voiceSpeech
                                                ? t('settings.workspace-setup:voice.selfHosted')
                                                : t('settings.workspace-setup:voice.selfHostedDevices')
                                            : t('settings.workspace-setup:voice.selfHostedNeeds')
                                        : setup.voice
                                          ? t('settings.workspace-setup:voice.present')
                                          : t('settings.workspace-setup:voice.needs'),
                            })}
                        </p>
                        {setup.dataKey && <DataKeySetup dataKey={setup.dataKey} readOnly={readOnly} mutate={mutate} />}
                        {setup.backup && (
                            <p data-slot="setup-backup">
                                {t('settings.workspace-setup:lines.backups', { line: backupLine(setup.backup, when) })}
                            </p>
                        )}
                        {setup.backup?.plugins?.length ? (
                            <p
                                data-slot="setup-plugin-backups"
                                className={pluginBackupsAlarm(setup.backup.plugins) ? 'text-destructive' : undefined}
                            >
                                {t('settings.workspace-setup:lines.plugins', {
                                    line: pluginBackupsLine(setup.backup.plugins, when),
                                })}
                            </p>
                        ) : null}
                        {setup.backup?.continuous && (
                            <p
                                data-slot="setup-continuous-copy"
                                className={setup.backup.continuous.behind ? 'text-destructive' : undefined}
                            >
                                {t('settings.workspace-setup:lines.continuous', {
                                    line: continuousLine(setup.backup.continuous, when),
                                })}
                            </p>
                        )}
                        {setup.backup?.continuous?.offsite && (
                            <p
                                data-slot="setup-continuous-offsite"
                                className={setup.backup.continuous.offsite.behind ? 'text-destructive' : undefined}
                            >
                                {t('settings.workspace-setup:lines.offsite', {
                                    line: continuousOffsiteLine(setup.backup.continuous.offsite, when),
                                })}
                            </p>
                        )}
                        {setup.backup?.restoreDrill && (
                            <RestoreDrill drill={setup.backup.restoreDrill} readOnly={readOnly} mutate={mutate} />
                        )}
                        {setup.backup?.restoreDrill && !readOnly && (
                            <RecoveryKeyCheckSetup drill={setup.backup.restoreDrill} mutate={mutate} />
                        )}
                    </div>
                </section>
            </SettingsCard>
        );
    },
);

/**
 * Public research and saved memories for every socio. Each saves as it is
 * checked (CB-308). Both stop the turns running now when they change (and
 * research only when it's turned off), so the toast says so.
 */
function PermissionsCard({
    researchAllowed,
    memoryAllowed,
    readOnly,
    mutate,
}: {
    researchAllowed: boolean;
    memoryAllowed: boolean;
    readOnly: boolean;
    mutate: Mutate;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const auto = useAutosave({ researchAllowed, memoryAllowed }, (value) => mutate('/settings', 'PATCH', value));
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="workspace-permissions">
                <AutosaveHeader
                    title={t('settings.workspace:permissions.title')}
                    status={!readOnly ? auto.status : undefined}
                >
                    {!readOnly && t('settings.workspace:permissions.autosave')}
                </AutosaveHeader>
                <PermissionRow
                    title={t('settings.workspace:permissions.research.title')}
                    checked={auto.value.researchAllowed}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { researchAllowed: on },
                            t('settings.workspace:permissions.research.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace:permissions.research.description')}
                </PermissionRow>
                <PermissionRow
                    title={t('settings.workspace:permissions.memory.title')}
                    checked={auto.value.memoryAllowed}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { memoryAllowed: on },
                            t('settings.workspace:permissions.memory.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace:permissions.memory.description')}
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.settings')}</p>}
            </section>
        </SettingsCard>
    );
}

type Mutate = (path: string, method: string, body?: unknown) => Promise<boolean>;

/**
 * Service setup's "Restore drill: …" line (CB-111), in red when the last
 * one failed, and "Run drill now" for admins: the server runs it in the
 * background, and the line says when it's done.
 */
function RestoreDrill({
    drill,
    readOnly,
    mutate,
}: {
    drill: RestoreDrillStatus;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace-setup']);
    const { restoreDrillLine } = useSetupLines();
    const [busy, setBusy] = useState(false);
    const when = useHydrated() ? undefined : utcTime;
    return (
        <div className="grid justify-items-start gap-2">
            <p
                data-slot="setup-restore-drill"
                className={drill.last && !drill.last.ok && !drill.running ? 'text-destructive' : undefined}
            >
                {t('settings.workspace-setup:lines.drill', { line: restoreDrillLine(drill, when) })}
            </p>
            {!readOnly && (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || drill.running}
                    onClick={async () => {
                        setBusy(true);
                        await mutate('/backups/restore-drill', 'POST');
                        setBusy(false);
                    }}
                >
                    {drill.running
                        ? t('settings.workspace-setup:drill.running')
                        : t('settings.workspace-setup:drill.run')}
                </Button>
            )}
        </div>
    );
}

const LIMIT_MAX = 10_000;

/** One pair of daily limits in Settings: what it limits, and its fields. */
interface LimitsKind {
    /** The `PATCH /api/settings` field. */
    setting: 'dotDailyLimits' | 'notificationDailyLimits';
    /** The form's `data-slot` and its inputs' id prefix. */
    slot: string;
    /** Its words: `settings.workspace:dailyLimits.<kind>`. */
    kind: 'dot' | 'notification';
}

/**
 * How much Dots may file a day: capability requests, board items, comments
 * and votes, each counted on its own. Saved over the server's limits
 * (`DOT_REQUESTS_PER_DOT_DAILY`, `DOT_REQUESTS_PER_USER_DAILY`).
 */
const DOT_LIMITS: LimitsKind = { setting: 'dotDailyLimits', slot: 'dot-limit', kind: 'dot' };

/**
 * How many notifications Dots may send a day with `notify_user` (CB-114),
 * per Dot to one person and per person from all their Dots. Saved over
 * the server's limits (`NOTIFY_PER_DOT_DAILY`, `NOTIFY_PER_USER_DAILY`).
 */
const NOTIFICATION_LIMITS: LimitsKind = {
    setting: 'notificationDailyLimits',
    slot: 'notification-limit',
    kind: 'notification',
};

/** A pair of daily limits, per Dot and per person; admins edit them. */
function DailyLimits({
    setting,
    slot,
    kind,
    limits,
    readOnly,
    mutate,
}: LimitsKind & {
    limits: { perDot: number; perUser: number } | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const title = t(`settings.workspace:dailyLimits.${kind}.title`);
    const whole = (value: string) =>
        /^\d+$/.test(value.trim()) && Number(value) <= LIMIT_MAX ? Number(value) : undefined;
    const auto = useAutosave(
        {
            perDot: String(limits?.perDot ?? ''),
            perUser: String(limits?.perUser ?? ''),
        },
        (value) =>
            mutate('/settings', 'PATCH', {
                [setting]: {
                    perDot: whole(value.perDot),
                    perUser: whole(value.perUser),
                },
            }),
    );
    const commit = () =>
        void auto.commit(t(`settings.workspace:dailyLimits.${kind}.saved`), (value) =>
            whole(value.perDot) === undefined || whole(value.perUser) === undefined
                ? t('settings.workspace:dailyLimits.invalid', { max: LIMIT_MAX })
                : undefined,
        );
    const field = (id: string, label: string, hint: string, key: 'perDot' | 'perUser') => (
        <div className="grid gap-1.5">
            <label htmlFor={id} className="font-medium">
                {label}
            </label>
            <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={0}
                max={LIMIT_MAX}
                step={1}
                className="w-32"
                disabled={readOnly}
                value={auto.value[key]}
                onChange={(event) => auto.edit({ [key]: event.target.value })}
                onBlur={commit}
            />
            <p className="text-muted-foreground">{hint}</p>
        </div>
    );
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot={`${slot}s`}
                // Enter saves too, like leaving the field.
                onSubmit={(e) => {
                    e.preventDefault();
                    commit();
                }}
            >
                <AutosaveHeader title={title} status={!readOnly ? auto.status : undefined}>
                    {t(`settings.workspace:dailyLimits.${kind}.intro`)}
                </AutosaveHeader>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {field(
                        `${slot}-per-dot`,
                        t('settings.workspace:dailyLimits.perDot'),
                        t(`settings.workspace:dailyLimits.${kind}.perDotHint`),
                        'perDot',
                    )}
                    {field(
                        `${slot}-per-user`,
                        t('settings.workspace:dailyLimits.perUser'),
                        t(`settings.workspace:dailyLimits.${kind}.perUserHint`),
                        'perUser',
                    )}
                </div>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.limits')}</p>}
            </form>
        </SettingsCard>
    );
}

const HOURS_MAX = 720;
const SECONDS_MIN = 10;
const SECONDS_MAX = 86_400;
const DRILL_DAYS_MAX = 365;
const PURGE_DAYS_MAX = 365;

/**
 * How often the server backs up (CB-112): the scheduled backups, the
 * continuous copy's files off-site and its restore drill (CB-111), and how
 * long permanent removals' backups stay (CB-391). Saved over the server's
 * values (`BACKUP_INTERVAL_HOURS`, `BACKUP_LTX_INTERVAL_SECONDS`,
 * `RESTORE_DRILL_INTERVAL_DAYS`, `PURGE_BACKUP_DAYS`); the
 * server applies them from its next check, without a restart.
 */
function BackupScheduleSetting({
    schedule,
    readOnly,
    mutate,
}: {
    schedule: BackupSchedule;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const auto = useAutosave(
        {
            hours: String(schedule.intervalHours),
            seconds: String(schedule.ltxIntervalSeconds),
            days: String(schedule.drillIntervalDays),
            purgeDays: String(schedule.purgeBackupDays),
        },
        (value) => mutate('/settings', 'PATCH', { backupSchedule: parse(value) }),
    );
    const commit = () =>
        void auto.commit(t('settings.workspace:backupSchedule.saved'), (value) => {
            const { intervalHours, ltxIntervalSeconds, drillIntervalDays, purgeBackupDays } = parse(value);
            return !(intervalHours <= HOURS_MAX) ||
                !(
                    ltxIntervalSeconds === 0 ||
                    (ltxIntervalSeconds >= SECONDS_MIN && ltxIntervalSeconds <= SECONDS_MAX)
                ) ||
                !(drillIntervalDays <= DRILL_DAYS_MAX) ||
                !(purgeBackupDays >= 1 && purgeBackupDays <= PURGE_DAYS_MAX)
                ? t('settings.workspace:backupSchedule.invalid', {
                      hours: HOURS_MAX,
                      secondsMin: SECONDS_MIN,
                      secondsMax: SECONDS_MAX,
                      drillDays: DRILL_DAYS_MAX,
                      purgeDays: PURGE_DAYS_MAX,
                  })
                : undefined;
        });
    const field = (
        id: string,
        label: string,
        key: 'hours' | 'seconds' | 'days' | 'purgeDays',
        props: {
            inputMode: 'decimal' | 'numeric';
            min?: number;
            max: number;
            step: number | 'any';
        },
        hint: ReactNode,
    ) => (
        <div className="grid content-start gap-1.5">
            <label htmlFor={id} className="font-medium">
                {label}
            </label>
            <Input
                id={id}
                type="number"
                min={props.min ?? 0}
                {...props}
                className="w-32"
                disabled={readOnly}
                value={auto.value[key]}
                onChange={(event) => auto.edit({ [key]: event.target.value })}
                onBlur={commit}
            />
            <p className="text-muted-foreground">{hint}</p>
        </div>
    );
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot="backup-schedule"
                onSubmit={(e) => {
                    e.preventDefault();
                    commit();
                }}
            >
                <AutosaveHeader
                    title={t('settings.workspace:backupSchedule.title')}
                    status={!readOnly ? auto.status : undefined}
                >
                    {t('settings.workspace:backupSchedule.intro')}
                </AutosaveHeader>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {field(
                        'backup-interval-hours',
                        t('settings.workspace:backupSchedule.hours.label'),
                        'hours',
                        { inputMode: 'decimal', max: HOURS_MAX, step: 'any' },
                        t('settings.workspace:backupSchedule.hours.hint'),
                    )}
                    {field(
                        'backup-ltx-interval',
                        t('settings.workspace:backupSchedule.seconds.label'),
                        'seconds',
                        { inputMode: 'numeric', max: SECONDS_MAX, step: 1 },
                        t('settings.workspace:backupSchedule.seconds.hint', { min: SECONDS_MIN }),
                    )}
                    {field(
                        'backup-drill-interval',
                        t('settings.workspace:backupSchedule.days.label'),
                        'days',
                        { inputMode: 'numeric', max: DRILL_DAYS_MAX, step: 1 },
                        t('settings.workspace:backupSchedule.days.hint'),
                    )}
                    {field(
                        'purge-backup-days',
                        t('settings.workspace:backupSchedule.purgeDays.label'),
                        'purgeDays',
                        { inputMode: 'numeric', min: 1, max: PURGE_DAYS_MAX, step: 1 },
                        t('settings.workspace:backupSchedule.purgeDays.hint'),
                    )}
                </div>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.backupSchedule')}</p>}
            </form>
        </SettingsCard>
    );
}

/** The schedule's fields as numbers; NaN for one that isn't. */
function parse(value: { hours: string; seconds: string; days: string; purgeDays: string }) {
    return {
        intervalHours: /^\d+(\.\d+)?$/.test(value.hours.trim()) ? Number(value.hours) : NaN,
        ltxIntervalSeconds: /^\d+$/.test(value.seconds.trim()) ? Number(value.seconds) : NaN,
        drillIntervalDays: /^\d+$/.test(value.days.trim()) ? Number(value.days) : NaN,
        purgeBackupDays: /^\d+$/.test(value.purgeDays.trim()) ? Number(value.purgeDays) : NaN,
    };
}
