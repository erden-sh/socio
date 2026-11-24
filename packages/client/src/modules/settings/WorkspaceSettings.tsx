import { useState, type ReactNode } from 'react';

import { isAdmin } from '@socio/shared/roles';
import type { BackupSchedule, RestoreDrillStatus, State, WorkspaceState } from '@socio/shared/types';

import { useHydrated } from '../../lib/client-only';
import { utcTime } from '../../lib/local-time';
import { DictationAllowedSetting, TranscriptionSetting } from '../voice/DictationSettings';
import { VoiceCallsSetting } from '../voice/VoiceCallSettings';

import { SettingsCard } from './AccountSettings';
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
import {
    backupLine,
    continuousLine,
    continuousOffsiteLine,
    pluginBackupsAlarm,
    pluginBackupsLine,
    restoreDrillLine,
} from './setup-lines';
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
    // Match the server before switching setup timestamps to the reader’s zone.
    const when = useHydrated() ? undefined : utcTime;
    return (
        <>
            {isAdmin(workspace.user) && (
                <BrandingSetting
                    // Saved changes come in through the props (useAutosave follows them).
                    branding={state.settings.branding}
                    mutate={mutate}
                />
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
            <SettingsCard>
                <section className="grid gap-2" data-slot="service-setup">
                    <h3 className="font-medium">Service setup</h3>
                    <div className="grid gap-1 text-muted-foreground">
                        <p>
                            {setup.missing.length
                                ? `Add ${setup.missing.join(', ')} to the server environment, then restart.`
                                : 'Text configuration is present. A successful conversation confirms connectivity.'}
                        </p>
                        {setup.inference && (
                            <p>
                                Model:{' '}
                                {setup.inference.available
                                    ? `${setup.inference.label}${setup.inference.source === 'byo' ? ' (your own subscription)' : ''}`
                                    : setup.inference.byoAllowed
                                      ? 'none yet; connect your own in Account → Inference'
                                      : 'none yet; an admin sets one up'}
                                .
                            </p>
                        )}
                        <p>
                            Telegram:{' '}
                            {setup.telegram === 'not_configured'
                                ? 'not configured (set TELEGRAM_BOT_TOKEN)'
                                : setup.telegram === 'online'
                                  ? `online${setup.telegramBot ? ` as @${setup.telegramBot}` : ''}`
                                  : setup.telegram === 'connecting'
                                    ? 'connecting'
                                    : 'not connected; check the token and server logs'}
                            .
                        </p>
                        <p>
                            Voice:{' '}
                            {setup.voiceBackend === 'self-hosted'
                                ? setup.voice
                                    ? `self-hosted, configuration present${setup.voiceSpeech ? '' : ' (devices speak the replies)'}`
                                    : 'self-hosted, needs a transcription server with a realtime socket'
                                : setup.voice
                                  ? 'configuration present'
                                  : 'needs VOICE_API_KEY and VOICE_MODEL'}
                            .
                        </p>
                        {setup.dataKey && <DataKeySetup dataKey={setup.dataKey} readOnly={readOnly} mutate={mutate} />}
                        {setup.backup && <p data-slot="setup-backup">Backups: {backupLine(setup.backup, when)}.</p>}
                        {setup.backup?.plugins?.length ? (
                            <p
                                data-slot="setup-plugin-backups"
                                className={pluginBackupsAlarm(setup.backup.plugins) ? 'text-destructive' : undefined}
                            >
                                Plugin data: {pluginBackupsLine(setup.backup.plugins, when)}.
                            </p>
                        ) : null}
                        {setup.backup?.continuous && (
                            <p
                                data-slot="setup-continuous-copy"
                                className={setup.backup.continuous.behind ? 'text-destructive' : undefined}
                            >
                                Continuous copy: {continuousLine(setup.backup.continuous, when)}.
                            </p>
                        )}
                        {setup.backup?.continuous?.offsite && (
                            <p
                                data-slot="setup-continuous-offsite"
                                className={setup.backup.continuous.offsite.behind ? 'text-destructive' : undefined}
                            >
                                Continuous copy off-site: {continuousOffsiteLine(setup.backup.continuous.offsite, when)}
                                .
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
        </>
    );
}

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
    const auto = useAutosave({ researchAllowed, memoryAllowed }, (value) => mutate('/settings', 'PATCH', value));
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="workspace-permissions">
                <AutosaveHeader title="Permissions" status={!readOnly ? auto.status : undefined}>
                    {!readOnly && 'Changes save as you make them.'}
                </AutosaveHeader>
                <PermissionRow
                    title="Public-page research"
                    checked={auto.value.researchAllowed}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { researchAllowed: on },
                            on
                                ? 'Public-page research turned on'
                                : 'Public-page research turned off. Turns running now were stopped.',
                        )
                    }
                >
                    Allow web search and reading public pages, cited by URL. Global settings always take precedence.
                </PermissionRow>
                <PermissionRow
                    title="Use saved memories"
                    checked={auto.value.memoryAllowed}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { memoryAllowed: on },
                            `Saved memories turned ${on ? 'on' : 'off'}. Turns running now were stopped.`,
                        )
                    }
                >
                    Include your preferences in new turns. Changing permission stops active work.
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change these settings.</p>}
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
    const [busy, setBusy] = useState(false);
    const when = useHydrated() ? undefined : utcTime;
    return (
        <div className="grid justify-items-start gap-2">
            <p
                data-slot="setup-restore-drill"
                className={drill.last && !drill.last.ok && !drill.running ? 'text-destructive' : undefined}
            >
                Restore drill: {restoreDrillLine(drill, when)}.
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
                    {drill.running ? 'Drill running…' : 'Run drill now'}
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
    title: string;
    intro: string;
    perDotHint: string;
    perUserHint: string;
}

