import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import type { SignInMethods } from '@socio/shared/auth';
import { DEFAULT_BRANDING, type Branding } from '@socio/shared/branding';
import { roleLabel } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';
import { SOCIAL_PROVIDER_NAMES } from '@socio/shared/web-social';
import type { SignInView } from '@socio/shared/web/web';

import { api } from '../lib/api';
import { useBrandingDocument } from '../lib/branding-meta';
import { Mascot } from '../locals/Mascot';
import { accounts, primary, unlock, unlockError } from '../views/unlock';

import {
    authSession,
    completeSignInLink,
    requestPasswordReset,
    requestSignInLink,
    setPasswordFromLink,
    useSignInError,
    signInWithPasskey,
    signInWithPassword,
    signInWithProvider,
    signUp,
    startWebSocial,
} from './auth-client';

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * The sign-in screen: the mock user picker in development, or the methods
 * Better Auth is configured with (passkey, email and password, providers,
 * sign-in links). `/reset-password?token=…` (an invite or reset link) sets
 * a password; `/sign-in-link?token=…` (a one-time link) signs in.
 */
export function SignIn({
    session,
    onSignedIn,
    onPasswordSet = () => globalThis.history.replaceState(null, '', '/'),
}: {
    /**
     * What the server offers, from the shell loader, so the server renders
     * the same screen. Without it (a session that ended while open), it is
     * asked for.
     */
    session?: SignInView;
    onSignedIn: () => void;
    /** Leaves the link's address (the app navigates to `/`). */
    onPasswordSet?: () => void;
}) {
    const { t, ready } = useTranslation(['shell.sign-in']);
    const [brand, setBrand] = useState(session?.branding ?? DEFAULT_BRANDING);
    useBrandingDocument(brand);
    const [fetched, setFetched] = useState<SignInMethods | null>();
    // What failed: shown as its message, or ours.
    const [failure, setFailure] = useState<{ error: unknown }>();
    const error = failure && message(failure.error, t('shell.sign-in:errors.unreachable'));
    const given = !!session;
    useEffect(() => {
        if (given) {
            return;
        }
        authSession()
            .then((found) => {
                setFetched(found.methods ?? null);
                setBrand(found.branding ?? DEFAULT_BRANDING);
            })
            .catch((e) => setFailure({ error: e }));
    }, [given]);
    const methods = session ? (session.methods ?? null) : fetched;
    // The router's location: the same on the server and in the browser.
    const location = useLocation();
    const query = new URLSearchParams(location.search);
    const [token, setToken] = useState(() => (location.pathname === '/reset-password' ? query.get('token') : null));
    const [notice, setNotice] = useState('');
    const linkToken = location.pathname === '/sign-in-link' ? query.get('token') : null;
    // Signed out in this tab, its words come before the loader's (or on
    // demand, for a session that ended): the screen waits for them.
    if (!ready) {
        return (
            <main className={unlock}>
                <Mascot state="working" />
            </main>
        );
    }
    if (linkToken) {
        return <SignInWithLink token={linkToken} />;
    }
    if (token) {
        return (
            <SetPassword
                token={token}
                onDone={() => {
                    onPasswordSet();
                    setToken(null);
                    setNotice(t('shell.sign-in:password-set'));
                }}
            />
        );
    }
    if (methods === null) {
        return <MockSignIn onSignedIn={onSignedIn} />;
    }
    if (!methods) {
        return (
            <main className={unlock}>
                <Mascot state="working" />
                {error && (
                    <p className={unlockError} role="alert">
                        {error}
                    </p>
                )}
            </main>
        );
    }
    return (
        <AccountSignIn brand={session?.branding ?? brand} methods={methods} onSignedIn={onSignedIn} notice={notice} />
    );
}

/** Development sign-in: pick one of the server's mock users. */
function MockSignIn({ onSignedIn }: { onSignedIn: () => void }) {
    const { t } = useTranslation(['shell.sign-in']);
    const [users, setUsers] = useState<User[]>();
    const [error, setError] = useState('');
    const [unloaded, setUnloaded] = useState<{ error: unknown }>();
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        api<User[]>('/auth/mock/users')
            .then(setUsers)
            .catch((e) => setUnloaded({ error: e }));
    }, []);
    const shown = error || (unloaded ? message(unloaded.error, t('shell.sign-in:errors.users')) : '');
    return (
        <main className={unlock}>
            <Mascot />
            <h1>{t('shell.sign-in:mock.title')}</h1>
            <p>{t('shell.sign-in:mock.choose')}</p>
            <div className={accounts}>
                {users?.map((user) => (
                    <button
                        key={user.id}
                        className={primary}
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true);
                            setError('');
                            setUnloaded(undefined);
                            try {
                                await api('/auth/mock/login', 'POST', { userId: user.id });
                                onSignedIn();
                            } catch (e) {
                                setError(message(e, t('shell.sign-in:errors.sign-in')));
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        {t('shell.sign-in:mock.continue', { name: user.name })}
                        <small>{roleLabel(user.role)}</small>
                    </button>
                ))}
            </div>
            {shown && (
                <p className={unlockError} role="alert">
                    {shown}
                </p>
            )}
            <p>{t('shell.sign-in:mock.warning')}</p>
        </main>
    );
}

