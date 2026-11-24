import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import type {
    ChannelPreference,
    NotificationChannelView,
    NotificationContent,
    NotificationPreferences,
} from '@socio/shared/notifications';

import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';
import { RoomNotificationsCard } from '../rooms/RoomNotifySettings';

import { SettingsCard } from './AccountSettings';
import { IssueSubscriptionsSection } from './IssueSubscriptionsSection';
import { settingsPath } from './sections';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

/** `GET /api/notifications/channels`. */
export interface ChannelsAnswer {
    channels: NotificationChannelView[];
    /** The server's key browsers subscribe with (base64url). */
    pushKey: string;
}
/** `POST /api/notifications/test`: per channel that's on and reaches somewhere. */
interface TestAnswer {
    channels: { channel: string; sent: number; failed: number }[];
}

/**
 * `localStorage` key: this browser's push subscription as the server knows
 * it (`{endpoint, id}`). The channel's targets carry no endpoints, so this
 * is how the page knows which device is this browser.
 */
export const PUSH_TARGET_KEY = 'socio:push-target';

const CONTENT_CHOICES: {
    value: NotificationContent;
    label: string;
    note: string;
}[] = [
    {
        value: 'message',
        label: 'Show the message',
        note: 'The socio’s name, its message and, where the device shows one, its image.',
    },
    {
        value: 'private',
        label: 'Private (“<socio> needs you”)',
        note: 'Only which socio needs you: the message stays in Socio until you open it.',
    },
];

/** Where push can't be turned on here, and why; `ready` where it can. */
export type PushSupport = 'ready' | 'ios' | 'unsupported' | 'denied';

export const PUSH_MESSAGES: Record<Exclude<PushSupport, 'ready'>, string> = {
    ios: 'Add Socio to your Home Screen first, then turn notifications on in the app. On iPhone and iPad, only the installed app gets notifications.',
    unsupported: 'This browser can’t get push notifications. Try another browser, or Telegram.',
    denied: 'Notifications are blocked for this site in your browser’s settings. Allow them there, then reload this page.',
};

/** The page runs as the installed app (Home Screen, or installed from the browser). */
export const installedApp = () =>
    globalThis.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** An iPhone or iPad; iPadOS's Safari says it's a Mac with a touch screen. */
const appleMobile = () =>
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/**
 * Whether this browser can turn push on: iPhone and iPad only in the
 * installed app (Safari's tabs have no push), other browsers with a
 * service worker, `PushManager` and `Notification`, and not after the
 * person blocked the site's notifications.
 */
export function pushSupport(): PushSupport {
    const capable = 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;
    if (appleMobile() && (!installedApp() || !capable)) {
        return 'ios';
    }
    if (!capable) {
        return 'unsupported';
    }
    if (Notification.permission === 'denied') {
        return 'denied';
    }
    return 'ready';
}

/** A base64url key as bytes (`applicationServerKey`). */
export function keyBytes(base64url: string) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

const sameKey = (key: ArrayBuffer | null | undefined, want: Uint8Array) => {
    if (!key) {
        return false;
    }
    const have = new Uint8Array(key);
    return have.length === want.length && have.every((b, i) => b === want[i]);
};

function storedTarget(): { endpoint: string; id: string } | undefined {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(PUSH_TARGET_KEY) ?? 'null');
        const target = value as { endpoint?: unknown; id?: unknown } | null;
        return typeof target?.endpoint === 'string' && typeof target.id === 'string'
            ? { endpoint: target.endpoint, id: target.id }
            : undefined;
    } catch {
        return undefined;
    }
}
function storeTarget(target: { endpoint: string; id: string } | undefined) {
    try {
        if (target) {
            localStorage.setItem(PUSH_TARGET_KEY, JSON.stringify(target));
        } else {
            localStorage.removeItem(PUSH_TARGET_KEY);
        }
    } catch {
        // Without storage the page can't tell this browser apart; it still works.
    }
}

