import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    APP_LEASE_DAYS_RANGE,
    APP_POLICY_DEFAULTS,
    APP_WIPE_DAYS_RANGE,
    type AppPolicy,
} from '@socio/shared/device-sign-in';
import type { Settings } from '@socio/shared/types';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, type SaveStatus } from './autosave';
import { onDemand } from './on-demand';

import { PermissionRow } from '@/components/form-fields';
import { Input } from '@/components/ui/input';

type Days = 'leaseDays' | 'wipeDays';

/** The two periods; their words are `settings.workspace-apps:policy.<key>`. */
const DAYS: readonly { key: Days; range: { min: number; max: number } }[] = [
    { key: 'leaseDays', range: APP_LEASE_DAYS_RANGE },
    { key: 'wipeDays', range: APP_WIPE_DAYS_RANGE },
];

/**
 * The Socio app's policy (CB-379) in Settings → Workspace → General: what
 * the workspace manifest tells the app about its lease (days without
 * contact before the copy locks, then before it is erased), the app lock
 * and message text in notifications. Each saved over its `AUTH_APP_*`
 * variable, else the app's defaults (30, 30, off, on). Members read it;
 * only admins change it. The app reads it when it signs in.
 */
function AppPolicySettingBody({
    policy,
    readOnly,
    mutate,
}: {
    policy: Settings['appPolicy'];
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    // Each field on its own: the server's value (the props, so another
    // admin's change shows), this admin's value while it is saving or not yet
    // in the props, and the days as typed. A save sends only its own field,
    // which the server merges into the saved policy; one that fails puts back
    // only that field, to what the server has. Nothing is queued, so no save
    // carries another's value.
    const { t } = useTranslation(['settings.workspace-apps', 'settings.workspace', 'settings']);
    const server: AppPolicy = { ...APP_POLICY_DEFAULTS, ...policy };
    const [mine, setMine] = useState<Partial<AppPolicy>>({});
    const [typed, setTyped] = useState<Partial<Record<Days, string>>>({});
    const [pending, setPending] = useState(0);
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState('');
    // The latest save of each field: an older one's answer changes nothing.
    const latest = useRef<Partial<Record<keyof AppPolicy, number>>>({});
    const saves = useRef(0);
    // Each field's saves go one after another, so the last one made is the last saved.
    const chains = useRef<Partial<Record<keyof AppPolicy, Promise<unknown>>>>({});
    const shown: AppPolicy = { ...server, ...mine };

    // Once the props have this admin's value and it isn't saving, the props lead again.
    const serverKey = JSON.stringify(server);
    useEffect(() => {
        setMine((current) => {
            const left = Object.fromEntries(
                Object.entries(current).filter(
                    ([key, value]) =>
                        latest.current[key as keyof AppPolicy] !== undefined ||
                        server[key as keyof AppPolicy] !== value,
                ),
            );
            return Object.keys(left).length === Object.keys(current).length ? current : left;
        });
        // oxlint-disable-next-line react-hooks/exhaustive-deps -- `server` is new each render; its key is what changes.
    }, [serverKey]);

    const save = async <K extends keyof AppPolicy>(key: K, value: AppPolicy[K], message: string) => {
        const id = ++saves.current;
        latest.current[key] = id;
        setMine((current) => ({ ...current, [key]: value }));
        setPending((count) => count + 1);
        setStatus('saving');
        setError('');
        const sent = (chains.current[key] ?? Promise.resolve()).then(() =>
            mutate('/settings', 'PATCH', { appPolicy: { [key]: value } }).catch(() => false),
        );
        chains.current[key] = sent;
        const ok = await sent;
        if (chains.current[key] === sent) {
            delete chains.current[key];
        }
        setPending((count) => count - 1);
        const current = latest.current[key] === id;
        if (current) {
            delete latest.current[key];
        }
        if (ok && current) {
            // The shell's `mutate` resolves once the state has refreshed
            // (AppShell), so the props now hold what the server has, this
            // save's value or a later admin's: they lead again.
            setMine(({ [key]: _done, ...rest }) => rest as Partial<AppPolicy>);
        }
        if (!ok) {
            if (current) {
                // Back to what the server has for this field alone.
                setMine(({ [key]: _gone, ...rest }) => rest as Partial<AppPolicy>);
            }
            setError(t('settings:save.failed'));
            setStatus('idle');
            return;
        }
        setStatus('saved');
        toast.success(message);
    };

    const commitDays = (key: Days, range: { min: number; max: number }) => {
        const text = typed[key];
        if (text === undefined) {
            return;
        }
        const number = Number(text);
        if (!Number.isInteger(number) || number < range.min || number > range.max) {
            setError(t('settings.workspace-apps:policy.invalidDays', { min: range.min, max: range.max }));
            return;
        }
        setTyped(({ [key]: _done, ...rest }) => rest);
        if (number !== shown[key]) {
            void save(key, number, t('settings.workspace-apps:policy.saved'));
        } else {
            setError('');
        }
    };
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="app-policy-settings">
                <AutosaveHeader
                    title={t('settings.workspace-apps:policy.title')}
                    status={!readOnly ? (pending ? 'saving' : status) : undefined}
                >
                    {t('settings.workspace-apps:policy.intro')}
                </AutosaveHeader>
                {DAYS.map(({ key, range }) => (
                    <div className="grid gap-2" key={key}>
                        <label htmlFor={`app-policy-${key}`} className="font-medium">
                            {t(`settings.workspace-apps:policy.${key}.label`)}
                        </label>
                        <div className="flex items-center gap-2">
                            <Input
                                id={`app-policy-${key}`}
                                type="number"
                                inputMode="numeric"
                                min={range.min}
                                max={range.max}
                                step={1}
                                className="w-32"
                                disabled={readOnly}
                                value={typed[key] ?? String(shown[key])}
                                onChange={(event) => setTyped((current) => ({ ...current, [key]: event.target.value }))}
                                onBlur={() => commitDays(key, range)}
                            />
                            <span className="text-muted-foreground">
                                {t(`settings.workspace-apps:policy.${key}.unit`)}
                            </span>
                        </div>
                    </div>
                ))}
                <p className="text-muted-foreground">{t('settings.workspace-apps:policy.periods')}</p>
                <PermissionRow
                    title={t('settings.workspace-apps:policy.appLock.title')}
                    checked={shown.appLock}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void save(
                            'appLock',
                            on,
                            t('settings.workspace-apps:policy.appLock.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace-apps:policy.appLock.description')}
                </PermissionRow>
                <PermissionRow
                    title={t('settings.workspace-apps:policy.notificationText.title')}
                    checked={shown.notificationText}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void save(
                            'notificationText',
                            on,
                            t('settings.workspace-apps:policy.notificationText.saved', {
                                context: on ? undefined : 'off',
                            }),
                        )
                    }
                >
                    {t('settings.workspace-apps:policy.notificationText.description')}
                </PermissionRow>
                <p className="text-muted-foreground">{t('settings.workspace-apps:policy.versions')}</p>
                <SaveError error={error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.settings')}</p>}
            </section>
        </SettingsCard>
    );
}

/** Below the fold: its words load when it mounts (settings.workspace-apps, in no route's entry). */
export const AppPolicySetting = onDemand(['settings.workspace-apps'], AppPolicySettingBody);