/** Real sign-in: whichever of passkey, password and providers are on. */
function AccountSignIn({
    brand,
    methods,
    onSignedIn,
    notice: initialNotice = '',
}: {
    brand: Branding;
    methods: SignInMethods;
    onSignedIn: () => void;
    notice?: string;
}) {
    const { t } = useTranslation(['shell.sign-in']);
    const signInError = useSignInError();
    const location = useLocation();
    const navigate = useNavigate();
    const query = new URLSearchParams(location.search);
    const [error, setError] = useState(() => signInError(query.get('error'), query.get('error_description')));
    const [notice, setNotice] = useState(initialNotice);
    const [busy, setBusy] = useState(false);
    const [mode, setMode] = useState<'sign-in' | 'sign-up' | 'forgot' | 'link'>('sign-in');
    // The Socio app's sign-in sheet (`app=1`, CB-352): no sign-up there, and
    // no website Google or Apple sign-in either (the app has its own).
    const sheet = location.pathname === '/device/continue' && query.get('app') === '1';
    const offerSignUp = methods.signUp && !sheet;
    const social = sheet ? [] : (methods.social ?? []);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    // Drop ?error=… so a reload doesn't show it again (once, on arrival).
    const hasError = query.has('error');
    useEffect(() => {
        if (hasError) {
            // Only the error goes: the app's sheet keeps its request.
            const rest = new URLSearchParams(location.search);
            rest.delete('error');
            rest.delete('error_description');
            void navigate(`${location.pathname}${rest.size ? `?${rest}` : ''}`, { replace: true });
        }
        // Once, on arrival: later navigations carry no ?error to drop.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const run = async (action: () => Promise<unknown>, after = onSignedIn) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await action();
            after();
        } catch (e) {
            setError(message(e, t('shell.sign-in:errors.sign-in')));
        } finally {
            setBusy(false);
        }
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (mode === 'link') {
            void run(
                () => requestSignInLink(email),
                () => setNotice(t('shell.sign-in:link-sent')),
            );
        } else if (mode === 'forgot') {
            void run(
                () => requestPasswordReset(email),
                () => setNotice(t('shell.sign-in:reset-sent')),
            );
        } else if (mode === 'sign-up') {
            void run(() => signUp(name, email, password));
        } else {
            void run(() => signInWithPassword(email, password));
        }
    };
    return (
        <main className={unlock}>
            {brand.logo === DEFAULT_BRANDING.logo ? (
                <Mascot />
            ) : (
                <img src={brand.logo} alt="" className="size-32 object-contain" />
            )}
            <h1>{t('shell.sign-in:welcome')}</h1>
            <p>{t('shell.sign-in:sign-in-to', { name: brand.name })}</p>
            <div className={accounts}>
                {methods.passkey && mode === 'sign-in' && (
                    <button className={primary} disabled={busy} onClick={() => void run(signInWithPasskey)}>
                        {t('shell.sign-in:passkey')}
                    </button>
                )}
                {mode === 'sign-in' &&
                    social.map((provider) => (
                        <button
                            key={`social-${provider}`}
                            data-slot={`social-${provider}`}
                            disabled={busy}
                            onClick={() =>
                                void run(
                                    () => startWebSocial(provider, 'signin'),
                                    () => {},
                                )
                            }
                        >
                            {t('shell.sign-in:social', { name: SOCIAL_PROVIDER_NAMES[provider] })}
                        </button>
                    ))}
                {methods.providers.map((provider) => (
                    <button
                        key={provider.id}
                        disabled={busy}
                        onClick={() => void run(() => signInWithProvider(provider.id))}
                    >
                        {t('shell.sign-in:provider', { name: provider.name })}
                    </button>
                ))}
                {methods.signInLink && !methods.password && mode === 'sign-in' && (
                    <button disabled={busy} onClick={() => setMode('link')}>
                        {t('shell.sign-in:send-link')}
                    </button>
                )}
            </div>
            {(methods.password || mode === 'link') && (
                <form onSubmit={submit} aria-label={t('shell.sign-in:form')}>
                    {mode === 'sign-up' && (
                        <input
                            aria-label={t('shell.sign-in:name')}
                            placeholder={t('shell.sign-in:name-placeholder')}
                            autoComplete="name"
                            value={name}
                            maxLength={80}
                            required
                            onChange={(e) => setName(e.target.value)}
                        />
                    )}
                    <input
                        type="email"
                        aria-label={t('shell.sign-in:email')}
                        placeholder={t('shell.sign-in:email')}
                        autoComplete="username"
                        value={email}
                        required
                        onChange={(e) => setEmail(e.target.value)}
                    />
                    {mode !== 'forgot' && mode !== 'link' && (
                        <input
                            type="password"
                            aria-label={t('shell.sign-in:password')}
                            placeholder={t('shell.sign-in:password')}
                            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                            value={password}
                            minLength={mode === 'sign-up' ? 10 : undefined}
                            required
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    )}
                    <button className={primary} disabled={busy}>
                        {mode === 'forgot'
                            ? t('shell.sign-in:send-reset')
                            : mode === 'link'
                              ? t('shell.sign-in:send-link')
                              : mode === 'sign-up'
                                ? t('shell.sign-in:create-account')
                                : t('shell.sign-in:sign-in')}
                    </button>
                    {mode === 'sign-in' && methods.emailReset && (
                        <button type="button" onClick={() => setMode('forgot')}>
                            {t('shell.sign-in:forgot')}
                        </button>
                    )}
                    {mode === 'sign-in' && methods.signInLink && (
                        <button type="button" onClick={() => setMode('link')}>
                            {t('shell.sign-in:send-link')}
                        </button>
                    )}
                    {mode === 'sign-in' && offerSignUp && (
                        <button type="button" onClick={() => setMode('sign-up')}>
                            {t('shell.sign-in:sign-up')}
                        </button>
                    )}
                    {mode !== 'sign-in' && (
                        <button type="button" onClick={() => setMode('sign-in')}>
                            {t('shell.sign-in:back')}
                        </button>
                    )}
                </form>
            )}
            {notice && <p role="status">{notice}</p>}
            {error && (
                <p className={unlockError} role="alert">
                    {error}
                </p>
            )}
            {!methods.signUp && (
                <p>{methods.emailReset ? t('shell.sign-in:invite-only') : t('shell.sign-in:invite-only-reset')}</p>
            )}
        </main>
    );
}