/** This browser's service worker registration: the one entry.client.tsx made, or a new one. */
async function registration() {
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (!existing) {
        await navigator.serviceWorker.register('/sw.js');
    }
    return navigator.serviceWorker.ready;
}

/** This browser's push subscription now, if any (no prompt, no new worker). */
async function currentSubscription() {
    const existing = await navigator.serviceWorker.getRegistration('/');
    return (await existing?.pushManager.getSubscription()) ?? null;
}

/**
 * Turns push on in this browser: asks for permission, subscribes with the
 * server's key (again, if the browser's subscription was made for an
 * older one), and adds it to the person's devices. Returns the device.
 */
async function subscribeHere(pushKey: string) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        throw new Error(
            permission === 'denied'
                ? PUSH_MESSAGES.denied
                : 'Notifications weren’t allowed. Try again and choose Allow.',
        );
    }
    const worker = await registration();
    const key = keyBytes(pushKey);
    let subscription = await worker.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe();
        subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
    });
    const device = await api<{ id: string; label: string }>('/notifications/push/subscriptions', 'POST', {
        ...subscription.toJSON(),
        installed: installedApp(),
    });
    storeTarget({ endpoint: subscription.endpoint, id: device.id });
    return device;
}

/** "Push notifications (2 sent)", "Telegram (1 failed)". */
const reportLine = (label: string, sent: number, failed: number) =>
    `${label} (${[sent && `${sent} sent`, failed && `${failed} failed`].filter(Boolean).join(', ')})`;

/**
 * Settings → Account → Notifications (CB-114): where Dots' notifications
 * reach this person. Each channel is on or off and shows the message or
 * only "<Dot> needs you"; every change saves the whole choice at once
 * (`PATCH /api/preferences`, which replaces `notifications`). Push lists
 * the person's browsers and apps and turns push on in this one; Telegram
 * reaches the linked account. A test goes to every channel that's on.
 * Nothing is sent while the person is using the brain: then a Dot's
 * notification shows here as a toast instead (in-app-notices.ts).
 */
