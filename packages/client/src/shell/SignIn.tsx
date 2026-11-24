import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

import type { SignInMethods } from '@socio/shared/auth';
import { DEFAULT_BRANDING, type Branding } from '@socio/shared/branding';
import { roleLabel } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';
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
    signInError,
    signInWithPasskey,
    signInWithPassword,
    signInWithProvider,
    signUp,
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
    const [brand, setBrand] = useState(session?.branding ?? DEFAULT_BRANDING);
    useBrandingDocument(brand);
    const [fetched, setFetched] = useState<SignInMethods | null>();
    const [error, setError] = useState('');
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
            .catch((e) => setError(message(e, 'Could not reach the server.')));
    }, [given]);
    const methods = session ? (session.methods ?? null) : fetched;
    // The router's location: the same on the server and in the browser.
    const location = useLocation();
    const query = new URLSearchParams(location.search);
    const [token, setToken] = useState(() => (location.pathname === '/reset-password' ? query.get('token') : null));
    const [notice, setNotice] = useState('');
    const linkToken = location.pathname === '/sign-in-link' ? query.get('token') : null;
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
                    setNotice('Password set. Sign in with it.');
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
    const [users, setUsers] = useState<User[]>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        api<User[]>('/auth/mock/users')
            .then(setUsers)
            .catch((e) => setError(message(e, 'Could not load users.')));
    }, []);
    return (
        <main className={unlock}>
            <Mascot />
            <h1>Who’s thinking today?</h1>
            <p>Choose your account to continue.</p>
            <div className={accounts}>
                {users?.map((user) => (
                    <button
                        key={user.id}
                        className={primary}
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true);
                            setError('');
                            try {
                                await api('/auth/mock/login', 'POST', { userId: user.id });
                                onSignedIn();
                            } catch (e) {
                                setError(message(e, 'Could not sign in.'));
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        Continue as {user.name}
                        <small>{roleLabel(user.role)}</small>
                    </button>
                ))}
            </div>
            {error && (
                <p className={unlockError} role="alert">
                    {error}
                </p>
            )}
            <p>Development sign-in. Anyone who can reach this server can choose any account.</p>
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
    const location = useLocation();
    const navigate = useNavigate();
    const query = new URLSearchParams(location.search);
    const [error, setError] = useState(signInError(query.get('error'), query.get('error_description')));
    const [notice, setNotice] = useState(initialNotice);
    const [busy, setBusy] = useState(false);
    const [mode, setMode] = useState<'sign-in' | 'sign-up' | 'forgot' | 'link'>('sign-in');
    // The Socio app's sign-in sheet (`app=1`, CB-352): no sign-up there.
    const offerSignUp = methods.signUp && !(location.pathname === '/device/continue' && query.get('app') === '1');
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
            setError(message(e, 'Could not sign in.'));
        } finally {
            setBusy(false);
        }
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (mode === 'link') {
            void run(
                () => requestSignInLink(email),
                () => setNotice('If that account can receive links, one is on its way. Check your Telegram.'),
            );
        } else if (mode === 'forgot') {
            void run(
                () => requestPasswordReset(email),
                () => setNotice('If that address has an account, a link to set a new password is on its way.'),
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
            <h1>Welcome back.</h1>
            <p>Sign in to {brand.name}.</p>
            <div className={accounts}>
                {methods.passkey && mode === 'sign-in' && (
                    <button className={primary} disabled={busy} onClick={() => void run(signInWithPasskey)}>
                        Sign in with a passkey
                    </button>
                )}
                {methods.providers.map((provider) => (
                    <button
                        key={provider.id}
                        disabled={busy}
                        onClick={() => void run(() => signInWithProvider(provider.id))}
                    >
                        Sign in with {provider.name}
                    </button>
                ))}
                {methods.signInLink && !methods.password && mode === 'sign-in' && (
                    <button disabled={busy} onClick={() => setMode('link')}>
                        Send me a sign-in link
                    </button>
                )}
            </div>
            {(methods.password || mode === 'link') && (
                <form onSubmit={submit} aria-label="Sign in with email">
                    {mode === 'sign-up' && (
                        <input
                            aria-label="Name"
                            placeholder="Your name"
                            autoComplete="name"
                            value={name}
                            maxLength={80}
                            required
                            onChange={(e) => setName(e.target.value)}
                        />
                    )}
                    <input
                        type="email"
                        aria-label="Email"
                        placeholder="Email"
                        autoComplete="username"
                        value={email}
                        required
                        onChange={(e) => setEmail(e.target.value)}
                    />
                    {mode !== 'forgot' && mode !== 'link' && (
                        <input
                            type="password"
                            aria-label="Password"
                            placeholder="Password"
                            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                            value={password}
                            minLength={mode === 'sign-up' ? 10 : undefined}
                            required
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    )}
                    <button className={primary} disabled={busy}>
                        {mode === 'forgot'
                            ? 'Send reset link'
                            : mode === 'link'
                              ? 'Send me a sign-in link'
                              : mode === 'sign-up'
                                ? 'Create account'
                                : 'Sign in'}
                    </button>
                    {mode === 'sign-in' && methods.emailReset && (
                        <button type="button" onClick={() => setMode('forgot')}>
                            Forgot password?
                        </button>
                    )}
                    {mode === 'sign-in' && methods.signInLink && (
                        <button type="button" onClick={() => setMode('link')}>
                            Send me a sign-in link
                        </button>
                    )}
                    {mode === 'sign-in' && offerSignUp && (
                        <button type="button" onClick={() => setMode('sign-up')}>
                            Create an account
                        </button>
                    )}
                    {mode !== 'sign-in' && (
                        <button type="button" onClick={() => setMode('sign-in')}>
                            Back to sign-in
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
                <p>
                    Accounts are by invitation. Ask an admin for one
                    {methods.emailReset ? '' : ', or for a new password link'}.
                </p>
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
    return (
        <main className={unlock}>
            <Mascot />
            <h1>Sign in to Socio.</h1>
            <p>This link works once, for 15 minutes.</p>
            <div className={accounts}>
                <button className={primary} onClick={() => completeSignInLink(token)}>
                    Continue
                </button>
            </div>
            <p>Didn&apos;t ask for it? Close this page; the link expires on its own.</p>
        </main>
    );
}

/** `/reset-password?token=…`: choose a password, then sign in with it. */
function SetPassword({ token, onDone }: { token: string; onDone: () => void }) {
    const [password, setPassword] = useState('');
    const [repeat, setRepeat] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <main className={unlock}>
            <Mascot />
            <h1>Choose a password.</h1>
            <p>At least 10 characters. The link works once.</p>
            <form
                onSubmit={async (e) => {
                    e.preventDefault();
                    if (password !== repeat) {
                        return setError('The passwords differ.');
                    }
                    setBusy(true);
                    setError('');
                    try {
                        await setPasswordFromLink(token, password);
                        onDone();
                    } catch (e) {
                        setError(message(e, 'Could not set the password. Ask for a new link.'));
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                <input
                    type="password"
                    aria-label="New password"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
                <input
                    type="password"
                    aria-label="Repeat the password"
                    autoComplete="new-password"
                    required
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                />
                <button className={primary} disabled={busy}>
                    Set password
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