/**
 * `/sign-in-link?token=…`, a one-time link from Telegram: one click signs
 * in. Opening the page alone doesn't, so a link preview or a scanner that
 * fetches it doesn't use the link up.
 */
function SignInWithLink({ token }: { token: string }) {
    const { t } = useTranslation(['shell.sign-in']);
    return (
        <main className={unlock}>
            <Mascot />
            <h1>{t('shell.sign-in:link.title')}</h1>
            <p>{t('shell.sign-in:link.once')}</p>
            <div className={accounts}>
                <button className={primary} onClick={() => completeSignInLink(token)}>
                    {t('shell.sign-in:link.continue')}
                </button>
            </div>
            <p>{t('shell.sign-in:link.unasked')}</p>
        </main>
    );
}

/** `/reset-password?token=…`: choose a password, then sign in with it. */
function SetPassword({ token, onDone }: { token: string; onDone: () => void }) {
    const { t } = useTranslation(['shell.sign-in']);
    const [password, setPassword] = useState('');
    const [repeat, setRepeat] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <main className={unlock}>
            <Mascot />
            <h1>{t('shell.sign-in:set-password.title')}</h1>
            <p>{t('shell.sign-in:set-password.rules')}</p>
            <form
                onSubmit={async (e) => {
                    e.preventDefault();
                    if (password !== repeat) {
                        return setError(t('shell.sign-in:set-password.differ'));
                    }
                    setBusy(true);
                    setError('');
                    try {
                        await setPasswordFromLink(token, password);
                        onDone();
                    } catch (e) {
                        setError(message(e, t('shell.sign-in:set-password.failed')));
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                <input
                    type="password"
                    aria-label={t('shell.sign-in:set-password.new')}
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
                <input
                    type="password"
                    aria-label={t('shell.sign-in:set-password.repeat')}
                    autoComplete="new-password"
                    required
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                />
                <button className={primary} disabled={busy}>
                    {t('shell.sign-in:set-password.submit')}
                </button>
            </form>
            {error && (
                <p className={unlockError} role="alert">
                    {error}
                </p>
            )}
        </main>
    );
}
