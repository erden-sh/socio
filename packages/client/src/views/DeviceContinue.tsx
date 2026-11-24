import { Smartphone } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';
import { useLocation } from 'react-router';

import { deviceApproveAnswerSchema } from '@socio/shared/device-sign-in';

import { api, ApiError } from '../lib/api';
import { CurrentUser } from '../shell/current-user';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

const PLATFORM_NAMES: Record<string, string> = { ios: 'iPhone', android: 'Android' };

/** "Sign in to the Socio app on iPhone?": the sheet's platform, or none. */
export const deviceContinueTitle = (platform: string | null) =>
    `Sign in to the Socio app${platform && PLATFORM_NAMES[platform] ? ` on ${PLATFORM_NAMES[platform]}` : ''}?`;

/**
 * `/device/continue?request=…` (CB-352, WC): the Socio app's sign-in sheet
 * landed here, signed in (the shell showed sign-in first, without sign-up).
 * It names the account and waits for a click: never automatic, so a page
 * some other app opened in this browser signs nothing in. Continue
 * approves through a same-origin request and goes where the server says
 * (the app's callback on the link domain); Cancel approves nothing.
 */
export function DeviceContinue() {
    const location = useLocation();
    const query = new URLSearchParams(location.search);
    const request = query.get('request');
    const platform = query.get('platform');
    const [account, setAccount] = useState<{ name: string; email: string; session: string }>();
    // The shell's user: another sign-in in this browser changes it, and the
    // account shown is asked for again.
    const userId = useContext(CurrentUser)?.id;
    const [lookup, setLookup] = useState<'loading' | 'failed' | 'done'>('loading');
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<'asking' | 'busy' | 'cancelled'>('asking');
    const [error, setError] = useState(request ? '' : 'Nothing to sign in here. Start again in the Socio app.');
    // Who would be signed in, before Continue can be pressed.
    useEffect(() => {
        setLookup('loading');
        setAccount(undefined);
        api<{ user?: { name?: string; email?: string }; session?: { id?: string } } | null>('/auth/get-session')
            .then((found) => {
                if (!found?.user?.email || !found.session?.id) {
                    throw new Error('No account');
                }
                setAccount({ name: found.user.name ?? '', email: found.user.email, session: found.session.id });
                setLookup('done');
            })
            .catch(() => setLookup('failed'));
    }, [attempt, userId]);
    const approve = async () => {
        setState('busy');
        setError('');
        try {
            const answer = deviceApproveAnswerSchema.parse(
                await api('/auth/device/approve', 'POST', { request, session: account?.session }),
            );
            globalThis.location.replace(answer.redirect);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not sign in the app. Start again in the app.');
            setState('asking');
            // Signed in again since (another tab): show who it is now, and
            // wait for another click.
            if (e instanceof ApiError && e.code === 'not_authorized') {
                setAttempt((n) => n + 1);
            }
        }
    };
    return (
        <main className="main-content grid place-items-center" data-slot="device-continue">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <div className="flex items-center gap-3">
                        <Smartphone className="size-8 shrink-0" aria-hidden />
                        <CardTitle>
                            {state === 'cancelled' ? 'The Socio app was not signed in' : deviceContinueTitle(platform)}
                        </CardTitle>
                    </div>
                    {state !== 'cancelled' && account && (
                        <CardDescription data-slot="device-continue-account">
                            As {account.name}
                            {account.email ? ` (${account.email})` : ''}. Continue only if you just started signing in
                            from the app yourself.
                        </CardDescription>
                    )}
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                    {state === 'cancelled' && <p>Close this window to go back to the app.</p>}
                    {state !== 'cancelled' && lookup === 'failed' && (
                        <p role="alert" className="text-destructive">
                            Could not check which account this is.{' '}
                            <Button variant="link" className="h-auto p-0" onClick={() => setAttempt((n) => n + 1)}>
                                Try again
                            </Button>
                        </p>
                    )}
                    {error && (
                        <p role="alert" className="text-destructive">
                            {error}
                        </p>
                    )}
                </CardContent>
                {state !== 'cancelled' && request && (
                    <CardFooter className="flex justify-end gap-2">
                        <Button variant="outline" disabled={state === 'busy'} onClick={() => setState('cancelled')}>
                            Cancel
                        </Button>
                        <Button disabled={state === 'busy' || lookup !== 'done'} onClick={() => void approve()}>
                            Continue
                        </Button>
                    </CardFooter>
                )}
            </Card>
        </main>
    );
}
