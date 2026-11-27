import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    GITHUB_REPOSITORY,
    type GitHubAppInput,
    type GitHubAppView,
    type GitHubConnectNext,
} from '@socio/shared/github-types';

import { api } from '../../lib/api';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';
import { onDemand } from './on-demand';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** What GitHub adds to the address when it sends the admin back. */
const RETURN_PARAMS = ['code', 'state', 'installation_id', 'setup_action'];

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** The card's "Connected: …" line. */
function useAppLine() {
    const { t } = useTranslation(['settings.workspace-github']);
    return (view: GitHubAppView) => {
        const { app, installation } = view;
        if (view.unreadable) {
            return t('settings.workspace-github:status.unreadable');
        }
        if (!app) {
            return t('settings.workspace-github:status.notConnected');
        }
        const name = app.slug || String(app.id);
        const context = app.source === 'env' ? 'env' : undefined;
        if (installation) {
            return installation.account
                ? t('settings.workspace-github:status.installedOn', { name, account: installation.account, context })
                : t('settings.workspace-github:status.installed', { name, context });
        }
        return t('settings.workspace-github:status.connected', { name, context });
    };
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
function GitHubAppSettingBody() {
    const { t } = useTranslation(['settings.workspace-github']);
    const appLine = useAppLine();
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
                throw new Error(message(failure, t('settings.workspace-github:saveFailed')));
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
                    toast.success(t('settings.workspace-github:connected'));
                } else
                // Installed from GitHub itself: found from each repository.
                {
                    setView(await api<GitHubAppView>('/github'));
                }
            } catch (failure) {
                setError(message(failure, t('settings.workspace-github:finishFailed')));
            }
            setBusy(false);
        })();
        // setError is the hook's state setter, and t changes only with the
        // language: `returned` keeps it to the one return from GitHub.
    }, [setError, t]);
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
            (next) =>
                next.repository
                    ? t('settings.workspace-github:ownerFrom', { repository: next.repository })
                    : t('settings.workspace-github:repositoryCleared'),
            (value) => {
                if (value.repository && !GITHUB_REPOSITORY.test(value.repository)) {
                    return t('settings.workspace-github:repositoryInvalid');
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
            setError(message(failure, t('settings.workspace-github:startFailed')));
            setBusy(false);
        }
    };
    const disconnect = async () => {
        setBusy(true);
        setError('');
        try {
            setView(await api<GitHubAppView>('/github/app', 'DELETE'));
            toast.success(t('settings.workspace-github:disconnected'));
        } catch (failure) {
            setError(message(failure, t('settings.workspace-github:disconnectFailed')));
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
                <AutosaveHeader title={t('settings.workspace-github:title')} status={auto.status}>
                    {t('settings.workspace-github:intro')}
                </AutosaveHeader>
                <div className="grid gap-1.5 sm:max-w-sm">
                    <label htmlFor="github-app-repository" className="font-medium">
                        {t('settings.workspace-github:repository')}
                    </label>
                    <Input
                        id="github-app-repository"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={140}
                        placeholder={t('settings.workspace-github:repositoryPlaceholder')}
                        value={auto.value.repository}
                        onChange={(event) => auto.edit({ repository: event.target.value })}
                        onBlur={commit}
                    />
                    <p className="text-muted-foreground">{t('settings.workspace-github:repositoryHint')}</p>
                </div>
                {view.repositorySource === 'settings' && (
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={busy || auto.status === 'saving'}
                            onClick={() =>
                                void auto.change({ repositorySet: false }, t('settings.workspace-github:usingDefault'))
                            }
                        >
                            {t('settings.workspace-github:useDefault')}
                        </Button>
                    </div>
                )}
                <div className="grid gap-2" data-slot="github-app-connection">
                    <p className="text-muted-foreground" data-slot="github-app-status">
                        {appLine(view)}
                    </p>
                    <p className="text-muted-foreground">{t('settings.workspace-github:explain')}</p>
                    {!view.canConnect && (
                        <p className="text-muted-foreground">{t('settings.workspace-github:needsOrigin')}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            variant={view.app ? 'outline' : 'default'}
                            disabled={busy || !view.canConnect || !view.repository || view.unreadable}
                            onClick={() => void connectGitHub()}
                        >
                            {view.app?.source === 'settings'
                                ? t('settings.workspace-github:connectAgain')
                                : t('settings.workspace-github:connect')}
                        </Button>
                        {(view.app?.source === 'settings' || view.unreadable) && (
                            <Button type="button" variant="outline" disabled={busy} onClick={() => void disconnect()}>
                                {t('settings.workspace-github:disconnect')}
                            </Button>
                        )}
                    </div>
                    {view.app?.source === 'settings' && (
                        <p className="text-muted-foreground">{t('settings.workspace-github:disconnectNote')}</p>
                    )}
                </div>
                <SaveError error={auto.error} />
            </form>
        </SettingsCard>
    );
}

/** Below the fold: its words load when it mounts (settings.workspace-github, in no route's entry). */
export const GitHubAppSetting = onDemand(['settings.workspace-github'], GitHubAppSettingBody);
