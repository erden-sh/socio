import { useEffect, useState } from 'react';

import type { TelegramStatus } from '@socio/shared/types';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';

import { Button } from '@/components/ui/button';

interface LinkState {
    status: TelegramStatus;
    bot: string | null;
    linked: { username: string | null; linkedAt: number } | null;
}
export const telegramStatusText: Record<TelegramStatus, string> = {
    not_configured: 'not configured',
    connecting: 'connecting',
    online: 'online',
    failed: 'not connected',
};

/**
 * Settings → Account → Telegram: links the signed-in user's Telegram
 * account with a one-time t.me link.
 */
export function TelegramLink() {
    const [state, setState] = useState<LinkState>();
    const [link, setLink] = useState<{ url: string; expiresAt: number }>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const load = () =>
        api<LinkState>('/telegram/link')
            .then(setState)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 3000);
        return () => clearInterval(timer);
    }, []);
    useLiveTopic('telegram-link', load);
    const act = async (method: 'POST' | 'DELETE') => {
        setBusy(true);
        setError('');
        try {
            if (method === 'POST') {
                setLink(await api<{ url: string; expiresAt: number }>('/telegram/link', 'POST', {}));
            } else {
                await api('/telegram/link', 'DELETE', {});
                setLink(undefined);
            }
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not update the link.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="grid gap-2" data-slot="telegram-link">
            <h3 className="font-medium">Telegram</h3>
            {!state ? (
                <p className="text-muted-foreground">Loading…</p>
            ) : state.linked ? (
                <>
                    <p className="text-muted-foreground">
                        Linked
                        {state.linked.username ? ` as @${state.linked.username}` : ''}. Message{' '}
                        {state.bot ? `@${state.bot}` : 'the bot'} directly, or mention it in your team’s group.
                    </p>
                    <div>
                        <Button variant="outline" disabled={busy} onClick={() => void act('DELETE')}>
                            Unlink Telegram
                        </Button>
                    </div>
                </>
            ) : state.status !== 'online' ? (
                <p className="text-muted-foreground">Telegram is {telegramStatusText[state.status]} on this server.</p>
            ) : link && link.expiresAt > Date.now() ? (
                <>
                    <p className="text-muted-foreground">
                        Open this link in Telegram and press Start. It works once and expires in 10 minutes.
                    </p>
                    <div>
                        <Button asChild>
                            <a href={link.url} target="_blank" rel="noreferrer">
                                Open @{state.bot} in Telegram
                            </a>
                        </Button>
                    </div>
                </>
            ) : (
                <>
                    <p className="text-muted-foreground">Talk to your socios from Telegram: link your account once.</p>
                    <div>
                        <Button disabled={busy} onClick={() => void act('POST')}>
                            Link Telegram
                        </Button>
                    </div>
                </>
            )}
            {error && (
                <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
