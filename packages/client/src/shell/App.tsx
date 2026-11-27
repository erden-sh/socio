import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLoaderData, useLocation, useNavigate, useNavigation, useRevalidator } from 'react-router';

import type { SignInMethods } from '@socio/shared/auth';
import { reconnectDelay } from '@socio/shared/reconnect';
import type { Conversation, State, WorkspaceState } from '@socio/shared/types';

import { revalidateAll, useTabRefresh } from '../hooks/use-tab-refresh';
import { api, ApiError, apiIfChanged, describeFailure, PollTags, UNCHANGED } from '../lib/api';
import { useLiveTopic } from '../lib/change-channel';
import { Mascot } from '../locals/Mascot';
import { recentDrafts } from '../modules/chat/chat-drafts';
import { UnsentDraftsWarning, draftPlaces } from '../modules/chat/UnsentDraftsWarning';
import { legacyLocationPath, setAppNavigator } from '../modules/pages/page-navigation';
import { recordNavigation, recordRoute } from '../modules/settings/performance/recorder';
import { unlock, unlockError } from '../views/unlock';

import { AppShell } from './AppShell';
import { forgetSessionMemory, onAuthEvent, postAuthEvent } from './auth-channel';
import { authSession } from './auth-client';
import { afterPoll, navigateOrLoad } from './build-skew';
import { pollHeartbeat } from './connection-status';
import { CurrentUser, SignInSetup } from './current-user';
import { oneTimeLink } from './one-time-link';
import { applyRefreshResult, OFFLINE_NOTICE, visibleNotice, type Notices } from './poll-notice';
import { presenceHeaders } from './presence';
import { serverAway } from './reconnect';
import type { ShellData } from './Shell.route';
import { SignIn } from './SignIn';
import { defaultUiHints, UiHintsContext } from './ui-hints';

/** The shell's data as the loader left it: signed in, or the sign-in gate. */
const fromLoader = (data: ShellData | undefined) =>
    data?.session === 'signed-in'
        ? { state: data.state, workspace: data.workspace, gate: undefined }
        : {
              state: undefined,
              workspace: undefined,
              gate: data ? ('sign-in' as const) : undefined,
          };

/**
 * The root route: the sign-in gate and, once signed in, the shell that
 * renders the routes. It starts from the shell loader's data
 * (Shell.route.tsx), so the server renders the same shell or sign-in
 * screen; the workspace poll (`/state` and `/workspace`, once every 3 s)
 * keeps it fresh while signed in. Signed out, nothing polls: the tab asks
 * the server again when another tab signs in (auth-channel.ts), and when
 * it comes back into view or gains focus. Signed in, it re-reads at once
 * when another tab writes (change-channel.ts) and when it comes back
 * after a while (use-tab-refresh.ts). Also keeps old hash links working:
 * a `/#/spaces/…` address becomes its path.
 */
