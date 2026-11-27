import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { ByoConnectStep, UserInferenceKind, UserInferenceState } from '@socio/shared/inference';

import { api } from '../../lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const STATE_KEYS = {
    connected: 'settings.inference:state.connected',
    pending: 'settings.inference:state.pending',
    expired: 'settings.inference:state.expired',
    error: 'settings.inference:state.error',
    disconnected: 'settings.inference:state.disconnected',
} as const satisfies Record<UserInferenceKind['state'], string>;

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/**
 * Settings → Account → Inference: the subscriptions an
 * operator lets users connect (ChatGPT among them), with Connect,
 * Disconnect and status, and what the user's chats run on now. Tokens stay
 * on the server; a device-code login shows its code here and is polled
 * until it connects.
 */
export function InferenceSection() {
    const { t } = useTranslation(['settings.inference']);
    const [state, setState] = useState<UserInferenceState>();
    const [step, setStep] = useState<{ kind: string } & ByoConnectStep>();
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const load = useCallback(
        () =>
            api<UserInferenceState>('/me/inference')
                .then(setState)
                .catch((e) => failed(e, t('settings.inference:loadFailed'))),
        [t],
    );
    useEffect(() => {
        void load();
        return () => clearTimeout(timer.current);
    }, [load]);
    const advance = async (kind: string, body: unknown = {}) => {
        clearTimeout(timer.current);
        try {
            const next = await api<ByoConnectStep>(`/me/inference/${encodeURIComponent(kind)}/connect`, 'POST', body);
            if (next.state === 'pending') {
                setStep({ kind, ...next });
                timer.current = setTimeout(() => void advance(kind), Math.max(next.pollMs ?? 3000, 500));
            } else {
                setStep(undefined);
                if (next.state === 'connected') {
                    toast.success(t('settings.inference:connected'));
                } else if (next.message) {
                    toast.error(next.message);
                }
            }
        } catch (e) {
            setStep(undefined);
            failed(e, t('settings.inference:connectFailed'));
        }
        await load();
    };
    const disconnect = async (kind: string) => {
        try {
            await api(`/me/inference/${encodeURIComponent(kind)}`, 'DELETE');
            toast.success(t('settings.inference:disconnected'));
        } catch (e) {
            failed(e, t('settings.inference:disconnectFailed'));
        }
        await load();
    };
    return (
        <section className="grid gap-2" data-slot="inference-section">
            <h3 className="font-medium">{t('settings.inference:title')}</h3>
            <p className="text-muted-foreground">
                {!state
                    ? t('settings.inference:loading')
                    : state.active
                      ? t('settings.inference:active', {
                            context: state.active.source === 'byo' ? 'byo' : undefined,
                            model: state.active.label,
                        })
                      : t('settings.inference:noModel')}
            </p>
            {state && !state.kinds.length && (
                <p className="text-muted-foreground">
                    {t('settings.inference:noKinds', { context: state.active ? undefined : 'noModel' })}
                </p>
            )}
            <ul className="grid gap-2" aria-label={t('settings.inference:list')}>
                {state?.kinds.map((kind) => {
                    const pending = step?.kind === kind.id ? step : undefined;
                    return (
                        <li key={kind.id} data-kind={kind.id} className="grid gap-2 rounded-md border p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{kind.label}</span>
                                <Badge variant={kind.state === 'connected' ? 'default' : 'outline'}>
                                    {t(STATE_KEYS[kind.state])}
                                </Badge>
                                <span className="ml-auto flex gap-2">
                                    {kind.state === 'connected' ||
                                    kind.state === 'expired' ||
                                    kind.state === 'error' ? (
                                        <Button variant="outline" size="sm" onClick={() => void disconnect(kind.id)}>
                                            {t('settings.inference:disconnect')}
                                        </Button>
                                    ) : null}
                                    {kind.state !== 'connected' && !pending && (
                                        <Button size="sm" onClick={() => void advance(kind.id)}>
                                            {t('settings.inference:connect')}
                                        </Button>
                                    )}
                                    {pending && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => void advance(kind.id, { cancel: true })}
                                        >
                                            {t('settings.inference:cancel')}
                                        </Button>
                                    )}
                                </span>
                            </div>
                            <p className="text-muted-foreground">
                                {pending ? kind.description : (kind.detail ?? kind.description)}
                            </p>
                            {pending && (
                                <div role="status" className="grid gap-1 rounded-md bg-muted px-3 py-2">
                                    {pending.message && <span>{pending.message}</span>}
                                    {pending.userCode && (
                                        <span>
                                            {t('settings.inference:code')}{' '}
                                            <code className="font-mono font-semibold tracking-wider">
                                                {pending.userCode}
                                            </code>
                                        </span>
                                    )}
                                    {pending.verificationUrl && (
                                        <a
                                            href={pending.verificationUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-primary underline-offset-4 hover:underline"
                                        >
                                            {t('settings.inference:openSignIn')}
                                        </a>
                                    )}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
