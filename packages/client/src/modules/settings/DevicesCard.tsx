import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { deviceListSchema, type DeviceSummary } from '@socio/shared/device-sign-in';

import { ConfirmDelete } from '../../components/confirm-delete';
import { api } from '../../lib/api';

import { lastActive, shortDate, signInMethodLabel } from './people/people-format';

import { Button } from '@/components/ui/button';

const PLATFORMS: Record<string, string> = { ios: 'iPhone or iPad', android: 'Android' };

/** What a device's row says under its name. */
export function deviceDetails(device: DeviceSummary, now = Date.now()) {
    const method = signInMethodLabel(device.signInMethod);
    return [
        device.platform ? PLATFORMS[device.platform] : null,
        device.state === 'active'
            ? method
                ? `by ${method}`
                : 'Signed out'
            : device.state === 'revoked_and_erase'
              ? // The phone erases its copy when it next reaches the server.
                'Signed out; erase requested'
              : 'Signed out',
        device.lastSeenAt
            ? `last seen ${lastActive(Date.parse(device.lastSeenAt), now).toLocaleLowerCase('en-US')}`
            : null,
        `since ${shortDate(device.createdAt, now)}`,
    ]
        .filter(Boolean)
        .join(' · ');
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
                .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the devices.')),
        [base],
    );
    useEffect(() => void load(), [load, version]);
    const own = !accountId;
    const end = async ({ device, erase }: Ending) => {
        try {
            await api(`${base}/${encodeURIComponent(device.id)}${erase ? '?erase=1' : ''}`, 'DELETE');
            toast.success(erase ? `${device.label} signed out; it erases its copy` : `${device.label} signed out`);
            setEnding(undefined);
            await load();
            onChanged?.();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not sign the device out.');
        }
    };
    return (
        <section className="grid gap-2" data-slot="devices" aria-label="The Socio app">
            {!accountId && <h3 className="font-medium">The Socio app</h3>}
            <p className="text-muted-foreground">
                {own ? 'Your phones' : 'Their phones'} with the Socio app. Signing a device out ends its sessions;
                erasing also removes this workspace’s copy from it the next time it connects.
            </p>
            {error && (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            )}
            {devices && !devices.length && (
                <p className="text-muted-foreground">{own ? 'You haven’t' : 'They haven’t'} signed in on the app.</p>
            )}
            {devices && devices.length > 0 && (
                <ul aria-label="Devices with the Socio app" className="grid">
                    {devices.map((device) => (
                        <li
                            key={device.id}
                            data-slot="device"
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-2 first:border-t-0"
                        >
                            <span className="min-w-0 flex-1">
                                {device.label}
                                {device.current && <span className="text-muted-foreground"> (this device)</span>}
                                <span className="block text-xs text-muted-foreground">{deviceDetails(device)}</span>
                            </span>
                            {device.state === 'active' && !locked && (
                                <span className="flex shrink-0 items-center gap-1">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setEnding({ device, erase: false })}
                                        aria-label={`Sign out ${device.label}`}
                                    >
                                        Sign out this device
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setEnding({ device, erase: true })}
                                        aria-label={`Sign out and erase ${device.label}`}
                                    >
                                        Sign out and erase
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
                        ending.erase ? `Sign out and erase ${ending.device.label}?` : `Sign out ${ending.device.label}?`
                    }
                    action={ending.erase ? 'Sign out and erase' : 'Sign out'}
                    onClose={() => setEnding(undefined)}
                    onConfirm={() => end(ending)}
                >
                    {ending.erase
                        ? `${ending.device.label} is signed out, and the next time it connects it deletes everything it keeps from this workspace, including anything not sent yet. ${own ? 'You' : 'They'} can sign in on it again.`
                        : `${ending.device.label} is signed out; what it keeps from this workspace stays on it until ${own ? 'you sign' : 'they sign'} in again or remove the app.`}
                </ConfirmDelete>
            )}
        </section>
    );
}