export function NotificationsSection({ telegram }: { telegram: boolean }) {
    const { workspace, mutate } = useShell();
    const [answer, setAnswer] = useState<ChannelsAnswer>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    // This browser: whether push can be turned on, and its subscription's
    // endpoint (null: none). Read after hydration; the server can't know.
    const [support, setSupport] = useState<PushSupport>();
    const [endpoint, setEndpoint] = useState<string | null>(null);
    const [pushError, setPushError] = useState('');
    const [tested, setTested] = useState<string>();
    const load = useCallback(
        () =>
            api<ChannelsAnswer>('/notifications/channels')
                .then((next) => {
                    setAnswer(next);
                    setError('');
                })
                .catch((e) => setError(e instanceof Error ? e.message : 'Could not load notifications.')),
        [],
    );
    const readBrowser = useCallback(async () => {
        const next = pushSupport();
        setSupport(next);
        if (next !== 'ready') {
            return;
        }
        const subscription = await currentSubscription().catch(() => null);
        setEndpoint(subscription?.endpoint ?? null);
    }, []);
    useEffect(() => {
        void load();
        void readBrowser();
    }, [load, readBrowser]);

    /** Saves one channel's change with the rest as they are. */
    const save = async (channel: string, change: Partial<ChannelPreference>) => {
        if (!answer) {
            return;
        }
        const all: NotificationPreferences = {
            // Kept for channels this server doesn't list right now.
            ...workspace.preferences?.notifications,
            ...Object.fromEntries(
                answer.channels.map((item) => [item.id, { enabled: item.enabled, content: item.content }]),
            ),
        };
        all[channel] = { ...all[channel]!, ...change };
        const previous = answer;
        setAnswer({
            ...answer,
            channels: answer.channels.map((item) => (item.id === channel ? { ...item, ...change } : item)),
        });
        setBusy(`save:${channel}`);
        if (await mutate('/preferences', 'PATCH', { notifications: all })) {
            toast.success('Notifications saved');
        } else {
            setAnswer(previous);
        }
        setBusy('');
    };

    const turnOn = async () => {
        if (!answer) {
            return;
        }
        setBusy('push:on');
        setPushError('');
        try {
            await subscribeHere(answer.pushKey);
            toast.success('Notifications on in this browser');
        } catch (e) {
            // The browser's errors are DOMExceptions ("Registration failed …").
            const message = (e as { message?: unknown } | null)?.message;
            setPushError(
                typeof message === 'string' && message ? message : 'Could not turn notifications on in this browser.',
            );
        }
        await readBrowser();
        await load();
        setBusy('');
    };

    const remove = async (id: string) => {
        setBusy(`remove:${id}`);
        try {
            await api(`/notifications/push/subscriptions/${encodeURIComponent(id)}`, 'DELETE');
            // This browser's own: stop its subscription too.
            if (storedTarget()?.id === id) {
                storeTarget(undefined);
                const subscription = await currentSubscription().catch(() => null);
                await subscription?.unsubscribe().catch(() => undefined);
                setEndpoint(null);
            }
            toast.success('Device removed');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove it.');
        }
        await load();
        setBusy('');
    };

    const test = async () => {
        setBusy('test');
        setTested(undefined);
        try {
            const result = await api<TestAnswer>('/notifications/test', 'POST', {});
            const label = (id: string) => answer?.channels.find((item) => item.id === id)?.label ?? id;
            const reached = result.channels.filter((report) => report.sent || report.failed);
            setTested(
                reached.length
                    ? `Sent to ${reached
                          .map((report) => reportLine(label(report.channel), report.sent, report.failed))
                          .join(' and ')}.`
                    : 'No channel is on, so nothing was sent. Turn one on above.',
            );
        } catch (e) {
            setTested(e instanceof Error ? e.message : 'Could not send the test notification.');
        }
        setBusy('');
    };

    if (!answer) {
        return (
            <SettingsCard>
                <section className="grid gap-2" data-slot="notifications">
                    <h3 className="font-medium">Notifications</h3>
                    {error ? (
                        <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                            {error}
                        </p>
                    ) : (
                        <p className="text-muted-foreground">Loading…</p>
                    )}
                </section>
            </SettingsCard>
        );
    }

    const mine = storedTarget();
    const pushOnHere = (channel: NotificationChannelView) =>
        !!endpoint && mine?.endpoint === endpoint && channel.targets.some((target) => target.id === mine.id);

    return (
        <>
            <SettingsCard>
                <section className="grid gap-2" data-slot="notifications-intro">
                    <h3 className="font-medium">Notifications</h3>
                    <p className="text-muted-foreground">
                        A socio can notify you when something needs you: unattended work that finished, a problem, a
                        decision only you can make. It goes to the channels you turn on here, and only while you aren’t
                        using Socio. While you are, it shows in the app instead.
                    </p>
                    {error && (
                        <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                            {error}
                        </p>
                    )}
                </section>
            </SettingsCard>
            {answer.channels.map((channel) => (
                <SettingsCard key={channel.id}>
                    <section className="grid gap-3" data-slot="notification-channel" data-channel={channel.id}>
                        <div className="flex items-center gap-3">
                            <h3 className="font-medium">{channel.label}</h3>
                            <label className="ml-auto flex items-center gap-2 text-muted-foreground">
                                {channel.enabled ? 'On' : 'Off'}
                                <Switch
                                    aria-label={`${channel.label} on`}
                                    checked={channel.enabled}
                                    disabled={!!busy}
                                    onCheckedChange={(enabled) => void save(channel.id, { enabled })}
                                />
                            </label>
                        </div>
                        <fieldset className="grid gap-2">
                            <legend className="mb-1 text-muted-foreground">What it shows</legend>
                            {CONTENT_CHOICES.map((choice) => (
                                <label key={choice.value} className="flex items-start gap-2">
                                    <input
                                        type="radio"
                                        name={`notification-content-${channel.id}`}
                                        data-slot="radio"
                                        className="mt-1"
                                        value={choice.value}
                                        checked={channel.content === choice.value}
                                        disabled={!!busy}
                                        onChange={() => void save(channel.id, { content: choice.value })}
                                    />
                                    <span>
                                        <span className="font-medium">{choice.label}</span>
                                        <span className="block text-muted-foreground">{choice.note}</span>
                                    </span>
                                </label>
                            ))}
                        </fieldset>
                        {channel.id === 'push' ? (
                            <PushDevices
                                channel={channel}
                                support={support}
                                onHere={pushOnHere(channel)}
                                busy={busy}
                                error={pushError}
                                onTurnOn={() => void turnOn()}
                                onRemove={(id) => void remove(id)}
                            />
                        ) : (
                            <Targets channel={channel} telegram={telegram} />
                        )}
                    </section>
                </SettingsCard>
            ))}
            <SettingsCard>
                <section className="grid gap-2" data-slot="notification-test">
                    <h3 className="font-medium">Test</h3>
                    <p className="text-muted-foreground">
                        Sends a test now to every channel that’s on, even while you’re here.
                    </p>
                    <div>
                        <Button variant="outline" disabled={!!busy} onClick={() => void test()}>
                            {busy === 'test' ? 'Sending…' : 'Send a test notification'}
                        </Button>
                    </div>
                    {tested && (
                        <p className="text-muted-foreground" data-slot="test-result">
                            {tested}
                        </p>
                    )}
                </section>
            </SettingsCard>
            <RoomNotificationsCard />
            <IssueSubscriptionsSection />
        </>
    );
}

