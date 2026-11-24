import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { renderSVG } from 'uqr';

import {
    pairAnswerSchema,
    pairConfirmAnswerSchema,
    pairStatusSchema,
    type PairAnswer,
    type PairStatus,
} from '@socio/shared/device-sign-in';

import { api } from '../lib/api';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/** How often the page asks whether a device claimed the code (the server ends a claim nobody polls). */
export const PAIR_POLL_MS = 1500;
const PLATFORMS: Record<string, string> = { ios: 'iPhone or iPad', android: 'Android phone' };

/** "4:59": what is left of the QR code. */
export const countdown = (ms: number) => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** The QR code's SVG, inlined as an image: nothing of it runs. */
export const qrImage = (link: string) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { border: 2 }))}`;

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const DENIED = 'That code didn’t match. Make a new QR code.';
/** A claim only moves forward: a late answer never takes it back. */
const RANK: Record<PairStatus['state'], number> = {
    unclaimed: 0,
    waiting: 1,
    allowed: 2,
    signed_in: 3,
    denied: 3,
    expired: 3,
};
const forward = (before: PairStatus | undefined, next: PairStatus) =>
    before && RANK[before.state] > RANK[next.state] ? before : next;
const SIGNED_IN_ANYWAY =
    'That device had already signed in before Not my device. If it isn’t yours, sign it out in Settings → Account now.';

/** Ends a QR code or its claim as the page goes away (no answer awaited). */
const denyOnLeave = (pairingId: string) =>
    void fetch(`/api/auth/device/pair/${encodeURIComponent(pairingId)}/deny`, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    }).catch(() => undefined);

type Ended = { kind: 'denied' | 'expired' | 'mismatch' | 'refused'; text: string };

/**
 * Add a device (CB-352, WA), from the account menu: a QR code for the
 * Socio app, blurred until Show, with its countdown and New code. When a
 * device claims it, the code goes and the page asks "Sign in on a new
 * device?" with the device's type and time; the person types the 6 digits
 * the device shows (the server made them; this page never learns them),
 * or says "Not my device". Three wrong tries end the claim. Leaving the
 * page ends the code. "Send me a link for the app" sends the workspace's
 * app link to the person's own channel.
 */
export function AddDeviceDialog({ onClose }: { onClose: () => void }) {
    const [pairing, setPairing] = useState<PairAnswer>();
    const [shown, setShown] = useState(false);
    const [status, setStatus] = useState<PairStatus>();
    const [ended, setEnded] = useState<Ended>();
    const [digits, setDigits] = useState('');
    const [busy, setBusy] = useState(false);
    const [triesLeft, setTriesLeft] = useState<number>();
    const [notice, setNotice] = useState('');
    const [now, setNow] = useState(() => Date.now());
    /** The code to deny on leaving: the last one made, until a new one is. */
    const current = useRef<string>(undefined);
    /** The code whose polls count; none while a new one is being made. */
    const live = useRef<string>(undefined);
    /** The latest mint: an older one's answer (already voided) is ended, not shown. */
    const minting = useRef(0);
    /** The dialog went: a code made after that is ended at once. */
    const closed = useRef(false);

    const mint = useCallback(async () => {
        const mine = ++minting.current;
        // The last code's polls stop counting at once; it stays the one to
        // deny on leaving until a new one is made.
        live.current = undefined;
        setPairing(undefined);
        setBusy(true);
        setShown(false);
        setStatus(undefined);
        setEnded(undefined);
        setDigits('');
        setTriesLeft(undefined);
        try {
            const answer = pairAnswerSchema.parse(await api('/auth/device/pair', 'POST', {}));
            if (closed.current || mine !== minting.current) {
                denyOnLeave(answer.pairingId);
                return;
            }
            current.current = answer.pairingId;
            live.current = answer.pairingId;
            setPairing(answer);
        } catch (e) {
            if (mine === minting.current) {
                setPairing(undefined);
                setEnded({ kind: 'refused', text: message(e, 'Could not make a QR code.') });
            }
        } finally {
            if (mine === minting.current) {
                setBusy(false);
            }
        }
    }, []);
    // Safe to run twice (React's StrictMode): the second mint wins.
    useEffect(() => {
        closed.current = false;
        void mint();
        return () => {
            closed.current = true;
        };
    }, [mint]);

    // Leaving the page (or this dialog) ends the code or its claim.
    useEffect(() => {
        const leave = () => current.current && denyOnLeave(current.current);
        window.addEventListener('pagehide', leave);
        return () => {
            window.removeEventListener('pagehide', leave);
            leave();
        };
    }, []);

    const state = status?.state;
    const done = !!ended || state === 'signed_in';
    useEffect(() => {
        if (!pairing || done) {
            return;
        }
        const tick = setInterval(() => setNow(Date.now()), 1000);
        // One poll at a time.
        let asking = false;
        const poll = setInterval(() => {
            if (asking) {
                return;
            }
            asking = true;
            api(`/auth/device/pair/${encodeURIComponent(pairing.pairingId)}`)
                .then((answer) => {
                    if (live.current !== pairing.pairingId) {
                        return;
                    }
                    const next = pairStatusSchema.parse(answer);
                    setStatus((before) => forward(before, next));
                    if (next.state === 'expired') {
                        setEnded({ kind: 'expired', text: 'This QR code expired. Make a new one.' });
                    } else if (next.state === 'denied') {
                        setEnded({ kind: 'denied', text: DENIED });
                    } else if (next.state === 'signed_in') {
                        current.current = undefined;
                    }
                })
                .catch(() => undefined)
                .finally(() => {
                    asking = false;
                });
        }, PAIR_POLL_MS);
        return () => {
            clearInterval(tick);
            clearInterval(poll);
        };
    }, [pairing, done]);

    const confirm = async () => {
        if (!pairing) {
            return;
        }
        setBusy(true);
        try {
            // Its own request: a wrong try answers 400 with the tries left.
            const response = await fetch(`/api/auth/device/pair/${encodeURIComponent(pairing.pairingId)}/confirm`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ digits }),
            });
            const body: unknown = await response.json().catch(() => null);
            const answer = pairConfirmAnswerSchema.safeParse(body);
            setNotice('');
            if (answer.success && answer.data.state === 'allowed') {
                setStatus((before) => (before ? { ...before, state: 'allowed' } : before));
            } else if (answer.success && answer.data.state === 'waiting' && answer.data.triesLeft > 0) {
                setTriesLeft(answer.data.triesLeft);
                setDigits('');
            } else if (answer.success && answer.data.state === 'denied') {
                current.current = undefined;
                setEnded({ kind: 'mismatch', text: DENIED });
            } else if ((body as { code?: string } | null)?.code === 'denied') {
                // Refused because the claim isn't waiting any more: it may have
                // been allowed (an earlier answer lost) or ended. The claim's
                // status says which.
                const now = pairStatusSchema.safeParse(
                    await api(`/auth/device/pair/${encodeURIComponent(pairing.pairingId)}`).catch(() => null),
                );
                if (now.success && (now.data.state === 'allowed' || now.data.state === 'signed_in')) {
                    setStatus(now.data);
                } else if (now.success && now.data.state !== 'waiting') {
                    current.current = undefined;
                    setEnded({ kind: 'mismatch', text: DENIED });
                } else {
                    setNotice('Could not check the code. Try again.');
                }
            } else {
                // No clear answer (too many tries for now, a server away):
                // the poll still says what became of the claim.
                setNotice((body as { error?: string } | null)?.error ?? 'Could not check the code. Try again.');
            }
        } catch {
            // The answer was lost: the poll says whether it went through.
            setNotice('Could not reach the server. Try again.');
        } finally {
            setBusy(false);
        }
    };
    const notMine = async () => {
        if (!pairing) {
            return;
        }
        setBusy(true);
        try {
            // Ended only once the server says so; until then the claim is
            // still followed, and still denied on leaving.
            await api(`/auth/device/pair/${encodeURIComponent(pairing.pairingId)}/deny`, 'POST', {});
            // A deny can't undo a sign-in that already happened (an earlier
            // answer lost): the claim's status says which it was.
            const after = pairStatusSchema.parse(
                await api(`/auth/device/pair/${encodeURIComponent(pairing.pairingId)}`),
            );
            current.current = undefined;
            live.current = undefined;
            if (after.state === 'signed_in') {
                setStatus((before) => forward(before, after));
                setNotice(SIGNED_IN_ANYWAY);
            } else {
                setEnded({ kind: 'denied', text: 'Nothing was signed in. That device can’t use this QR code.' });
            }
        } catch {
            setNotice('Could not end it yet. Choose Not my device again.');
        } finally {
            setBusy(false);
        }
    };
    const sendLink = async () => {
        try {
            const { via } = await api<{ via: string }>('/auth/device/send-link', 'POST', {});
            toast.success(`A link for the app is on its way by ${via === 'email' ? 'email' : 'Telegram'}`);
        } catch (e) {
            toast.error(message(e, 'Could not send the link.'));
        }
    };

    const device = status?.label || (status?.platform ? PLATFORMS[status.platform] : null) || 'a new device';
    const left = pairing ? Date.parse(pairing.expiresAt) - now : 0;
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="add-device" className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {state === 'signed_in'
                            ? `Signed in on ${device}`
                            : state === 'waiting' || state === 'allowed'
                              ? 'Sign in on a new device?'
                              : 'Add a device'}
                    </DialogTitle>
                    <DialogDescription>
                        {pairing?.variant === 'preview'
                            ? 'For the Socio Preview test app. '
                            : pairing?.variant === 'development'
                              ? 'For a development build of the Socio app. '
                              : ''}
                        Open the Socio app on your phone and scan this code with its camera, or with the phone’s camera.
                    </DialogDescription>
                </DialogHeader>
                {ended ? (
                    <div className="grid gap-3" data-slot="add-device-ended">
                        <p role="alert">{ended.text}</p>
                        <div>
                            <Button onClick={() => void mint()} disabled={busy}>
                                New code
                            </Button>
                        </div>
                    </div>
                ) : state === 'signed_in' ? (
                    <div className="grid gap-2" data-slot="add-device-done">
                        <p>{device} is signed in to your account. You can sign it out in Settings → Account.</p>
                        {notice === SIGNED_IN_ANYWAY && (
                            <p role="alert" className="text-destructive">
                                {notice}
                            </p>
                        )}
                    </div>
                ) : state === 'allowed' ? (
                    <p>Finishing on {device}…</p>
                ) : state === 'waiting' ? (
                    <form
                        className="grid gap-3"
                        data-slot="add-device-confirm"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void confirm();
                        }}
                    >
                        <p>
                            {device} wants to sign in as you
                            {status?.claimedAt
                                ? ` (${new Date(status.claimedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})`
                                : ''}
                            . Type the code shown on your new device.
                        </p>
                        <Input
                            aria-label="Code shown on your new device"
                            name="new-device-code"
                            inputMode="numeric"
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            required
                            value={digits}
                            onChange={(e) => setDigits(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        />
                        {notice && (
                            <p role="status" className="text-muted-foreground">
                                {notice}
                            </p>
                        )}
                        {triesLeft !== undefined && (
                            <p role="alert" className="text-destructive">
                                That code didn’t match. {triesLeft} {triesLeft === 1 ? 'try' : 'tries'} left.
                            </p>
                        )}
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="outline" disabled={busy} onClick={() => void notMine()}>
                                Not my device
                            </Button>
                            <Button type="submit" disabled={busy || digits.length !== 6}>
                                Sign in
                            </Button>
                        </div>
                    </form>
                ) : pairing ? (
                    <div className="grid justify-items-center gap-3" data-slot="add-device-qr">
                        <button
                            type="button"
                            className="relative overflow-hidden rounded-md border bg-white p-2"
                            onClick={() => setShown(true)}
                            aria-label={shown ? 'QR code for the Socio app' : 'Show the QR code'}
                        >
                            <img
                                src={qrImage(pairing.link)}
                                alt=""
                                className={shown ? 'size-56' : 'size-56 blur-md'}
                                data-slot="add-device-code"
                                data-shown={shown}
                            />
                            {!shown && (
                                <span className="absolute inset-0 grid place-items-center font-medium text-foreground">
                                    Show
                                </span>
                            )}
                        </button>
                        <p className="text-muted-foreground" data-slot="add-device-countdown">
                            Works once, for {countdown(left)}. Anyone who scans it can ask to sign in as you; you still
                            confirm on this page.
                        </p>
                        <Button variant="outline" disabled={busy} onClick={() => void mint()}>
                            New code
                        </Button>
                    </div>
                ) : (
                    <p className="text-muted-foreground">Making a QR code…</p>
                )}
                <div className="grid gap-2 border-t pt-3 text-sm">
                    <p className="text-muted-foreground">
                        No app yet? The Socio app is in a team beta until it reaches the app stores: ask your admin to
                        add you.
                    </p>
                    <div>
                        <Button variant="link" className="px-0" onClick={() => void sendLink()}>
                            Send me a link for the app
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
