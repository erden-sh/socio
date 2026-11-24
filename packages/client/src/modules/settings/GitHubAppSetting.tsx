import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
    GITHUB_REPOSITORY,
    type GitHubAppInput,
    type GitHubAppView,
    type GitHubConnectNext,
} from '@socio/shared/github-types';

import { api } from '../../lib/api';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** What GitHub adds to the address when it sends the admin back. */
const RETURN_PARAMS = ['code', 'state', 'installation_id', 'setup_action'];

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

function appLine(view: GitHubAppView) {
    const { app, installation } = view;
    if (view.unreadable) {
        return 'The GitHub App saved here can’t be read: its data key is gone. Select Disconnect, then Connect GitHub.';
    }
    if (!app) {
        return 'GitHub is not connected.';
    }
    const name = app.slug ? `GitHub App ${app.slug}` : `GitHub App ${app.id}`;
    const where = app.source === 'env' ? ' (from the server’s GITHUB_APP_ID)' : '';
    if (installation) {
        return `Connected: ${name}${where}, installed${installation.account ? ` on ${installation.account}` : ''}.`;
    }
    return `Connected: ${name}${where}. Its installation is looked up from each repository.`;
}

/**
 * The GitHub App (CB-32, CB-325) in Settings → General, for admins: the
 * repository whose owner the App is made for, and "Connect GitHub", which
 * makes a GitHub App for that owner (the admin selects Create, then
 * Install, on GitHub). Coding sessions push their branches and open pull
 * requests with it (Settings → Coding → Repositories). GitHub sends the
 * admin back here; this card finishes each step. The App's key never
 * reaches the browser.
 *
 * The repository saves as it changes (CB-308), when its field loses focus.
 * `repositorySet`: saved here, over the server's; Undo of a first change
 * goes back to the server's value rather than saving it here.
 */
