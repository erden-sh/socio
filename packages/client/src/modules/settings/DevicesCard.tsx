import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { deviceListSchema, type DeviceSummary } from '@socio/shared/device-sign-in';

import { ConfirmDelete } from '../../components/confirm-delete';
import { api } from '../../lib/api';

import { ACTIVE_NOW_MS, useProviderLabel } from './people/people-format';

import { Button } from '@/components/ui/button';

const PLATFORM_KEYS = {
    ios: 'settings.devices:platforms.ios',
    android: 'settings.devices:platforms.android',
} as const;

const METHOD_KEYS = {
    link: 'settings.devices:methods.link',
    'link:email': 'settings.devices:methods.linkEmail',
    passkey: 'settings.devices:methods.passkey',
    password: 'settings.devices:methods.password',
} as const;

const known = <T extends object>(map: T, key: string): key is Extract<keyof T, string> => Object.hasOwn(map, key);
const sameYear = (at: number, now: number) => new Date(at).getFullYear() === new Date(now).getFullYear();

/** What a device's row says under its name: platform · state · last seen · since. */
export function useDeviceDetails() {
    const { t } = useTranslation(['settings.devices']);
    const providerLabel = useProviderLabel();
    const methodLabel = (method: string | null) => {
        if (!method) {
            return null;
        }
        if (method.startsWith('provider:')) {
            return providerLabel(method.slice('provider:'.length));
        }
        return known(METHOD_KEYS, method) ? t(METHOD_KEYS[method]) : providerLabel(method);
    };
    /** "last seen 25 min ago", "last seen yesterday", "last seen Oct 2". */
    const lastSeen = (at: number, now: number) => {
        const ms = Math.max(0, now - at);
        if (ms < ACTIVE_NOW_MS) {
            return t('settings.devices:lastSeen.now');
        }
        if (ms < 3_600_000) {
            return t('settings.devices:lastSeen.minutes', { count: Math.round(ms / 60_000) });
        }
        if (ms < 86_400_000) {
            return t('settings.devices:lastSeen.hours', { count: Math.round(ms / 3_600_000) });
        }
        const days = Math.floor(ms / 86_400_000);
        if (days === 1) {
            return t('settings.devices:lastSeen.yesterday');
        }
        if (days < 14) {
            return t('settings.devices:lastSeen.days', { count: days });
        }
        if (days < 35) {
            return t('settings.devices:lastSeen.weeks', { count: Math.floor(days / 7) });
        }
        return sameYear(at, now)
            ? t('settings.devices:lastSeen.date', { at: new Date(at) })
            : t('settings.devices:lastSeen.date', { context: 'otherYear', at: new Date(at) });
    };
    return (device: DeviceSummary, now = Date.now()) => {
        const method = methodLabel(device.signInMethod);
        const since = Date.parse(device.createdAt);
        return [
            device.platform && known(PLATFORM_KEYS, device.platform) ? t(PLATFORM_KEYS[device.platform]) : null,
            device.state === 'active'
                ? method
                    ? t('settings.devices:details.by', { method })
                    : t('settings.devices:details.signedOut')
                : device.state === 'revoked_and_erase'
                  ? // The phone erases its copy when it next reaches the server.
                    t('settings.devices:details.eraseRequested')
                  : t('settings.devices:details.signedOut'),
            device.lastSeenAt ? lastSeen(Date.parse(device.lastSeenAt), now) : null,
            sameYear(since, now)
                ? t('settings.devices:details.since', { at: new Date(since) })
                : t('settings.devices:details.since', { context: 'otherYear', at: new Date(since) }),
        ]
            .filter(Boolean)
            .join(' · ');
    };
}

type Ending = { device: DeviceSummary; erase: boolean };

/**
 * The Socio app on a person's phones (CB-352, WD): their own under
 * Settings → Account, or anyone's on an admin's person page. Each device
 * that is signed in can be signed out, or signed out and erased, after a
 * confirm that says what each does.
 */
export function DevicesCard({
    accountId,
    locked = false,
    onChanged,
    version,
}: {
    /** An admin's view of this account; the person's own without it. */
    accountId?: string;
    /** Read only (the workspace owner's account, seen by another admin). */
    locked?: boolean;
    onChanged?: () => void;
    /** Changes when what's around it reloaded (a sign-out everywhere): load again. */
    version?: unknown;
}) {
    const { t } = useTranslation(['settings.devices']);
    const details = useDeviceDetails();
    const base = accountId ? `/accounts/${encodeURIComponent(accountId)}/devices` : '/auth/devices';
    const [devices, setDevices] = useState<DeviceSummary[]>();
    const [error, setError] = useState('');
    const [ending, setEnding] = useState<Ending>();
    const load = useCallback(
        () =>
            api(base)
                .then((answer) => {
                    setDevices(deviceListSchema.parse(answer).devices);
                    setError('');
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : t('settings.devices:loadFailed'))),
        [base, t],
    );
    useEffect(() => void load(), [load, version]);
    const own = !accountId;
    // Own devices speak to the person; an admin's view speaks of them.
    const context = own ? undefined : 'admin';
    const end = async ({ device, erase }: Ending) => {
        try {
            await api(`${base}/${encodeURIComponent(device.id)}${erase ? '?erase=1' : ''}`, 'DELETE');
            toast.success(
                erase
                    ? t('settings.devices:erase.done', { device: device.label })
                    : t('settings.devices:signOut.done', { device: device.label }),
            );
            setEnding(undefined);
            await load();
            onChanged?.();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('settings.devices:signOutFailed'));
        }
    };
    return (
        <section className="grid gap-2" data-slot="devices" aria-label={t('settings.devices:title')}>
            {!accountId && <h3 className="font-medium">{t('settings.devices:title')}</h3>}
            <p className="text-muted-foreground">{t('settings.devices:intro', { context })}</p>
            {error && (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            )}
            {devices && !devices.length && (
                <p className="text-muted-foreground">{t('settings.devices:empty', { context })}</p>
            )}
            {devices && devices.length > 0 && (
                <ul aria-label={t('settings.devices:list')} className="grid">
                    {devices.map((device) => (
                        <li
                            key={device.id}
                            data-slot="device"
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-2 first:border-t-0"
                        >
                            <span className="min-w-0 flex-1">
                                {device.label}
                                {device.current && (
                                    <span className="text-muted-foreground"> {t('settings.devices:current')}</span>
                                )}
                                <span className="block text-xs text-muted-foreground">{details(device)}</span>
                            </span>
                            {device.state === 'active' && !locked && (
                                <span className="flex shrink-0 items-center gap-1">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setEnding({ device, erase: false })}
                                        aria-label={t('settings.devices:signOut.label', { device: device.label })}
                                    >
                                        {t('settings.devices:signOut.button')}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setEnding({ device, erase: true })}
                                        aria-label={t('settings.devices:erase.label', { device: device.label })}
                                    >
                                        {t('settings.devices:erase.button')}
                                    </Button>
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {ending && (
                <ConfirmDelete
                    slot="device-sign-out"
                    title={
                        ending.erase
                            ? t('settings.devices:erase.title', { device: ending.device.label })
                            : t('settings.devices:signOut.title', { device: ending.device.label })
                    }
                    action={ending.erase ? t('settings.devices:erase.action') : t('settings.devices:signOut.action')}
                    onClose={() => setEnding(undefined)}
                    onConfirm={() => end(ending)}
                >
                    {ending.erase
                        ? t('settings.devices:erase.body', { context, device: ending.device.label })
                        : t('settings.devices:signOut.body', { context, device: ending.device.label })}
                </ConfirmDelete>
            )}
        </section>
    );
}