/** Push's devices, each removable, and turning push on in this browser. */
function PushDevices({
    channel,
    support,
    onHere,
    busy,
    error,
    onTurnOn,
    onRemove,
}: {
    channel: NotificationChannelView;
    support: PushSupport | undefined;
    onHere: boolean;
    busy: string;
    error: string;
    onTurnOn: () => void;
    onRemove: (id: string) => void;
}) {
    return (
        <div className="grid gap-2" data-slot="push-devices">
            <h4 className="font-medium">Devices</h4>
            {channel.targets.length ? (
                <ul className="grid gap-2">
                    {channel.targets.map((target) => (
                        <li key={target.id} className="flex items-center gap-2" data-slot="push-device">
                            <span className="min-w-0 flex-1 truncate">{target.label}</span>
                            <Button
                                variant="outline"
                                size="sm"
                                aria-label={`Remove ${target.label}`}
                                disabled={!!busy}
                                onClick={() => onRemove(target.id)}
                            >
                                Remove
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : (
                channel.note && <p className="text-muted-foreground">{channel.note}</p>
            )}
            {support === undefined ? null : support !== 'ready' ? (
                <p
                    className="rounded-lg bg-muted p-3 text-muted-foreground"
                    data-slot="push-unavailable"
                    data-reason={support}
                >
                    {PUSH_MESSAGES[support]}
                </p>
            ) : onHere ? (
                <p className="text-muted-foreground" data-slot="push-here">
                    On in this browser.
                </p>
            ) : (
                <div>
                    <Button disabled={!!busy} onClick={onTurnOn}>
                        {busy === 'push:on' ? 'Turning on…' : 'Turn on for this browser'}
                    </Button>
                </div>
            )}
            {error && (
                <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert" data-slot="push-error">
                    {error}
                </p>
            )}
        </div>
    );
}

/** Another channel's targets, or why it reaches nowhere yet. */
function Targets({ channel, telegram }: { channel: NotificationChannelView; telegram: boolean }) {
    if (channel.targets.length) {
        return (
            <p className="text-muted-foreground">Goes to {channel.targets.map((target) => target.label).join(', ')}.</p>
        );
    }
    return (
        <p className="text-muted-foreground" data-slot="channel-note">
            {channel.note ?? 'It reaches nowhere yet.'}
            {channel.id === 'telegram' && telegram && (
                <>
                    {' '}
                    <Link to={settingsPath('telegram')} className="text-foreground underline underline-offset-4">
                        Telegram settings
                    </Link>
                </>
            )}
        </p>
    );
}