export function GitHubAppSetting() {
    const [view, setView] = useState<GitHubAppView>();
    const [busy, setBusy] = useState(false);
    const returned = useRef(false);
    const auto = useAutosave(
        {
            repository: view?.repository ?? '',
            repositorySet: view?.repositorySource === 'settings',
        },
        async (values) => {
            const body: GitHubAppInput = {
                repository: values.repositorySet ? values.repository || null : null,
            };
            try {
                setView(await api<GitHubAppView>('/github', 'PUT', body));
            } catch (failure) {
                throw new Error(message(failure, 'Could not save. Retry.'));
            }
        },
    );
    const { setError } = auto;
    useEffect(() => {
        const controller = new AbortController();
        api<GitHubAppView>('/github', 'GET', undefined, controller.signal)
            .then(setView)
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    // Back from GitHub: hand the code or the installation to the server once.
    useEffect(() => {
        if (returned.current) {
            return;
        }
        const params = new URLSearchParams(location.search);
        const code = params.get('code');
        const state = params.get('state');
        const installationId = params.get('installation_id');
        if (!code && !installationId) {
            return;
        }
        returned.current = true;
        // GitHub's code and state leave the address bar and the history.
        const clear = () => {
            for (const name of RETURN_PARAMS) {
                params.delete(name);
            }
            const query = params.toString();
            window.history.replaceState(
                window.history.state,
                '',
                `${location.pathname}${query ? `?${query}` : ''}${location.hash}`,
            );
        };
        clear();
        void (async () => {
            setBusy(true);
            try {
                if (code && state) {
                    const { url } = await api<GitHubConnectNext>('/github/created', 'POST', { code, state });
                    location.assign(url);
                    return;
                }
                if (installationId && state) {
                    setView(await api<GitHubAppView>('/github/installed', 'POST', { installationId, state }));
                    toast.success('GitHub connected');
                } else
                // Installed from GitHub itself: found from each repository.
                {
                    setView(await api<GitHubAppView>('/github'));
                }
            } catch (failure) {
                setError(message(failure, 'Could not finish connecting GitHub.'));
            }
            setBusy(false);
        })();
        // setError is the hook's state setter: the same on every render.
    }, [setError]);
    if (!view) {
        return null;
    }
    const commit = () => {
        const saved = auto.saved();
        const repository = auto.value.repository.trim();
        auto.edit({
            repository,
            repositorySet: repository === saved.repository ? saved.repositorySet : true,
        });
        void auto.commit(
            (next) => (next.repository ? `GitHub App owner from ${next.repository}` : 'Repository cleared'),
            (value) => {
                if (value.repository && !GITHUB_REPOSITORY.test(value.repository)) {
                    return 'Name the repository as owner/name, such as acme/app.';
                }
            },
        );
    };
    const connectGitHub = async () => {
        setBusy(true);
        setError('');
        try {
            const { url } = await api<GitHubConnectNext>('/github/connect', 'POST', {});
            location.assign(url);
        } catch (failure) {
            setError(message(failure, 'Could not start connecting GitHub.'));
            setBusy(false);
        }
    };
    const disconnect = async () => {
        setBusy(true);
        setError('');
        try {
            setView(await api<GitHubAppView>('/github/app', 'DELETE'));
            toast.success('GitHub disconnected here');
        } catch (failure) {
            setError(message(failure, 'Could not disconnect. Retry.'));
        }
        setBusy(false);
    };
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot="github-app"
                // Enter in the field saves too, like leaving it.
                onSubmit={(event) => {
                    event.preventDefault();
                    commit();
                }}
            >
                <AutosaveHeader title="GitHub App" status={auto.status}>
                    Coding sessions push their branches and open draft pull requests through this GitHub App, for a
                    person to review. Never to a base branch, and never forced. The repositories they may work on are
                    listed under Coding → Repositories.
                </AutosaveHeader>
                <div className="grid gap-1.5 sm:max-w-sm">
                    <label htmlFor="github-app-repository" className="font-medium">
                        Repository
                    </label>
                    <Input
                        id="github-app-repository"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={140}
                        placeholder="owner/name"
                        value={auto.value.repository}
                        onChange={(event) => auto.edit({ repository: event.target.value })}
                        onBlur={commit}
                    />
                    <p className="text-muted-foreground">Connect GitHub makes the App for this repository’s owner.</p>
                </div>
                {view.repositorySource === 'settings' && (
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={busy || auto.status === 'saving'}
                            onClick={() => void auto.change({ repositorySet: false }, 'Using the server’s default')}
                        >
                            Use the server’s default
                        </Button>
                    </div>
                )}
                <div className="grid gap-2" data-slot="github-app-connection">
                    <p className="text-muted-foreground" data-slot="github-app-status">
                        {appLine(view)}
                    </p>
                    <p className="text-muted-foreground">
                        Connect GitHub makes a GitHub App for the repository’s owner that may only write code and pull
                        requests. On GitHub, select Create, then Install on the repositories. Each push gets a token for
                        one repository that lasts only for it. Nothing is pasted, and coding agents never see a GitHub
                        credential.
                    </p>
                    {!view.canConnect && (
                        <p className="text-muted-foreground">
                            Set APP_ORIGIN on the server first: GitHub sends you back to that address.
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant={view.app ? 'outline' : 'default'}
                            disabled={busy || !view.canConnect || !view.repository || view.unreadable}
                            onClick={() => void connectGitHub()}
                        >
                            {view.app?.source === 'settings' ? 'Connect again' : 'Connect GitHub'}
                        </Button>
                        {(view.app?.source === 'settings' || view.unreadable) && (
                            <Button type="button" variant="outline" disabled={busy} onClick={() => void disconnect()}>
                                Disconnect
                            </Button>
                        )}
                    </div>
                    {view.app?.source === 'settings' && (
                        <p className="text-muted-foreground">
                            Disconnect forgets the App here; delete it on GitHub too, in your account or organization’s
                            Developer settings → GitHub Apps.
                        </p>
                    )}
                </div>
                <SaveError error={auto.error} />
            </form>
        </SettingsCard>
    );
}
