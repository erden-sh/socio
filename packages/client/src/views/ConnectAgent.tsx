import { Bot, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';

import type { AgentConsentView } from '@socio/shared/agent-grants';

import { scopeLabel } from '../lib/agent-scopes';
import { api } from '../lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/** What the plugin adds to the authorization request when it signs it. */
const SIGNED_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'];

/**
 * The authorization request again, without the signature (CB-90): after
 * signing in, the browser starts it over, now as the person.
 */
export function restartAuthorization(search: string) {
    const params = new URLSearchParams(search);
    for (const name of SIGNED_PARAMS) {
        params.delete(name);
    }
    // Just signed in: a "login" prompt is satisfied.
    const prompt = (params.get('prompt') ?? '').split(' ').filter((value) => value && value !== 'login');
    if (prompt.length) {
        params.set('prompt', prompt.join(' '));
    } else {
        params.delete('prompt');
    }
    return `/api/auth/oauth2/authorize?${params}`;
}

/** An unavailable or policy-blocked client logo must not look like a broken page. */
function AgentLogo({ logo }: { logo: string | null }) {
    const [failed, setFailed] = useState(false);
    return logo && !failed ? (
        <img
            src={logo}
            alt=""
            referrerPolicy="no-referrer"
            className="size-10 shrink-0 rounded-md object-contain"
            onError={() => setFailed(true)}
        />
    ) : (
        <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
            data-slot="agent-logo-fallback"
        >
            <Bot className="size-6" />
        </span>
    );
}

/**
 * `/connect` (CB-90): an external agent asks to act for the signed-in
 * person. Shows the agent's name, logo and domain (or that it is an
 * unverified local app), what it may do, and who approves; Approve
 * records a grant with the person's label and sends the browser back to
 * the agent, Deny tells the agent no.
 */
export function ConnectAgent() {
    const location = useLocation();
    const query = location.search.replace(/^\?/, '');
    const [view, setView] = useState<AgentConsentView>();
    const [error, setError] = useState('');
    const [label, setLabel] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!query) {
            setError('Nothing to approve here. Connect from your agent.');
            return;
        }
        api<AgentConsentView>(`/agent-consent?query=${encodeURIComponent(query)}`)
            .then((answer) => {
                setView(answer);
                setLabel(answer.clientName);
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the request.'));
    }, [query]);
    const answer = async (accept: boolean) => {
        setBusy(true);
        try {
            const { url } = await api<{ url: string }>('/agent-consent', 'POST', {
                query,
                accept,
                ...(accept ? { label: label.trim() || view?.clientName } : {}),
            });
            globalThis.location.assign(url);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not answer the agent.');
            setBusy(false);
        }
    };
    return (
        <main className="main-content grid place-items-center" data-slot="connect-agent">
            <Card className="w-full max-w-lg">
                {error ? (
                    <>
                        <CardHeader>
                            <CardTitle>Connect an agent</CardTitle>
                            <CardDescription role="alert">{error}</CardDescription>
                        </CardHeader>
                    </>
                ) : !view ? (
                    <CardContent>
                        <Skeleton className="h-40" />
                    </CardContent>
                ) : (
                    <>
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <AgentLogo key={view.logoUri} logo={view.logoUri} />
                                <div className="grid gap-1">
                                    <CardTitle>{view.clientName} wants to act for you</CardTitle>
                                    {view.clientDomain ? (
                                        <span className="text-lg font-semibold" data-slot="agent-domain">
                                            {view.clientDomain}
                                        </span>
                                    ) : (
                                        <Badge variant="destructive" data-slot="agent-unverified">
                                            Unverified local app
                                        </Badge>
                                    )}
                                </div>
                            </div>
                            <CardDescription>
                                It will act as you, {view.personName}, in this workspace: never more than you can do,
                                and only what is listed here.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-4 text-sm">
                            {view.localApp && (
                                <p className="flex gap-2 rounded-md border border-dashed p-3">
                                    <ShieldAlert className="size-5 shrink-0" aria-hidden />
                                    <span>
                                        It runs on your computer and goes back to{' '}
                                        <code className="text-xs">{view.redirectUri}</code>. Any program there can claim
                                        to be {view.clientName} (its details come from {view.metadataHost}), so approve
                                        only if you just started connecting it yourself.
                                    </span>
                                </p>
                            )}
                            <div className="grid gap-1">
                                <span className="font-medium">It will be able to:</span>
                                <ul className="grid list-disc gap-1 pl-5" aria-label="What it may do">
                                    {view.scopes.map((scope) => (
                                        <li key={scope}>{scopeLabel(scope, view.scopeLabels)}</li>
                                    ))}
                                </ul>
                            </div>
                            <label className="grid gap-1">
                                <span className="font-medium">Name this connection</span>
                                <Input
                                    aria-label="Connection name"
                                    maxLength={80}
                                    value={label}
                                    placeholder={view.clientName}
                                    onChange={(e) => setLabel(e.target.value)}
                                />
                                <span className="text-muted-foreground">
                                    Shown on what it does, as “{label.trim() || view.clientName} for {view.personName}”,
                                    and under Account → Connected agents, where you can disconnect it.
                                </span>
                            </label>
                            {view.refusal && (
                                <p role="alert" className="text-destructive">
                                    {view.refusal}
                                </p>
                            )}
                        </CardContent>
                        <CardFooter className="flex justify-end gap-2">
                            <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
                                Deny
                            </Button>
                            <Button disabled={busy || !!view.refusal} onClick={() => void answer(true)}>
                                Approve
                            </Button>
                        </CardFooter>
                    </>
                )}
            </Card>
        </main>
    );
}

/**
 * `/connect/continue`: the agent's request reached the workspace before
 * the person signed in (the shell showed sign-in first). Signed in now, it
 * starts the request over, which leads to the consent screen.
 */
export function ContinueConnect() {
    const location = useLocation();
    useEffect(() => {
        globalThis.location.replace(restartAuthorization(location.search));
    }, [location.search]);
    return (
        <main className="main-content" data-slot="connect-continue">
            <p className="text-muted-foreground" role="status">
                Connecting your agent…
            </p>
        </main>
    );
}