export function App() {
    const navigate = useNavigate();
    const location = useLocation();
    useEffect(() => recordRoute(location.pathname), [location.pathname]);
    const navigation = useNavigation();
    const navigationStart = useRef<number | undefined>(undefined);
    useEffect(() => {
        if (navigation.state !== 'idle') {
            navigationStart.current ??= performance.now();
        } else if (navigationStart.current !== undefined) {
            recordNavigation(location.pathname, performance.now() - navigationStart.current);
            navigationStart.current = undefined;
        }
    }, [navigation.state, location.pathname]);
    const revalidator = useRevalidator();
    // Every revalidation here includes the shell's loader (sign-in, sign-out,
    // another account), even during a pages-only one (use-tab-refresh.ts).
    const revalidate = useCallback(() => revalidateAll(revalidator.revalidate), [revalidator.revalidate]);
    const data = useLoaderData() as ShellData | undefined;
    const ui = data?.ui ?? defaultUiHints;
    const withHints = (children: ReactNode) => <UiHintsContext.Provider value={ui}>{children}</UiHintsContext.Provider>;
    const [state, setState] = useState<State | undefined>(() => fromLoader(data).state);
    const [workspace, setWorkspace] = useState<WorkspaceState | undefined>(() => fromLoader(data).workspace);
    const [notices, setNotices] = useState<Notices>({
        refresh: '',
        capture: '',
        action: '',
    });
    const error = visibleNotice(notices);
    const [gate, setGate] = useState<'sign-in' | undefined>(() => fromLoader(data).gate);
    // Drafts less than a day old, asked about before signing out (CB-171).
    const [unsent, setUnsent] = useState<{ owner: string; scopes: string[] }>();
    // New loader data (a revalidation after sign-in or sign-out) replaces
    // the local copy. Navigations keep the same data.
    const [loaded, setLoaded] = useState(data);
    if (loaded !== data) {
        const next = fromLoader(data);
        setLoaded(data);
        setState(next.state);
        setWorkspace(next.workspace);
        // The warning is about the person it was opened for.
        if (unsent && unsent.owner !== next.workspace?.user.id) {
            setUnsent(undefined);
        }
        setGate(next.gate);
    }
    // Better Auth's methods once signed in (the account menu); none for mock.
    const [methods, setMethods] = useState<SignInMethods>();
    const userId = workspace?.user.id;
    const signedOut = gate === 'sign-in';
    // Counts sessions that ended here, so a poll that was in flight when
    // this tab signed out doesn't bring the old data back.
    const ended = useRef(0);
    // The signed-in user, for the poll (it notices another account).
    const shownUser = useRef(userId);
    // The tags of the copies shown, for conditional polls (api.ts). New
    // loader data replaces the copies, so their tags go too.
    const [tags] = useState(() => new PollTags());
    useEffect(() => tags.forget(), [tags, data]);
    useEffect(() => {
        shownUser.current = userId;
    }, [userId]);
    /**
     * The session ended (here, in another tab, or on the server): show
     * sign-in at once and drop what this tab holds for the user. The
     * caller revalidates, which clears the pages' loader data.
     */
    const dropSession = useCallback(() => {
        ended.current += 1;
        setGate('sign-in');
        setState(undefined);
        setWorkspace(undefined);
        setMethods(undefined);
        setNotices({ refresh: '', capture: '', action: '' });
        // The sign-out warning is about drafts that are about to be forgotten;
        // it must not come back over the next person's shell.
        setUnsent(undefined);
        tags.forget();
        forgetSessionMemory();
    }, [tags]);
    useEffect(() => {
        if (userId) {
            void authSession()
                .then((session) => setMethods(session.methods))
                .catch(() => undefined);
        }
    }, [userId]);
    // Code outside React (the editor's link clicks) navigates through here;
    // after a deploy, it loads the page instead (build-skew.ts).
    useEffect(() => setAppNavigator(navigateOrLoad((path, state) => void navigate(path, { state }))), [navigate]);
    // An old hash link (`/#/spaces/…`), opened, clicked or typed in this tab.
    // The server never sees the hash, so a load renders Home first; after
    // hydration this moves to the page.
    const legacy = legacyLocationPath(location);
    useEffect(() => {
        if (legacy) {
            void navigate(legacy, { replace: true });
        }
    }, [legacy, navigate]);
    // While the server is away (a restart, CB-108), the poll backs off:
    // failures in a row, and when it may ask again.
    const away = useRef({ failures: 0, retryAt: 0 });
    const refresh = useCallback(async () => {
        const session = ended.current;
        try {
            // A 304 (UNCHANGED) keeps the copy shown, without a render.
            const [s, w] = await Promise.all([
                // Each poll says whether this tab is in use (CB-114).
                apiIfChanged<State>('/state', tags.get('/state'), undefined, presenceHeaders()),
                apiIfChanged<WorkspaceState>('/workspace', tags.get('/workspace')),
            ]);
            if (session !== ended.current) {
                return;
            }
            // Another account signed in in this browser (a sign-in link opened
            // in another tab): the pages' loader data is the previous user's.
            if (w !== UNCHANGED && shownUser.current && shownUser.current !== w.data.user.id) {
                void revalidate();
            }
            if (s !== UNCHANGED) {
                setState(s.data);
                tags.set('/state', s.tag);
            }
            if (w !== UNCHANGED) {
                setWorkspace(w.data);
                tags.set('/workspace', w.tag);
            }
            setGate(undefined);
            away.current = { failures: 0, retryAt: 0 };
            setNotices((current) => applyRefreshResult(current, { ok: true }));
            // Back after the server was away (a deploy): is this build current?
            void afterPoll(true);
            pollHeartbeat();
        } catch (e) {
            if (session !== ended.current) {
                return;
            }
            void afterPoll(false);
            // The header's connection badge (CB-263).
            pollHeartbeat(e);
            // The session ended on the server (expired, or signed out
            // everywhere): sign-in here, and the other tabs follow.
            if (e instanceof ApiError && e.status === 401) {
                dropSession();
                postAuthEvent('signed-out');
                void revalidate();
                return;
            }
            if (serverAway(e)) {
                const failures = away.current.failures + 1;
                away.current = {
                    failures,
                    retryAt: Date.now() + reconnectDelay(failures),
                };
            }
            setNotices((current) =>
                applyRefreshResult(current, describeFailure(e, 'Could not connect to the server.')),
            );
        }
    }, [dropSession, revalidate, tags]);
    // An optimistic patch of one conversation in the workspace shown now
    // (its `conversations` or `archived` list), so a view can show a change
    // at once without waiting for the next `refresh` (a room's mute state,
    // Rooms follow-ups). The next poll reconciles it with the server.
    const patchConversation = useCallback((id: string, patch: Partial<Conversation>) => {
        setWorkspace((current) => {
            if (!current) {
                return current;
            }
            const apply = (list: Conversation[] | undefined) =>
                list?.map((thread) => (thread.id === id ? { ...thread, ...patch } : thread));
            const conversations = apply(current.conversations) ?? current.conversations;
            const archived = apply(current.archived) ?? current.archived;
            if (conversations === current.conversations && archived === current.archived) {
                return current;
            }
            return { ...current, conversations, archived };
        });
    }, []);
    // Another tab wrote something the shell shows, or this tab came back
    // (change-channel.ts): re-read now. The other topics wait until the new
    // data is committed, so a chat deleted elsewhere has left before
    // anything asks for it alone.
    const [commits, setCommits] = useState(0);
    const afterCommit = useRef<(() => void)[]>([]);
    useLayoutEffect(() => {
        for (const resolve of afterCommit.current.splice(0)) {
            resolve();
        }
    }, [commits]);
    useLiveTopic(signedOut ? undefined : 'shell', async () => {
        await refresh();
        await new Promise<void>((resolve) => {
            afterCommit.current.push(resolve);
            setCommits((count) => count + 1);
        });
    });
    useTabRefresh(!signedOut);
    // Started from the loader's data, the first poll waits its 3 s. Signed
    // out, there is no poll. While the server is away, a tick waits out the
    // backoff (about 2 s, 4 s… up to 10 s, on the 3 s ticks) before it asks
    // again.
    const loadedFirst = useRef(data !== undefined);
    useEffect(() => {
        if (signedOut) {
            return;
        }
        if (!loadedFirst.current) {
            void refresh();
        }
        loadedFirst.current = true;
        const timer = setInterval(() => {
            if (Date.now() >= away.current.retryAt) {
                void refresh();
            }
        }, 3000);
        return () => clearInterval(timer);
    }, [refresh, signedOut]);
    // The browser went offline: say so at once, not that the server is
    // updating. Back online, ask at once instead of waiting out the backoff.
    useEffect(() => {
        if (signedOut) {
            return;
        }
        const offline = () =>
            setNotices((current) =>
                applyRefreshResult(current, {
                    ok: false,
                    offline: true,
                    message: OFFLINE_NOTICE,
                }),
            );
        const online = () => {
            away.current = { failures: 0, retryAt: 0 };
            void refresh();
        };
        window.addEventListener('offline', offline);
        window.addEventListener('online', online);
        return () => {
            window.removeEventListener('offline', offline);
            window.removeEventListener('online', online);
        };
    }, [refresh, signedOut]);
    // A tab that loads signed in (a reload, a new tab, the way back from a
    // provider or a sign-in link) tells the signed-out tabs to ask again.
    const loadedSignedIn = useRef(data?.session === 'signed-in');
    useEffect(() => {
        if (loadedSignedIn.current) {
            postAuthEvent('signed-in');
        }
    }, []);
    // Signed in: another tab signed out. Show sign-in at once, then ask the
    // server (if the session is still good, the shell comes back).
    useEffect(() => {
        if (signedOut) {
            return;
        }
        return onAuthEvent((event) => {
            if (event !== 'signed-out') {
                return;
            }
            dropSession();
            void revalidate();
        });
    }, [signedOut, dropSession, revalidate]);
    // Signed out: ask the server again when another tab signs in, and when
    // this tab comes back into view or gains focus (a sign-in in another
    // window). One question at a time; an event during one asks once more.
    useEffect(() => {
        if (!signedOut) {
            return;
        }
        let asking = false;
        let again = false;
        const recheck = () => {
            if (asking) {
                again = true;
                return;
            }
            asking = true;
            void revalidate().finally(() => {
                asking = false;
                if (!again) {
                    return;
                }
                again = false;
                recheck();
            });
        };
        const shown = () => {
            if (document.visibilityState === 'visible') {
                recheck();
            }
        };
        const stop = onAuthEvent((event) => {
            if (event === 'signed-in') {
                recheck();
            }
        });
        document.addEventListener('visibilitychange', shown);
        globalThis.addEventListener('focus', recheck);
        return () => {
            stop();
            document.removeEventListener('visibilitychange', shown);
            globalThis.removeEventListener('focus', recheck);
        };
    }, [signedOut, revalidate]);
    const setError = (action: string) =>
        setNotices((current) => (current.action === action ? current : { ...current, action }));
    // The shell unmounts behind the gates, so a new user starts with fresh
    // selections, dialogs and drafts. The loaders run again for the new
    // session (a module gate may send the new user home).
    const signedIn = async () => {
        setError('');
        await refresh();
        await revalidate();
        postAuthEvent('signed-in');
    };
    const switchUser = async () => {
        // Another user's conversation or page must not stay in the address bar.
        await navigate('/');
        // Staying with an unsaved draft (the guard's prompt) cancels the switch.
        if (globalThis.location.pathname !== '/') {
            return;
        }
        // After "Sign out everywhere" this answers 401: signed out either way.
        await api('/auth/logout', 'POST', {}).catch(() => undefined);
        dropSession();
        postAuthEvent('signed-out');
        await revalidate();
    };
    // Signing out with unsent drafts less than a day old asks first.
    const requestSignOut = () => {
        const drafts = workspace ? recentDrafts(workspace.user.id) : [];
        if (drafts.length) {
            setUnsent({
                owner: workspace!.user.id,
                scopes: drafts.map((draft) => draft.scope),
            });
        } else {
            void switchUser();
        }
    };
    // A password link (invite or reset) or a sign-in link works signed in or
    // out.
    if (gate === 'sign-in' || oneTimeLink(location)) {
        return (
            <SignIn
                session={data?.session === 'signed-out' ? data.signIn : undefined}
                onSignedIn={() => void signedIn()}
                onPasswordSet={() => void navigate('/', { replace: true })}
            />
        );
    }
    // Archived Dots come along for their chats' names, never as the only ones.
    if (!state || !workspace || !workspace.dots.some((dot) => !dot.archivedAt)) {
        return (
            <main className={unlock}>
                <Mascot state="working" />
                <h1>Finding your socios…</h1>
                {error && (
                    <>
                        <p className={unlockError}>{error}</p>
                        <button onClick={() => void refresh()}>Retry</button>
                    </>
                )}
            </main>
        );
    }
    const configured = workspace.setup.missing.length === 0;
    const shell = (
        <AppShell
            state={state}
            workspace={workspace}
            configured={configured}
            notices={notices}
            setNotices={setNotices}
            refresh={refresh}
            patchConversation={patchConversation}
            onSwitchUser={requestSignOut}
            onSessionEnded={() => void switchUser()}
        />
    );
    return withHints(
        <CurrentUser.Provider value={workspace.user}>
            <SignInSetup.Provider value={methods}>
                {shell}
                {unsent?.owner === workspace.user.id && (
                    <UnsentDraftsWarning
                        places={draftPlaces(
                            unsent.scopes,
                            [...workspace.conversations, ...(workspace.archived ?? [])],
                            workspace.dots,
                        )}
                        onCancel={() => setUnsent(undefined)}
                        onSignOut={async () => {
                            setUnsent(undefined);
                            await switchUser();
                        }}
                    />
                )}
            </SignInSetup.Provider>
        </CurrentUser.Provider>,
    );
}
