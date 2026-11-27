import {
    CircleCheck,
    CircleDashed,
    History,
    KeyRound,
    Plus,
    RefreshCw,
    RotateCw,
    ShieldAlert,
    Trash2,
    X,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import {
    SECRET_NAME,
    type AppSecretNeeds,
    type SecretFlagRule,
    type SecretHistory,
    type SecretHistoryEvent,
    type SecretReadFlagView,
    type WorkspaceSecretsState,
    type WorkspaceSecretView,
} from '@socio/shared/workspace-secrets';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const failed = (error: unknown, fallback: string) => toast.error(error instanceof Error ? error.message : fallback);
// 16 px below md, so iOS doesn't zoom in on focus (CB-96).
const field = 'h-9 rounded-md border border-input bg-transparent px-2 text-base shadow-xs md:text-sm dark:bg-input/30';
/** How long the old value stays readable after a replace: its key and count. */
const OVERLAPS = [
    { minutes: 0, label: 'settings.secrets:overlap.now', count: 0 },
    { minutes: 15, label: 'settings.secrets:overlap.minutes', count: 15 },
    { minutes: 60, label: 'settings.secrets:overlap.hours', count: 1 },
    { minutes: 24 * 60, label: 'settings.secrets:overlap.days', count: 1 },
] as const;

/** "Oct 12, 2026, 3:04 PM": the page's times, in the reader's words once hydrated. */
function useWhen() {
    const { t } = useTranslation(['settings.secrets']);
    return (at: number) => t('settings.secrets:when', { at: new Date(at) });
}

/**
 * A value field: a password input that the browser never fills or keeps,
 * cleared by its form after each save. Nothing ever shows a value again.
 */
function ValueInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
    const { t } = useTranslation(['settings.secrets']);
    return (
        <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            aria-label={label}
            placeholder={t('settings.secrets:value.placeholder')}
            required
            className="min-w-48 flex-1"
            value={value}
            onChange={(event) => onChange(event.target.value)}
        />
    );
}

/** A new secret: workspace-wide, or one app's or plugin's own. */
function NewSecret({
    apps,
    preset,
    onSaved,
    onCancel,
}: {
    apps: AppSecretNeeds[];
    preset?: { name: string; appId: string };
    onSaved: () => void;
    onCancel?: () => void;
}) {
    const { t } = useTranslation(['settings', 'settings.secrets']);
    const [name, setName] = useState(preset?.name ?? '');
    const [owner, setOwner] = useState(preset?.appId ?? '');
    const [description, setDescription] = useState('');
    const [value, setValue] = useState('');
    const [saving, setSaving] = useState(false);
    const validName = SECRET_NAME.test(name);
    const appsDeclaring = apps.filter((app) => app.declared.some((secret) => secret.name === name));
    const submit = (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        void api('/workspace-secrets', 'POST', {
            name,
            description,
            value,
            ...(owner ? { scope: 'workload', appId: owner } : { scope: 'workspace' }),
        })
            .then(() => {
                toast.success(t('settings.secrets:new.saved', { name }));
                setName(preset?.name ?? '');
                setDescription('');
                setValue('');
                onSaved();
            })
            .catch((error) => failed(error, t('settings.secrets:errors.save')))
            .finally(() => {
                setValue('');
                setSaving(false);
            });
    };
    return (
        <form
            className="grid gap-2 rounded-md border border-dashed p-3"
            aria-label={preset ? t('settings.secrets:new.set', { name: preset.name }) : t('settings.secrets:new.title')}
            onSubmit={submit}
            autoComplete="off"
        >
            <span className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label={t('settings.secrets:new.name')}
                    placeholder={t('settings.secrets:new.namePlaceholder')}
                    required
                    maxLength={64}
                    className="max-w-64 font-mono"
                    value={name}
                    readOnly={!!preset}
                    aria-invalid={!!name && !validName}
                    onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                />
                <select
                    data-slot="native-select"
                    aria-label={t('settings.secrets:new.owner')}
                    className={`${field} max-w-64`}
                    value={owner}
                    disabled={!!preset}
                    onChange={(event) => setOwner(event.target.value)}
                >
                    <option value="">{t('settings.secrets:new.ownerWorkspace')}</option>
                    {(preset ? apps : appsDeclaring).map((app) => (
                        <option key={app.appId} value={app.appId}>
                            {t('settings.secrets:new.only', { name: app.name })}
                        </option>
                    ))}
                </select>
            </span>
            {name && !validName && <small className="text-destructive">{t('settings.secrets:new.nameHint')}</small>}
            <Input
                aria-label={t('settings.secrets:new.description')}
                placeholder={t('settings.secrets:new.descriptionPlaceholder')}
                maxLength={300}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
            />
            <span className="flex flex-wrap items-center gap-2">
                <ValueInput
                    value={value}
                    onChange={setValue}
                    label={t('settings.secrets:value.label', { name, context: name ? undefined : 'unnamed' })}
                />
                <Button size="sm" disabled={saving || !validName || !value}>
                    {saving ? t('settings:save.saving') : t('settings.secrets:new.save')}
                </Button>
                {onCancel && (
                    <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                        {t('settings.secrets:cancel')}
                    </Button>
                )}
            </span>
        </form>
    );
}

