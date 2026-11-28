import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { renderSVG } from 'uqr';

import { useTranslation } from '@socio/i18n/react';
import {
    PAIR_CLAIM_MS,
    pairAnswerSchema,
    pairConfirmAnswerSchema,
    pairStatusSchema,
    type PairAnswer,
    type PairStatus,
} from '@socio/shared/device-sign-in';

import { onDemand } from '../i18n/on-demand';
import { api } from '../lib/api';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
    InputOTP,
    InputOTPGroup,
    InputOTPSeparator,
    InputOTPSlot,
    pasteDigits,
    REGEXP_ONLY_DIGITS,
} from '@/components/ui/input-otp';

/** How often the page asks whether a device claimed the code (the server ends a claim nobody polls). */
export const PAIR_POLL_MS = 1500;

/** "4:59": what is left of the QR code, or of a claim. */
export const countdown = (ms: number) => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** The QR code's SVG, inlined as an image: nothing of it runs. */
export const qrImage = (link: string) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { border: 2 }))}`;

/** A platform the page has words for (`shell.add-device:platforms`). */
type Platform = 'ios' | 'android';
const knownPlatform = (platform: string | null | undefined): platform is Platform =>
    platform === 'ios' || platform === 'android';

/** The claiming device: a name from its label, or its platform. */
export type ClaimingDevice = { name: string; quoted: boolean } | { platform: Platform | 'other' };

/**
 * The claiming device as the page names it: "iPhone" from the app's own
 * "Socio app on iPhone", another label as it came (`quoted`), or the
 * platform. Only what the claim carries. The device set its label itself
 * and isn't signed in, so the page never vouches for it.
 */
export const claimingDevice = (status: PairStatus | undefined): ClaimingDevice | undefined => {
    const label = status?.label?.trim();
    const app = label?.match(/^Socio app on (.+)$/)?.[1];
    if (app) {
        return app === 'Android' ? { platform: 'android' } : { name: app, quoted: false };
    }
    if (label) {
        return { name: label, quoted: true };
    }
    if (!status?.platform) {
        return undefined;
    }
    return { platform: knownPlatform(status.platform) ? status.platform : 'other' };
};

/** "An iPhone", "A device called “Pixel 9”", "A new device": who is asking, never "your". */
export function useAskingDevice() {
    const { t } = useTranslation(['shell.add-device']);
    return (claiming: ClaimingDevice | undefined) =>
        !claiming
            ? t('shell.add-device:asking.new')
            : 'platform' in claiming
              ? t(`shell.add-device:asking.${claiming.platform}`)
              : claiming.quoted
                ? t('shell.add-device:asking.quoted', { name: claiming.name })
                : t('shell.add-device:asking.named', {
                      name: claiming.name,
                      context: /^[aeiou]/i.test(claiming.name) ? 'vowel' : undefined,
                  });
}

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
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

/** Ends a QR code or its claim as the page goes away (no answer awaited). */
const denyOnLeave = (pairingId: string) =>
    void fetch(`/api/auth/device/pair/${encodeURIComponent(pairingId)}/deny`, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    }).catch(() => undefined);

/**
 * How the request ended: `refused` with the server's words when it gave
 * some, `denied` by the person or by the device's answer (`mine`).
 */
type Ended = { kind: 'denied' | 'expired' | 'mismatch' | 'refused'; mine?: boolean; error?: unknown };

/** A line under the code: one of ours (its key in `shell.add-device:notices`), or the server's words. */
type Notice = '' | 'signed-in-anyway' | 'check-failed' | 'unreachable' | 'end-failed' | { said: string };

/**
 * Add a device (CB-352, WA), from the account menu: a QR code for the
 * Socio app, blurred until Show, with its countdown and New code. When a
 * device claims it, the code goes and the page asks to "Sign in your
 * iPhone", naming the device and the claim's time left (CB-567); the person
 * types the 6 digits the device shows (the server made them; this page never
 * learns them; the 6th digit, typed or pasted, sends them), or says "Not my
 * device". Three wrong tries end the claim. Leaving the page ends the code.
 * "Send me a link for the app", until a device claims the code, sends the
 * workspace's app link to the person's own channel.
 */
export const AddDeviceDialog = onDemand(
    ['shell.add-device'],
    function AddDeviceDialog({ onClose }: { onClose: () => void }) {
        const { t } = useTranslation(['shell.add-device']);
        const askingDevice = useAskingDevice();
        const [pairing, setPairing] = useState<PairAnswer>();
        const [shown, setShown] = useState(false);
        const [status, setStatus] = useState<PairStatus>();
        const [ended, setEnded] = useState<Ended>();
        const [digits, setDigits] = useState('');
        const [busy, setBusy] = useState(false);
        /** The last code didn't match: with the tries left when the server said. */
        const [wrong, setWrong] = useState<{ triesLeft?: number }>();
        const [notice, setNotice] = useState<Notice>('');
        const [now, setNow] = useState(() => Date.now());
        /** The code to deny on leaving: the last one made, until a new one is. */
        const current = useRef<string>(undefined);
        /** The code whose polls count; none while a new one is being made. */
        const live = useRef<string>(undefined);
        /** The latest mint: an older one's answer (already voided) is ended, not shown. */
        const minting = useRef(0);
        /** The dialog went: a code made after that is ended at once. */
        const closed = useRef(false);
        /** A confirm is on its way: a second (another 6th digit, or Enter) is dropped. */
        const confirming = useRef(false);
        const field = useRef<HTMLInputElement>(null);
        /** A confirm ended: the field, enabled again, takes the focus back. */
        const refocus = useRef(false);
        useEffect(() => {
            if (!busy && refocus.current) {
                refocus.current = false;
                field.current?.focus();
            }
        }, [busy]);

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
            setWrong(undefined);
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
                    setEnded({ kind: 'refused', error: e });
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
                            setEnded({ kind: 'expired' });
                        } else if (next.state === 'denied') {
                            setEnded({ kind: 'denied' });
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

        const confirm = async (digits: string) => {
            if (!pairing || confirming.current) {
                return;
            }
            confirming.current = true;
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
                setWrong(undefined);
                // Anything but a sign-in empties the field for the next try.
                setDigits('');
                const said = body as { state?: unknown; triesLeft?: unknown } | null;
                if (answer.success && answer.data.state === 'allowed') {
                    setStatus((before) => (before ? { ...before, state: 'allowed' } : before));
                } else if (response.status === 400 && said?.state === 'waiting') {
                    // A wrong code: the count only as the server gave it.
                    const count = typeof said.triesLeft === 'number' && said.triesLeft > 0 ? said.triesLeft : undefined;
                    setWrong(count === undefined ? {} : { triesLeft: count });
                } else if (answer.success && answer.data.state === 'denied') {
                    current.current = undefined;
                    setEnded({ kind: 'mismatch' });
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
                        setEnded({ kind: 'mismatch' });
                    } else {
                        setNotice('check-failed');
                    }
                } else {
                    // No clear answer (too many tries for now, a server away):
                    // the poll still says what became of the claim.
                    const said = (body as { error?: string } | null)?.error;
                    setNotice(said === undefined ? 'check-failed' : { said });
                }
            } catch {
                // The answer was lost: the poll says whether it went through.
                setNotice('unreachable');
                setDigits('');
            } finally {
                confirming.current = false;
                // The field is disabled on the way: back in it for the next try, if it stays.
                refocus.current = true;
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
                    setNotice('signed-in-anyway');
                } else {
                    setEnded({ kind: 'denied', mine: true });
                }
            } catch {
                setNotice('end-failed');
            } finally {
                setBusy(false);
            }
        };
        const sendLink = async () => {
            try {
                const { via } = await api<{ via: string }>('/auth/device/send-link', 'POST', {});
                toast.success(t('shell.add-device:link-sent', { context: via === 'email' ? 'email' : 'telegram' }));
            } catch (e) {
                toast.error(message(e, t('shell.add-device:errors.link')));
            }
        };

        const device =
            status?.label ||
            (knownPlatform(status?.platform) ? t(`shell.add-device:platforms.${status.platform}`) : null) ||
            t('shell.add-device:platforms.new');
        const endedText =
            ended &&
            (ended.kind === 'refused'
                ? message(ended.error, t('shell.add-device:ended.refused'))
                : ended.kind === 'expired'
                  ? t('shell.add-device:ended.expired')
                  : ended.mine
                    ? t('shell.add-device:ended.not-mine')
                    : t('shell.add-device:ended.denied'));
        const noticeText =
            typeof notice === 'object' ? notice.said : notice ? t(`shell.add-device:notices.${notice}`) : '';
        const left = pairing ? Date.parse(pairing.expiresAt) - now : 0;
        // The claim lives PAIR_CLAIM_MS from its claimedAt (both the server's).
        const claimLeft = status?.claimedAt ? Date.parse(status.claimedAt) + PAIR_CLAIM_MS - now : undefined;
        /** A device has claimed the code: it has the app, so the footer about getting one goes. */
        const claimed = !!status?.claimedAt || state === 'waiting' || state === 'allowed' || state === 'signed_in';
        /** Which view shows: only the QR code's (or the wait for one) keeps the scan instruction. */
        const view = ended
            ? 'ended'
            : state === 'signed_in' || state === 'allowed' || state === 'waiting'
              ? state
              : 'scan';
        return (
            <Dialog open onOpenChange={(open) => !open && onClose()}>
                <DialogContent data-slot="add-device" className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {view === 'scan' || view === 'ended'
                                ? t('shell.add-device:title')
                                : t('shell.add-device:title-claimed')}
                        </DialogTitle>
                        {view === 'waiting' ? (
                            <DialogDescription>
                                {t('shell.add-device:waiting', { device: askingDevice(claimingDevice(status)) })}
                            </DialogDescription>
                        ) : view === 'allowed' ? (
                            <DialogDescription>{t('shell.add-device:allowed')}</DialogDescription>
                        ) : view === 'signed_in' ? (
                            <DialogDescription>{t('shell.add-device:signed-in')}</DialogDescription>
                        ) : view === 'ended' ? (
                            <DialogDescription>{t('shell.add-device:ended.description')}</DialogDescription>
                        ) : (
                            <DialogDescription>
                                {t('shell.add-device:scan', {
                                    context:
                                        pairing?.variant === 'preview' || pairing?.variant === 'development'
                                            ? pairing.variant
                                            : undefined,
                                })}
                            </DialogDescription>
                        )}
                    </DialogHeader>
                    {ended ? (
                        <div className="grid gap-3" data-slot="add-device-ended">
                            <p role="alert">{endedText}</p>
                            <div>
                                <Button onClick={() => void mint()} disabled={busy}>
                                    {t('shell.add-device:new-code')}
                                </Button>
                            </div>
                        </div>
                    ) : state === 'signed_in' ? (
                        <div className="grid gap-2" data-slot="add-device-done">
                            <p>{t('shell.add-device:done', { device })}</p>
                            {notice === 'signed-in-anyway' && (
                                <p role="alert" className="text-destructive">
                                    {noticeText}
                                </p>
                            )}
                        </div>
                    ) : state === 'allowed' ? (
                        <p>{t('shell.add-device:finishing', { device })}</p>
                    ) : state === 'waiting' ? (
                        <form
                            className="grid gap-3"
                            data-slot="add-device-confirm"
                            onSubmit={(e) => {
                                e.preventDefault();
                                if (digits.length === 6) {
                                    void confirm(digits);
                                }
                            }}
                        >
                            <InputOTP
                                ref={field}
                                aria-label={t('shell.add-device:code.label')}
                                aria-describedby="add-device-code-hint"
                                name="new-device-code"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                data-1p-ignore
                                data-lpignore="true"
                                maxLength={6}
                                pattern={REGEXP_ONLY_DIGITS}
                                // A pasted "123 456" or "123-456" keeps its digits.
                                pasteTransformer={pasteDigits}
                                containerClassName="justify-center"
                                autoFocus
                                disabled={busy}
                                required
                                value={digits}
                                onChange={(next) => {
                                    setDigits(next);
                                    // The 6th digit, typed or pasted, sends it; confirm() takes one at a time.
                                    if (next.length === 6 && next !== digits) {
                                        void confirm(next);
                                    }
                                }}
                            >
                                <InputOTPGroup>
                                    <InputOTPSlot index={0} />
                                    <InputOTPSlot index={1} />
                                    <InputOTPSlot index={2} />
                                </InputOTPGroup>
                                <InputOTPSeparator />
                                <InputOTPGroup>
                                    <InputOTPSlot index={3} />
                                    <InputOTPSlot index={4} />
                                    <InputOTPSlot index={5} />
                                </InputOTPGroup>
                            </InputOTP>
                            <p id="add-device-code-hint" className="text-sm text-muted-foreground">
                                {t('shell.add-device:code.hint')}
                                {claimLeft !== undefined && (
                                    <span data-slot="add-device-claim-countdown">
                                        {' '}
                                        {t('shell.add-device:code.time-left', { left: countdown(claimLeft) })}
                                    </span>
                                )}
                            </p>
                            {noticeText && (
                                <p role="status" className="text-muted-foreground">
                                    {noticeText}
                                </p>
                            )}
                            {wrong && (
                                <p role="alert" className="text-destructive">
                                    {wrong.triesLeft === undefined
                                        ? t('shell.add-device:code.wrong')
                                        : t('shell.add-device:code.wrong-tries', { count: wrong.triesLeft })}
                                </p>
                            )}
                            <div className="flex justify-end gap-2">
                                <Button type="button" variant="outline" disabled={busy} onClick={() => void notMine()}>
                                    {t('shell.add-device:not-mine')}
                                </Button>
                            </div>
                        </form>
                    ) : pairing ? (
                        <div className="grid justify-items-center gap-3" data-slot="add-device-qr">
                            <button
                                type="button"
                                className="relative overflow-hidden rounded-md border bg-white p-2"
                                onClick={() => setShown(true)}
                                aria-label={shown ? t('shell.add-device:qr.code') : t('shell.add-device:qr.show')}
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
                                        {t('shell.add-device:qr.show-short')}
                                    </span>
                                )}
                            </button>
                            <p className="text-muted-foreground" data-slot="add-device-countdown">
                                {t('shell.add-device:qr.works-once', { left: countdown(left) })}
                            </p>
                            <Button variant="outline" disabled={busy} onClick={() => void mint()}>
                                {t('shell.add-device:new-code')}
                            </Button>
                        </div>
                    ) : (
                        <p className="text-muted-foreground">{t('shell.add-device:qr.making')}</p>
                    )}
                    {!claimed && (
                        <div className="grid gap-2 border-t pt-3 text-sm" data-slot="add-device-no-app">
                            <p className="text-muted-foreground">{t('shell.add-device:no-app')}</p>
                            <div>
                                <Button variant="link" className="px-0" onClick={() => void sendLink()}>
                                    {t('shell.add-device:send-link')}
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        );
    },
);
