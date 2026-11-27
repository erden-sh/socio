import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { useTranslation } from '@socio/i18n/react';
import type { McpConnectionsState, McpDiscoveryView } from '@socio/shared/mcp-connections';

import { api } from '../../lib/api';

import { nativeSelect } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Connection = McpConnectionsState['connections'][number];
const field = 'flex min-w-0 flex-col gap-1 text-sm';
// The shared native select, full width under its label (CB-258).
const select = `${nativeSelect} w-full`;
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
function ConnectionCard({
    row,
    socios,
    reload,
}: {
    row: Connection;
    socios: McpConnectionsState['socios'];
    reload: () => Promise<void>;
}) {
    const { t } = useTranslation(['settings.mcp']);
    const [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [discovery, setDiscovery] = useState<McpDiscoveryView>(),
        [scopes, setScopes] = useState<string[]>([]),
        [clientId, setClientId] = useState(''),
        [clientSecret, setClientSecret] = useState(''),
        [dotId, setDotId] = useState(socios[0]?.id ?? ''),
        [selected, setSelected] = useState<string[]>([]);
    useEffect(() => {
        setSelected(row.grants.find((g) => g.dotId === dotId)?.tools ?? []);
    }, [row.grants, dotId]);
    const path = '/mcp-connections/' + encodeURIComponent(row.id);
    const run = async (work: () => Promise<void>) => {
        setError('');
        setBusy(true);
        try {
            await work();
        } catch (e) {
            setError(message(e, t('settings.mcp:failed')));
        } finally {
            setBusy(false);
        }
    };
    return (
        <article className="min-w-0 space-y-4 rounded-md border p-4" aria-label={row.name}>
            <div className="min-w-0">
                <h4 className="break-words font-medium">{row.name}</h4>
                <p className="break-all text-sm text-muted-foreground">{row.url}</p>
                <p className="text-sm">{t('settings.mcp:status', { context: row.state, state: row.state })}</p>
            </div>
            <div className="flex flex-wrap gap-2">
                {row.authentication === 'oauth' && (
                    <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                            void run(async () => {
                                const found = await api<McpDiscoveryView>(path + '/discover', 'POST', {});
                                setDiscovery(found);
                                setScopes([]);
                                setClientId('');
                                setClientSecret('');
                                await reload();
                            })
                        }
                    >
                        {t('settings.mcp:actions.review')}
                    </Button>
                )}
                <Button
                    variant="outline"
                    disabled={busy || (row.authentication === 'oauth' && !['review', 'connected'].includes(row.state))}
                    onClick={() =>
                        void run(async () => {
                            await api(path + '/catalog', 'POST', {});
                            setDiscovery(undefined);
                            await reload();
                        })
                    }
                >
                    {t('settings.mcp:actions.refresh')}
                </Button>
                <Button
                    variant="outline"
                    disabled={busy || row.state === 'disconnected'}
                    onClick={() =>
                        void run(async () => {
                            await api(path + '/disconnect', 'POST', {});
                            setDiscovery(undefined);
                            setClientSecret('');
                            await reload();
                        })
                    }
                >
                    {t('settings.mcp:actions.disconnect')}
                </Button>
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                        void run(async () => {
                            await api(path, 'DELETE');
                            await reload();
                        })
                    }
                >
                    {t('settings.mcp:actions.remove')}
                </Button>
            </div>
            {discovery && (
                <div className="min-w-0 space-y-3 rounded-md border p-3" aria-label={t('settings.mcp:authorize.label')}>
                    <p className="text-sm">{t('settings.mcp:authorize.intro')}</p>
                    <p className="break-all text-sm">
                        {t('settings.mcp:authorize.issuer', { issuer: discovery.issuer })}
                    </p>
                    <p className="break-all text-sm">
                        {t('settings.mcp:authorize.resource', { resource: discovery.resource })}
                    </p>
                    <fieldset className="min-w-0 space-y-2">
                        <legend className="text-sm font-medium">{t('settings.mcp:authorize.scopes')}</legend>
                        {discovery.scopes.length ? (
                            discovery.scopes.map((scope) => (
                                <label key={scope} className="flex min-w-0 items-start gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={scopes.includes(scope)}
                                        disabled={busy}
                                        onChange={(event) =>
                                            setScopes((old) =>
                                                event.target.checked ? [...old, scope] : old.filter((s) => s !== scope),
                                            )
                                        }
                                    />
                                    <span className="break-all">{scope}</span>
                                </label>
                            ))
                        ) : (
                            <p className="text-sm">{t('settings.mcp:authorize.noScopes')}</p>
                        )}
                    </fieldset>
                    {discovery.requiredScopes.length > 0 && (
                        <p className="break-words text-sm">
                            {t('settings.mcp:authorize.required', { scopes: discovery.requiredScopes.join(', ') })}
                        </p>
                    )}
                    <details>
                        <summary className="cursor-pointer text-sm">{t('settings.mcp:authorize.client')}</summary>
                        <div className="mt-2 space-y-2">
                            <p className="text-sm text-muted-foreground">{t('settings.mcp:authorize.clientNote')}</p>
                            <label className={field}>
                                {t('settings.mcp:authorize.clientId')}
                                <Input
                                    value={clientId}
                                    maxLength={500}
                                    autoComplete="off"
                                    disabled={busy}
                                    onChange={(e) => setClientId(e.target.value)}
                                />
                            </label>
                            <label className={field}>
                                {t('settings.mcp:authorize.clientSecret')}
                                <Input
                                    type="password"
                                    value={clientSecret}
                                    maxLength={4096}
                                    autoComplete="new-password"
                                    disabled={busy}
                                    onChange={(e) => setClientSecret(e.target.value)}
                                />
                            </label>
                        </div>
                    </details>
                    {!discovery.registration.clientMetadata && !discovery.registration.dynamic && !clientId && (
                        <p className="text-sm">{t('settings.mcp:authorize.clientRequired')}</p>
                    )}
                    <Button
                        disabled={
                            busy ||
                            (!discovery.registration.clientMetadata && !discovery.registration.dynamic && !clientId) ||
                            (!!clientSecret && !clientId)
                        }
                        onClick={() =>
                            void run(async () => {
                                const result = await api<{ authorizationUrl: string }>(path + '/authorize', 'POST', {
                                    generation: discovery.connection.generation,
                                    scopes,
                                    ...(clientId
                                        ? {
                                              client: {
                                                  id: clientId,
                                                  issuer: discovery.issuer,
                                                  ...(clientSecret ? { secret: clientSecret } : {}),
                                              },
                                          }
                                        : {}),
                                });
                                setClientSecret('');
                                const target = new URL(result.authorizationUrl);
                                if (target.protocol !== 'https:' || target.username || target.password) {
                                    throw new Error(t('settings.mcp:authorize.invalidUrl'));
                                }
                                window.location.assign(target.href);
                            })
                        }
                    >
                        {t('settings.mcp:authorize.continue')}
                    </Button>
                </div>
            )}
            {row.catalogRevision && (
                <div className="min-w-0 space-y-3">
                    <p className="text-sm">{t('settings.mcp:tools.intro')}</p>
                    <label className={field}>
                        {t('settings.mcp:tools.socio')}
                        <select
                            data-slot="native-select"
                            className={select}
                            value={dotId}
                            disabled={busy}
                            onChange={(e) => setDotId(e.target.value)}
                        >
                            {socios.map((dot) => (
                                <option key={dot.id} value={dot.id}>
                                    {dot.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <fieldset className="min-w-0 space-y-2">
                        <legend className="text-sm font-medium">{t('settings.mcp:tools.allowed')}</legend>
                        {row.tools.length ? (
                            row.tools.map((tool) => (
                                <div key={tool.name} className="min-w-0 rounded-md border p-2">
                                    <label className="flex min-w-0 items-start gap-2 text-sm">
                                        <input
                                            type="checkbox"
                                            disabled={busy || !tool.supported}
                                            checked={selected.includes(tool.name)}
                                            onChange={(e) =>
                                                setSelected((old) =>
                                                    e.target.checked
                                                        ? [...old, tool.name]
                                                        : old.filter((name) => name !== tool.name),
                                                )
                                            }
                                        />
                                        <span className="min-w-0 break-all font-medium">{tool.name}</span>
                                    </label>
                                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">{tool.description}</p>
                                    {!tool.supported && (
                                        <p className="text-sm text-destructive">
                                            {t('settings.mcp:tools.unavailable', { reason: tool.refusal ?? '' })}
                                        </p>
                                    )}
                                    <details className="min-w-0">
                                        <summary className="cursor-pointer text-sm">
                                            {t('settings.mcp:tools.schema')}
                                        </summary>
                                        <pre className="mt-2 max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                                            {JSON.stringify(
                                                {
                                                    inputSchema: tool.inputSchema,
                                                    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
                                                    ...(tool.annotations ? { annotations: tool.annotations } : {}),
                                                },
                                                null,
                                                2,
                                            )}
                                        </pre>
                                    </details>
                                </div>
                            ))
                        ) : (
                            <p className="text-sm">{t('settings.mcp:tools.empty')}</p>
                        )}
                    </fieldset>
                    <Button
                        disabled={busy || !dotId}
                        onClick={() =>
                            void run(async () => {
                                await api(path + '/grants', 'PUT', {
                                    generation: row.generation,
                                    catalogRevision: row.catalogRevision,
                                    dotId,
                                    tools: selected,
                                });
                                await reload();
                            })
                        }
                    >
                        {t('settings.mcp:tools.save')}
                    </Button>
                </div>
            )}
            {error && (
                <p role="alert" className="break-words text-sm text-destructive">
                    {error}
                </p>
            )}
        </article>
    );
}
export function McpConnectionsSection() {
    const { t } = useTranslation(['settings.mcp']);
    const failed = t('settings.mcp:failed');
    const [state, setState] = useState<McpConnectionsState>(),
        [error, setError] = useState(''),
        [busy, setBusy] = useState(false),
        [name, setName] = useState(''),
        [url, setUrl] = useState(''),
        [authentication, setAuthentication] = useState<'oauth' | 'none'>('oauth');
    const reload = useCallback(async () => {
        setState(await api<McpConnectionsState>('/mcp-connections'));
    }, []);
    useEffect(() => {
        let live = true;
        api<McpConnectionsState>('/mcp-connections')
            .then((value) => {
                if (live) {
                    setState(value);
                }
            })
            .catch((e) => {
                if (live) {
                    setError(message(e, failed));
                }
            });
        return () => {
            live = false;
        };
    }, [failed]);
    const create = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api('/mcp-connections', 'POST', { name, url, authentication });
            setName('');
            setUrl('');
            await reload();
        } catch (e) {
            setError(message(e, failed));
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="min-w-0 space-y-4" aria-label={t('settings.mcp:title')}>
            <h3 className="font-medium">{t('settings.mcp:title')}</h3>
            <p className="text-sm text-muted-foreground">{t('settings.mcp:intro')}</p>
            <p className="text-sm text-muted-foreground">{t('settings.mcp:approval')}</p>
            <form className="min-w-0 space-y-3" onSubmit={(event) => void create(event)}>
                <label className={field}>
                    {t('settings.mcp:form.name')}
                    <Input
                        required
                        maxLength={80}
                        value={name}
                        disabled={busy}
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>
                <label className={field}>
                    {t('settings.mcp:form.url')}
                    <Input
                        required
                        type="url"
                        maxLength={2048}
                        // oxlint-disable-next-line socio/no-literal-text -- an example URL, not copy
                        placeholder="https://provider.example/mcp"
                        value={url}
                        disabled={busy}
                        onChange={(e) => setUrl(e.target.value)}
                    />
                </label>
                <label className={field}>
                    {t('settings.mcp:form.authentication')}
                    <select
                        data-slot="native-select"
                        className={select}
                        value={authentication}
                        disabled={busy}
                        onChange={(e) => setAuthentication(e.target.value as 'oauth' | 'none')}
                    >
                        <option value="oauth">{t('settings.mcp:form.oauth')}</option>
                        <option value="none">{t('settings.mcp:form.none')}</option>
                    </select>
                </label>
                <Button type="submit" disabled={busy || !state || state.connections.length >= 20}>
                    {t('settings.mcp:form.add')}
                </Button>
            </form>
            {error && (
                <p role="alert" className="break-words text-sm text-destructive">
                    {error}
                </p>
            )}
            {!state && !error && (
                <p role="status" className="text-sm">
                    {t('settings.mcp:loading')}
                </p>
            )}
            {state?.connections.map((row) => (
                <ConnectionCard key={row.id} row={row} socios={state.socios} reload={reload} />
            ))}
        </section>
    );
}