/** "Replace": a new version; the old one stays readable for the chosen window. */
function ReplaceValue({
    secret,
    overlapDefault,
    onSaved,
    onCancel,
}: {
    secret: WorkspaceSecretView;
    overlapDefault: number;
    onSaved: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation(['settings', 'settings.secrets']);
    const [value, setValue] = useState('');
    const [overlap, setOverlap] = useState(overlapDefault);
    const [saving, setSaving] = useState(false);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        void api(`/workspace-secrets/${encodeURIComponent(secret.id)}/versions`, 'POST', {
            value,
            overlapMinutes: overlap,
        })
            .then(() => {
                toast.success(t('settings.secrets:replace.done', { name: secret.name }));
                onSaved();
            })
            .catch((error) => failed(error, t('settings.secrets:errors.replace')))
            .finally(() => {
                setValue('');
                setSaving(false);
            });
    };
    return (
        <form
            className="flex flex-wrap items-center gap-2"
            aria-label={t('settings.secrets:replace.label', { name: secret.name })}
            onSubmit={submit}
            autoComplete="off"
        >
            <ValueInput
                value={value}
                onChange={setValue}
                label={t('settings.secrets:replace.value', { name: secret.name })}
            />
            <select
                data-slot="native-select"
                aria-label={t('settings.secrets:replace.old')}
                className={`${field} w-56`}
                value={overlap}
                onChange={(event) => setOverlap(Number(event.target.value))}
            >
                {OVERLAPS.map((option) => (
                    <option key={option.minutes} value={option.minutes}>
                        {t(option.label, { count: option.count })}
                    </option>
                ))}
            </select>
            <Button size="sm" disabled={saving || !value}>
                {saving ? t('settings:save.saving') : t('settings.secrets:replace.action')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                {t('settings.secrets:cancel')}
            </Button>
        </form>
    );
}

const RULES = {
    'read-spike': 'settings.secrets:flags.rule.read-spike',
    'read-after-revoke': 'settings.secrets:flags.rule.read-after-revoke',
    'stale-identity': 'settings.secrets:flags.rule.stale-identity',
} as const satisfies Record<SecretFlagRule, string>;
const EVENTS = {
    created: 'settings.secrets:events.created',
    replaced: 'settings.secrets:events.replaced',
    described: 'settings.secrets:events.described',
    deleted: 'settings.secrets:events.deleted',
    granted: 'settings.secrets:events.granted',
    revoked: 'settings.secrets:events.revoked',
    'first-read': 'settings.secrets:events.first-read',
} as const satisfies Record<SecretHistoryEvent['kind'], string>;

/** Read flags: why each fired, with its numbers; never a value. Dismissing keeps the record. */
function ReadFlags({
    flags,
    onDismissed,
    label,
}: {
    flags: SecretReadFlagView[];
    onDismissed: () => void;
    label?: string;
}) {
    const { t } = useTranslation(['settings.secrets']);
    const when = useWhen();
    const [busy, setBusy] = useState(false);
    if (!flags.length) {
        return null;
    }
    return (
        <ul className="grid gap-2" aria-label={label ?? t('settings.secrets:flags.label')}>
            {flags.map((flag) => (
                <li
                    key={flag.id}
                    className="grid gap-1 rounded-lg border border-amber-500/50 bg-amber-500/5 px-3 py-2"
                    data-slot="workspace-secret-flag"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
                        <span className="font-medium">{t(RULES[flag.rule])}</span>
                        <Badge variant="outline">
                            {t('settings.secrets:workload', { name: flag.workloadName, context: flag.kind })}
                        </Badge>
                        {flag.secretName && <code>{flag.secretName}</code>}
                        {flag.dismissedAt ? (
                            <span className="ml-auto text-xs text-muted-foreground">
                                <Trans
                                    t={t}
                                    i18nKey="settings.secrets:flags.dismissed"
                                    values={{ name: flag.dismissedByName ?? t('settings.secrets:flags.anAdmin') }}
                                    components={{ when: <LocalTime value={flag.dismissedAt} format={when} /> }}
                                />
                            </span>
                        ) : (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="ml-auto"
                                disabled={busy}
                                aria-label={t('settings.secrets:flags.dismissLabel', { name: flag.workloadName })}
                                onClick={() => {
                                    setBusy(true);
                                    void api(`/workspace-secrets/flags/${encodeURIComponent(flag.id)}/dismiss`, 'POST')
                                        .then(onDismissed)
                                        .catch((error) => failed(error, t('settings.secrets:errors.dismiss')))
                                        .finally(() => setBusy(false));
                                }}
                            >
                                {t('settings.secrets:flags.dismiss')}
                            </Button>
                        )}
                    </div>
                    <p className="text-muted-foreground">{flag.explanation}</p>
                    <small className="text-xs text-muted-foreground">
                        <Trans
                            t={t}
                            i18nKey="settings.secrets:flags.seen"
                            components={{
                                first: <LocalTime value={flag.firstSeenAt} format={when} />,
                                last: <LocalTime value={flag.lastSeenAt} format={when} />,
                            }}
                        />
                    </small>
                </li>
            ))}
        </ul>
    );
}

/**
 * A secret's history: versions, reads per workload, and a page
 * of events, newest first, from the audit lines; names only, never a value.
 */
function SecretHistoryPanel({ secret }: { secret: WorkspaceSecretView }) {
    const { t } = useTranslation(['settings.secrets']);
    const when = useWhen();
    const [history, setHistory] = useState<SecretHistory>();
    const [older, setOlder] = useState<SecretHistoryEvent[]>([]);
    const [next, setNext] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const path = `/workspace-secrets/${encodeURIComponent(secret.id)}/history`;
    const load = useCallback(async () => {
        try {
            const found = await api<SecretHistory>(path);
            setHistory(found);
            setOlder([]);
            setNext(found.nextBefore);
        } catch (error) {
            failed(error, t('settings.secrets:errors.history'));
        }
    }, [path, t]);
    useEffect(() => {
        void load();
    }, [load]);
    if (!history) {
        return <p className="text-xs text-muted-foreground">{t('settings.secrets:history.loading')}</p>;
    }
    const events = [...history.events, ...older];
    return (
        <div
            className="grid gap-3 rounded-md border bg-muted/30 p-3"
            aria-label={t('settings.secrets:history.label', { name: secret.name })}
        >
            <ReadFlags
                flags={history.flags}
                onDismissed={() => void load()}
                label={t('settings.secrets:flags.labelOn', { name: secret.name })}
            />
            <div className="grid gap-1">
                <h5 className="text-sm font-medium">{t('settings.secrets:history.versions')}</h5>
                <ul className="grid gap-0.5 text-xs text-muted-foreground">
                    {history.versions.map((version) => (
                        <li key={version.version}>
                            <Trans
                                t={t}
                                i18nKey="settings.secrets:history.version"
                                values={{ version: version.version, state: version.state, name: version.setByName }}
                                context={
                                    version.state === 'previous' && version.retireAt ? 'previousUntil' : version.state
                                }
                                components={{
                                    when: <LocalTime value={version.setAt} format={when} />,
                                    until: version.retireAt ? (
                                        <LocalTime value={version.retireAt} format={when} />
                                    ) : (
                                        <></>
                                    ),
                                }}
                            />
                        </li>
                    ))}
                </ul>
            </div>
            <div className="grid gap-1">
                <h5 className="text-sm font-medium">{t('settings.secrets:history.reads')}</h5>
                {history.reads.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('settings.secrets:history.noReads')}</p>
                ) : (
                    <table
                        className="w-full text-left text-xs"
                        aria-label={t('settings.secrets:history.readsLabel', { name: secret.name })}
                    >
                        <thead className="text-muted-foreground">
                            <tr>
                                <th className="font-normal">{t('settings.secrets:history.workload')}</th>
                                <th className="font-normal">{t('settings.secrets:history.reads')}</th>
                                <th className="font-normal">{t('settings.secrets:history.firstRead')}</th>
                                <th className="font-normal">{t('settings.secrets:history.lastRead')}</th>
                                <th className="font-normal">{t('settings.secrets:history.refused')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {history.reads.map((read) => (
                                <tr key={read.workload}>
                                    <td>
                                        {t('settings.secrets:workload', {
                                            name: read.workloadName,
                                            context: read.kind,
                                        })}
                                    </td>
                                    <td>{read.reads}</td>
                                    <td>
                                        {read.firstReadAt ? <LocalTime value={read.firstReadAt} format={when} /> : '—'}
                                    </td>
                                    <td>
                                        {read.lastReadAt ? <LocalTime value={read.lastReadAt} format={when} /> : '—'}
                                    </td>
                                    <td>
                                        {read.lastRefusedAt ? (
                                            <Trans
                                                t={t}
                                                i18nKey="settings.secrets:history.refusedLast"
                                                values={{ count: read.refused }}
                                                components={{
                                                    when: <LocalTime value={read.lastRefusedAt} format={when} />,
                                                }}
                                            />
                                        ) : (
                                            read.refused
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
            <div className="grid gap-1">
                <h5 className="text-sm font-medium">{t('settings.secrets:history.events')}</h5>
                <ul
                    className="grid gap-1 text-xs"
                    aria-label={t('settings.secrets:history.eventsLabel', { name: secret.name })}
                >
                    {events.map((event) => (
                        <li key={event.id} className="flex flex-wrap gap-x-2" data-slot="workspace-secret-event">
                            <LocalTime value={event.at} format={when} />
                            <Badge variant={event.kind === 'first-read' ? 'default' : 'outline'}>
                                {t(EVENTS[event.kind])}
                            </Badge>
                            <span className="text-muted-foreground">
                                {t('settings.secrets:history.event', { actor: event.actorName, detail: event.detail })}
                            </span>
                        </li>
                    ))}
                </ul>
                {next !== null && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="justify-self-start"
                        disabled={loading}
                        onClick={() => {
                            setLoading(true);
                            void api<SecretHistory>(`${path}?before=${next}`)
                                .then((page) => {
                                    setOlder((list) => [...list, ...page.events]);
                                    setNext(page.nextBefore);
                                })
                                .catch((error) => failed(error, t('settings.secrets:errors.older')))
                                .finally(() => setLoading(false));
                        }}
                    >
                        {t('settings.secrets:history.older')}
                    </Button>
                )}
            </div>
        </div>
    );
}

function SecretRow({
    secret,
    apps,
    overlapDefault,
    reload,
}: {
    secret: WorkspaceSecretView;
    apps: AppSecretNeeds[];
    overlapDefault: number;
    reload: () => Promise<void>;
}) {
    const { t } = useTranslation(['settings.secrets']);
    const when = useWhen();
    const [replacing, setReplacing] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [busy, setBusy] = useState(false);
    const current = secret.versions.find((version) => version.state === 'current');
    const previous = secret.versions.find((version) => version.state === 'previous');
    const granted = new Set(secret.grants.map((grant) => grant.appId));
    const grantable = apps.filter(
        (app) => !granted.has(app.appId) && app.declared.some((declared) => declared.name === secret.name),
    );
    const run = (work: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        void work()
            .then(reload)
            .catch((error) => failed(error, fallback))
            .finally(() => setBusy(false));
    };
    const path = `/workspace-secrets/${encodeURIComponent(secret.id)}`;
    return (
        <li className="grid gap-2 rounded-lg border px-4 py-3" data-slot="workspace-secret">
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="grid min-w-0 gap-0.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <code className="min-w-0 font-mono text-sm font-medium break-all">{secret.name}</code>
                        <Badge variant={secret.scope === 'workspace' ? 'secondary' : 'outline'}>
                            {secret.scope === 'workspace'
                                ? t('settings.secrets:row.workspace')
                                : t('settings.secrets:new.only', { name: secret.appName ?? '' })}
                        </Badge>
                    </div>
                    {secret.description && (
                        <p className="line-clamp-2 text-xs text-muted-foreground" title={secret.description}>
                            {secret.description}
                        </p>
                    )}
                    <small className="text-xs text-muted-foreground">
                        {current ? (
                            <Trans
                                t={t}
                                i18nKey="settings.secrets:row.current"
                                values={{ version: current.version, name: current.setByName }}
                                components={{ when: <LocalTime value={current.setAt} format={when} /> }}
                            />
                        ) : (
                            t('settings.secrets:row.noCurrent')
                        )}
                        {previous?.retireAt && (
                            <>
                                {' · '}
                                <Trans
                                    t={t}
                                    i18nKey="settings.secrets:row.previous"
                                    values={{ version: previous.version }}
                                    components={{ when: <LocalTime value={previous.retireAt} format={when} /> }}
                                />
                            </>
                        )}
                        {' · '}
                        {secret.lastReadAt ? (
                            <Trans
                                t={t}
                                i18nKey="settings.secrets:row.lastRead"
                                values={{ name: secret.lastReadByName ?? t('settings.secrets:row.anApp') }}
                                components={{ when: <LocalTime value={secret.lastReadAt} format={when} /> }}
                            />
                        ) : (
                            t('settings.secrets:row.neverRead')
                        )}
                    </small>
                </div>
                <span className="flex flex-wrap gap-1 max-sm:-ml-2.5">
                    <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={showHistory}
                        aria-label={t('settings.secrets:history.label', { name: secret.name })}
                        onClick={() => setShowHistory((open) => !open)}
                    >
                        <History className="size-4" aria-hidden /> {t('settings.secrets:history.open')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReplacing(true)}>
                        <RefreshCw className="size-4" aria-hidden /> {t('settings.secrets:replace.open')}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t('settings.secrets:row.deleteLabel', { name: secret.name })}
                        onClick={() => {
                            if (globalThis.confirm(t('settings.secrets:row.deleteConfirm', { name: secret.name }))) {
                                run(() => api(path, 'DELETE'), t('settings.secrets:errors.delete'));
                            }
                        }}
                    >
                        <Trash2 className="size-4" aria-hidden /> {t('settings.secrets:row.delete')}
                    </Button>
                </span>
            </div>
            {showHistory && <SecretHistoryPanel secret={secret} />}
            {replacing && (
                <ReplaceValue
                    secret={secret}
                    overlapDefault={overlapDefault}
                    onCancel={() => setReplacing(false)}
                    onSaved={() => {
                        setReplacing(false);
                        void reload();
                    }}
                />
            )}
            {secret.scope === 'workspace' && (
                <div
                    className="flex flex-wrap items-center gap-2"
                    aria-label={t('settings.secrets:row.readersLabel', { name: secret.name })}
                >
                    <span className="text-muted-foreground">{t('settings.secrets:row.readBy')}</span>
                    {secret.grants.length === 0 && (
                        <span className="text-muted-foreground">{t('settings.secrets:row.noReaders')}</span>
                    )}
                    {secret.grants.map((grant) => (
                        <Badge key={grant.appId} variant="outline" className="gap-1">
                            {grant.appName}
                            {grant.kind === 'plugin' && (
                                <span className="text-muted-foreground">{t('settings.secrets:plugin')}</span>
                            )}
                            <button
                                type="button"
                                className="rounded-full hover:text-destructive"
                                aria-label={t('settings.secrets:row.revokeLabel', {
                                    secret: secret.name,
                                    app: grant.appName,
                                })}
                                disabled={busy}
                                onClick={() =>
                                    run(
                                        () => api(`${path}/grants/${encodeURIComponent(grant.appId)}`, 'DELETE'),
                                        t('settings.secrets:errors.revoke'),
                                    )
                                }
                            >
                                <X className="size-3" aria-hidden />
                            </button>
                        </Badge>
                    ))}
                    {grantable.length > 0 && (
                        <select
                            data-slot="native-select"
                            aria-label={t('settings.secrets:row.grantLabel', { name: secret.name })}
                            className={`${field} w-48`}
                            value=""
                            disabled={busy}
                            onChange={(event) => {
                                const appId = event.target.value;
                                if (appId) {
                                    run(
                                        () => api(`${path}/grants/${encodeURIComponent(appId)}`, 'PUT'),
                                        t('settings.secrets:errors.grant'),
                                    );
                                }
                            }}
                        >
                            <option value="">{t('settings.secrets:row.grantTo')}</option>
                            {grantable.map((app) => (
                                <option key={app.appId} value={app.appId}>
                                    {t('settings.secrets:workload', { name: app.name, context: app.kind })}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
            )}
        </li>
    );
}

/**
 * "Rotate identity" for an enabled plugin service: a new identity
 * token through `POST /api/plugins/:id/identity`. The
 * service is updated; the old token is accepted while old tasks drain.
 * It sits in the plugin's footer, apart from secret setup (CB-377).
 */
function RotateIdentity({ plugin }: { plugin: AppSecretNeeds }) {
    const { t } = useTranslation(['settings.secrets']);
    const [busy, setBusy] = useState(false);
    const id = plugin.appId.replace(/^plugin:/, '');
    return (
        <div
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3"
            data-slot="workspace-secret-identity"
        >
            <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
                {t('settings.secrets:identity.about', { name: plugin.name })}
            </p>
            <Button
                size="sm"
                variant="ghost"
                className="max-sm:w-full"
                disabled={busy}
                aria-label={t('settings.secrets:identity.rotateLabel', { name: plugin.name })}
                onClick={() => {
                    if (!globalThis.confirm(t('settings.secrets:identity.confirm', { name: plugin.name }))) {
                        return;
                    }
                    setBusy(true);
                    void api<{ version?: number }>(`/plugins/${encodeURIComponent(id)}/identity`, 'POST')
                        .then((result) =>
                            toast.success(
                                result.version
                                    ? t('settings.secrets:identity.rotated', {
                                          name: plugin.name,
                                          version: result.version,
                                          context: 'version',
                                      })
                                    : t('settings.secrets:identity.rotated', { name: plugin.name }),
                            ),
                        )
                        .catch((error) => failed(error, t('settings.secrets:errors.rotate')))
                        .finally(() => setBusy(false));
                }}
            >
                <RotateCw className="size-4" aria-hidden /> {t('settings.secrets:identity.rotate')}
            </Button>
        </div>
    );
}

/** "Just now", "25 min ago", "3 h ago", "yesterday", "3 days ago", "on Oct 2". */
export function useSetAgo() {
    const { t } = useTranslation(['settings.secrets']);
    return (at: number, now = Date.now()) => {
        const ms = Math.max(0, now - at);
        if (ms < 60_000) {
            return t('settings.secrets:ago.justNow');
        }
        if (ms < 3_600_000) {
            return t('settings.secrets:ago.minutes', { count: Math.floor(ms / 60_000) });
        }
        if (ms < 86_400_000) {
            return t('settings.secrets:ago.hours', { count: Math.floor(ms / 3_600_000) });
        }
        const days = Math.floor(ms / 86_400_000);
        if (days < 30) {
            return t('settings.secrets:ago.days', { days: -days });
        }
        const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
        return t('settings.secrets:ago.on', { at: new Date(at), context: sameYear ? undefined : 'otherYear' });
    };
}

type Declared = AppSecretNeeds['declared'][number];

/**
 * One declared secret (CB-377): the name and a required or optional chip,
 * the description on its own clamped line, whether it is set (and when,
 * from its current version: metadata only, never the value) and one action
 * in a fixed column. Stacks on a phone: the state and the action share the
 * last line.
 */
function DeclaredRow({
    declared,
    secrets,
    busy,
    open,
    onAction,
    onGrant,
    children,
}: {
    declared: Declared;
    secrets: WorkspaceSecretView[];
    busy: boolean;
    open: boolean;
    onAction: () => void;
    onGrant: (secret: WorkspaceSecretView) => void;
    children?: ReactNode;
}) {
    const { t } = useTranslation(['settings.secrets']);
    const when = useWhen();
    const setAgo = useSetAgo();
    const served = declared.servedBy && secrets.find((secret) => secret.id === declared.servedBy!.id);
    const current = served ? served.versions.find((version) => version.state === 'current') : undefined;
    const shared = declared.servedBy
        ? undefined
        : secrets.find((secret) => secret.scope === 'workspace' && secret.name === declared.name);
    const missing = !declared.servedBy && declared.required;
    return (
        <li className="grid gap-x-4 gap-y-1.5 py-3" data-slot="workspace-secret-declared">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_10rem_10rem]">
                <div className="col-span-2 grid min-w-0 gap-0.5 sm:col-span-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <code className="min-w-0 font-mono text-sm font-medium break-all">{declared.name}</code>
                        <Badge
                            variant={declared.required ? 'secondary' : 'outline'}
                            className={declared.required ? undefined : 'text-muted-foreground'}
                        >
                            {declared.required
                                ? t('settings.secrets:declared.required')
                                : t('settings.secrets:declared.optional')}
                        </Badge>
                    </div>
                    {declared.description && (
                        <p className="line-clamp-2 text-xs text-muted-foreground" title={declared.description}>
                            {declared.description}
                        </p>
                    )}
                </div>
                <div className="flex min-w-0 items-center gap-1.5 text-xs" data-slot="workspace-secret-state">
                    {declared.servedBy ? (
                        <>
                            <CircleCheck
                                className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                                aria-hidden
                            />
                            <span className="min-w-0">
                                <span className="font-medium">{t('settings.secrets:declared.set')}</span>
                                {current && (
                                    <>
                                        {' '}
                                        <LocalTime
                                            value={current.setAt}
                                            format={(at) => setAgo(at)}
                                            title={when}
                                            className="text-muted-foreground"
                                        />
                                    </>
                                )}
                                {declared.servedBy.scope === 'workspace' && (
                                    <span className="block text-muted-foreground">
                                        {t('settings.secrets:declared.workspaceSecret')}
                                    </span>
                                )}
                            </span>
                        </>
                    ) : (
                        <>
                            <CircleDashed
                                className={`size-3.5 shrink-0 ${missing ? 'text-destructive' : 'text-muted-foreground'}`}
                                aria-hidden
                            />
                            <span className={missing ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                                {t('settings.secrets:declared.notSet')}
                            </span>
                        </>
                    )}
                </div>
                <div className="w-32 justify-self-end sm:w-full">
                    {served ? (
                        <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled={busy || open}
                            aria-label={t('settings.secrets:replace.label', { name: declared.name })}
                            onClick={onAction}
                        >
                            {t('settings.secrets:replace.open')}
                        </Button>
                    ) : shared ? (
                        <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled={busy}
                            onClick={() => onGrant(shared)}
                        >
                            {t('settings.secrets:declared.grantShared')}
                        </Button>
                    ) : declared.servedBy ? null : (
                        <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled={busy || open}
                            aria-label={t('settings.secrets:declared.setValueLabel', { name: declared.name })}
                            onClick={onAction}
                        >
                            {t('settings.secrets:declared.setValue')}
                        </Button>
                    )}
                </div>
            </div>
            {children}
        </li>
    );
}

/**
 * A workspace app's or service plugin's declared secrets (CB-377): required
 * ones first, then optional ones, in one aligned list; "Rotate identity" in
 * the footer, apart from secret setup.
 */
function AppNeeds({
    app,
    secrets,
    overlapDefault,
    reload,
}: {
    app: AppSecretNeeds;
    secrets: WorkspaceSecretView[];
    overlapDefault: number;
    reload: () => Promise<void>;
}) {
    const { t } = useTranslation(['settings.secrets']);
    const [editing, setEditing] = useState<string>();
    const [busy, setBusy] = useState(false);
    // Required first; each group keeps the manifest's order.
    const declared = [
        ...app.declared.filter((secret) => secret.required),
        ...app.declared.filter((secret) => !secret.required),
    ];
    const required = app.declared.filter((secret) => secret.required);
    const requiredSet = required.filter((secret) => secret.servedBy).length;
    const grant = (shared: WorkspaceSecretView) => {
        setBusy(true);
        void api(`/workspace-secrets/${encodeURIComponent(shared.id)}/grants/${encodeURIComponent(app.appId)}`, 'PUT')
            .then(reload)
            .catch((error) => failed(error, t('settings.secrets:errors.grant')))
            .finally(() => setBusy(false));
    };
    const close = () => setEditing(undefined);
    const saved = () => {
        setEditing(undefined);
        void reload();
    };
    return (
        <li className="grid gap-1 rounded-lg border px-4 py-3" data-slot="workspace-secret-app">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{app.name}</span>
                {app.kind === 'plugin' && <Badge variant="outline">{t('settings.secrets:app.plugin')}</Badge>}
                {app.declared.length > 0 &&
                    (app.needsSetup.length > 0 ? (
                        <Badge variant="destructive">{t('settings.secrets:app.needsSetup')}</Badge>
                    ) : (
                        <Badge variant="secondary">{t('settings.secrets:app.ready')}</Badge>
                    ))}
                {required.length > 0 && (
                    <span className="text-xs text-muted-foreground sm:ml-auto" data-slot="workspace-secret-progress">
                        {t('settings.secrets:app.progress', { set: requiredSet, count: required.length })}
                    </span>
                )}
            </div>
            {app.declared.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">{t('settings.secrets:app.none')}</p>
            ) : (
                <ul className="divide-y" aria-label={t('settings.secrets:app.declaresLabel', { name: app.name })}>
                    {declared.map((secret) => {
                        const served =
                            secret.servedBy && secrets.find((candidate) => candidate.id === secret.servedBy!.id);
                        return (
                            <DeclaredRow
                                key={secret.name}
                                declared={secret}
                                secrets={secrets}
                                busy={busy}
                                open={editing === secret.name}
                                onAction={() => setEditing(secret.name)}
                                onGrant={grant}
                            >
                                {editing === secret.name &&
                                    (served ? (
                                        <ReplaceValue
                                            secret={served}
                                            overlapDefault={overlapDefault}
                                            onCancel={close}
                                            onSaved={saved}
                                        />
                                    ) : (
                                        <NewSecret
                                            apps={[app]}
                                            preset={{ name: secret.name, appId: app.appId }}
                                            onCancel={close}
                                            onSaved={saved}
                                        />
                                    ))}
                            </DeclaredRow>
                        );
                    })}
                </ul>
            )}
            {app.kind === 'plugin' && app.status === 'enabled' && <RotateIdentity plugin={app} />}
        </li>
    );
}

/**
 * Settings → Secrets (Socio Secrets, workspace admins): secrets workspace
 * apps and service plugins read at runtime. Write-only: a value goes in and is never
 * shown again; replacing makes a new version. Each change is an explicit
 * action, not autosave, and each one is audited.
 */
export function WorkspaceSecretsSection() {
    const { t } = useTranslation(['settings.secrets']);
    const [state, setState] = useState<WorkspaceSecretsState>();
    const [adding, setAdding] = useState(false);
    const load = useCallback(async () => {
        try {
            setState(await api<WorkspaceSecretsState>('/workspace-secrets'));
        } catch (error) {
            failed(error, t('settings.secrets:errors.load'));
        }
    }, [t]);
    useEffect(() => {
        void load();
    }, [load]);
    const apps = state?.apps.filter((app) => app.kind !== 'plugin' && app.declared.length > 0) ?? [];
    // Every plugin service, so its identity can be rotated even when it declares no secrets.
    const plugins = state?.apps.filter((app) => app.kind === 'plugin') ?? [];
    return (
        <section className="grid gap-4" data-slot="workspace-secrets">
            <div className="grid gap-1">
                <h3 className="font-medium">{t('settings.secrets:title')}</h3>
                <p className="text-muted-foreground">{t('settings.secrets:intro')}</p>
            </div>
            {!state ? (
                <p className="text-xs text-muted-foreground">{t('settings.secrets:loading')}</p>
            ) : (
                <>
                    {state.flags.length > 0 && (
                        <div className="grid gap-2">
                            <h4 className="font-medium">{t('settings.secrets:flags.title')}</h4>
                            <p className="text-xs text-muted-foreground">{t('settings.secrets:flags.explanation')}</p>
                            <ReadFlags flags={state.flags} onDismissed={() => void load()} />
                        </div>
                    )}
                    {apps.length > 0 && (
                        <div className="grid gap-2">
                            <h4 className="font-medium">{t('settings.secrets:apps.title')}</h4>
                            <ul className="grid gap-2" aria-label={t('settings.secrets:apps.label')}>
                                {apps.map((app) => (
                                    <AppNeeds
                                        key={app.appId}
                                        app={app}
                                        secrets={state.secrets}
                                        overlapDefault={state.overlapDefaultMinutes}
                                        reload={load}
                                    />
                                ))}
                            </ul>
                        </div>
                    )}
                    {plugins.length > 0 && (
                        <div className="grid gap-2">
                            <h4 className="font-medium">{t('settings.secrets:plugins.title')}</h4>
                            <ul className="grid gap-2" aria-label={t('settings.secrets:plugins.label')}>
                                {plugins.map((plugin) => (
                                    <AppNeeds
                                        key={plugin.appId}
                                        app={plugin}
                                        secrets={state.secrets}
                                        overlapDefault={state.overlapDefaultMinutes}
                                        reload={load}
                                    />
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className="grid gap-2">
                        <div className="flex items-center gap-2">
                            <h4 className="font-medium">{t('settings.secrets:all.title')}</h4>
                            {!adding && (
                                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAdding(true)}>
                                    <Plus className="size-4" aria-hidden /> {t('settings.secrets:new.title')}
                                </Button>
                            )}
                        </div>
                        {adding && (
                            <NewSecret
                                apps={state.apps}
                                onCancel={() => setAdding(false)}
                                onSaved={() => {
                                    setAdding(false);
                                    void load();
                                }}
                            />
                        )}
                        {state.secrets.length === 0 ? (
                            <p className="text-muted-foreground" data-slot="workspace-secrets-empty">
                                {t('settings.secrets:all.empty')}
                            </p>
                        ) : (
                            <ul className="grid gap-2" aria-label={t('settings.secrets:title')}>
                                {state.secrets.map((secret) => (
                                    <SecretRow
                                        key={secret.id}
                                        secret={secret}
                                        apps={state.apps}
                                        overlapDefault={state.overlapDefaultMinutes}
                                        reload={load}
                                    />
                                ))}
                            </ul>
                        )}
                    </div>
                </>
            )}
        </section>
    );
}