/**
 * How much Dots may file a day: capability requests, board items, comments
 * and votes, each counted on its own. Saved over the server's limits
 * (`DOT_REQUESTS_PER_DOT_DAILY`, `DOT_REQUESTS_PER_USER_DAILY`).
 */
const DOT_LIMITS: LimitsKind = {
    setting: 'dotDailyLimits',
    slot: 'dot-limit',
    title: 'Socio filing limits',
    intro: 'How much socios may file a day: capability requests, board items, comments and votes each count on their own. 0 turns filing off.',
    perDotHint: 'For all its people, in 24 hours.',
    perUserHint: 'By all their socios, in 24 hours.',
};

/**
 * How many notifications Dots may send a day with `notify_user` (CB-114),
 * per Dot to one person and per person from all their Dots. Saved over
 * the server's limits (`NOTIFY_PER_DOT_DAILY`, `NOTIFY_PER_USER_DAILY`).
 */
const NOTIFICATION_LIMITS: LimitsKind = {
    setting: 'notificationDailyLimits',
    slot: 'notification-limit',
    title: 'Notification limits',
    intro: 'How often socios may notify people a day (notify_user): one shown in the app instead, or held back while they look at the chat, counts too. Tests don’t. 0 turns socios’ notifications off.',
    perDotHint: 'From one socio to one person, in 24 hours.',
    perUserHint: 'To one person from all their socios, in 24 hours.',
};

/** A pair of daily limits, per Dot and per person; admins edit them. */
function DailyLimits({
    setting,
    slot,
    title,
    intro,
    perDotHint,
    perUserHint,
    limits,
    readOnly,
    mutate,
}: LimitsKind & {
    limits: { perDot: number; perUser: number } | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
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
        void auto.commit(`${title} saved`, (value) =>
            whole(value.perDot) === undefined || whole(value.perUser) === undefined
                ? `Use whole numbers from 0 to ${LIMIT_MAX}.`
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
                    {intro}
                </AutosaveHeader>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {field(`${slot}-per-dot`, 'Per socio', perDotHint, 'perDot')}
                    {field(`${slot}-per-user`, 'Per person', perUserHint, 'perUser')}
                </div>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change these limits.</p>}
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
        void auto.commit('Backup schedule saved', (value) => {
            const { intervalHours, ltxIntervalSeconds, drillIntervalDays, purgeBackupDays } = parse(value);
            return !(intervalHours <= HOURS_MAX) ||
                !(
                    ltxIntervalSeconds === 0 ||
                    (ltxIntervalSeconds >= SECONDS_MIN && ltxIntervalSeconds <= SECONDS_MAX)
                ) ||
                !(drillIntervalDays <= DRILL_DAYS_MAX) ||
                !(purgeBackupDays >= 1 && purgeBackupDays <= PURGE_DAYS_MAX)
                ? `Use 0 to ${HOURS_MAX} hours, 0 or ${SECONDS_MIN} to ${SECONDS_MAX} whole seconds, 0 to ${DRILL_DAYS_MAX} whole days for the drill, and 1 to ${PURGE_DAYS_MAX} for removal backups.`
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
                <AutosaveHeader title="Backup schedule" status={!readOnly ? auto.status : undefined}>
                    How often the server backs up, and how long permanent removals’ backups stay. 0 turns an interval
                    off. Changes apply within minutes, without a restart.
                </AutosaveHeader>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {field(
                        'backup-interval-hours',
                        'Backups, every (hours)',
                        'hours',
                        { inputMode: 'decimal', max: HOURS_MAX, step: 'any' },
                        'The database and data spaces, counted from the last backup, with the off-site copy when it is set up.',
                    )}
                    {field(
                        'backup-ltx-interval',
                        'Continuous copy off-site, every (seconds)',
                        'seconds',
                        { inputMode: 'numeric', max: SECONDS_MAX, step: 1 },
                        <>
                            Litestream’s newest changes, sealed, to the off-site copy; at least {SECONDS_MIN}. Needs the
                            off-site copy and the continuous copy set up.
                        </>,
                    )}
                    {field(
                        'backup-drill-interval',
                        'Restore drill, every (days)',
                        'days',
                        { inputMode: 'numeric', max: DRILL_DAYS_MAX, step: 1 },
                        'Restores the continuous copy into scratch files and checks them, off-site too when it is set up. 0: only with Run drill now.',
                    )}
                    {field(
                        'purge-backup-days',
                        'Permanent removal backups, kept (days)',
                        'purgeDays',
                        { inputMode: 'numeric', min: 1, max: PURGE_DAYS_MAX, step: 1 },
                        'What each permanent removal backed up goes with the first scheduled backup after this many days. Never sent off-site.',
                    )}
                </div>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change the backup schedule.</p>}
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
