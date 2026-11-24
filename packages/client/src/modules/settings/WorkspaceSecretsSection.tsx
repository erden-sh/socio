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

import {
    SECRET_NAME,
    SECRET_NAME_HINT,
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
const when = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const OVERLAPS = [
    { minutes: 0, label: 'Retire the old value now' },
    { minutes: 15, label: 'Keep the old value 15 minutes' },
    { minutes: 60, label: 'Keep the old value 1 hour' },
    { minutes: 24 * 60, label: 'Keep the old value 1 day' },
];

/**
 * A value field: a password input that the browser never fills or keeps,
 * cleared by its form after each save. Nothing ever shows a value again.
 */
function ValueInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
    return (
        <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            aria-label={label}
            placeholder="Value (write-only)"
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
                toast.success(`Saved ${name}`);
                setName(preset?.name ?? '');
                setDescription('');
                setValue('');
                onSaved();
            })
            .catch((error) => failed(error, 'Could not save the secret.'))
            .finally(() => {
                setValue('');
                setSaving(false);
            });
    };
    return (
        <form
            className="grid gap-2 rounded-md border border-dashed p-3"
            aria-label={preset ? `Set ${preset.name}` : 'New secret'}
            onSubmit={submit}
            autoComplete="off"
        >
            <span className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label="Secret name"
                    placeholder="NAME, e.g. STRIPE_API_KEY"
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
                    aria-label="Who it belongs to"
                    className={`${field} max-w-64`}
                    value={owner}
                    disabled={!!preset}
                    onChange={(event) => setOwner(event.target.value)}
                >
                    <option value="">The workspace (grant it to apps and plugins)</option>
                    {(preset ? apps : appsDeclaring).map((app) => (
                        <option key={app.appId} value={app.appId}>
                            Only {app.name}
                        </option>
                    ))}
                </select>
            </span>
            {name && !validName && <small className="text-destructive">Name: {SECRET_NAME_HINT}.</small>}
            <Input
                aria-label="Description"
                placeholder="What it is for (optional)"
                maxLength={300}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
            />
            <span className="flex flex-wrap items-center gap-2">
                <ValueInput value={value} onChange={setValue} label={`Value of ${name || 'the secret'}`} />
                <Button size="sm" disabled={saving || !validName || !value}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
                {onCancel && (
                    <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                        Cancel
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
                toast.success(`Replaced ${secret.name}`);
                onSaved();
            })
            .catch((error) => failed(error, 'Could not replace the value.'))
            .finally(() => {
                setValue('');
                setSaving(false);
            });
    };
    return (
        <form
            className="flex flex-wrap items-center gap-2"
            aria-label={`Replace ${secret.name}`}
            onSubmit={submit}
            autoComplete="off"
        >
            <ValueInput value={value} onChange={setValue} label={`New value of ${secret.name}`} />
            <select
                data-slot="native-select"
                aria-label="Old value"
                className={`${field} w-56`}
                value={overlap}
                onChange={(event) => setOverlap(Number(event.target.value))}
            >
                {OVERLAPS.map((option) => (
                    <option key={option.minutes} value={option.minutes}>
                        {option.label}
                    </option>
                ))}
            </select>
            <Button size="sm" disabled={saving || !value}>
                {saving ? 'Saving…' : 'Replace'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Cancel
            </Button>
        </form>
    );
}

const RULES: Record<SecretFlagRule, string> = {
    'read-spike': 'Unusual read rate',
    'read-after-revoke': 'Reads after a revoke',
    'stale-identity': 'Stale plugin identity',
};
const EVENTS: Record<SecretHistoryEvent['kind'], string> = {
    created: 'Created',
    replaced: 'Replaced',
    described: 'Description changed',
    deleted: 'Deleted',
    granted: 'Granted',
    revoked: 'Revoked',
    'first-read': 'First read by a new workload',
};

/** Read flags: why each fired, with its numbers; never a value. Dismissing keeps the record. */
function ReadFlags({
    flags,
    onDismissed,
    label = 'Read flags',
}: {
    flags: SecretReadFlagView[];
    onDismissed: () => void;
    label?: string;
}) {
    const [busy, setBusy] = useState(false);
    if (!flags.length) {
        return null;
    }
    return (
        <ul className="grid gap-2" aria-label={label}>
            {flags.map((flag) => (
                <li
                    key={flag.id}
                    className="grid gap-1 rounded-lg border border-amber-500/50 bg-amber-500/5 px-3 py-2"
                    data-slot="workspace-secret-flag"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
                        <span className="font-medium">{RULES[flag.rule]}</span>
                        <Badge variant="outline">
                            {flag.workloadName}
                            {flag.kind === 'plugin' ? ' (plugin)' : ''}
                        </Badge>
                        {flag.secretName && <code>{flag.secretName}</code>}
                        {flag.dismissedAt ? (
                            <span className="ml-auto text-xs text-muted-foreground">
                                Dismissed by {flag.dismissedByName ?? 'an admin'}{' '}
                                <LocalTime value={flag.dismissedAt} format={when} />
                            </span>
                        ) : (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="ml-auto"
                                disabled={busy}
                                aria-label={`Dismiss the flag on ${flag.workloadName}`}
                                onClick={() => {
                                    setBusy(true);
                                    void api(`/workspace-secrets/flags/${encodeURIComponent(flag.id)}/dismiss`, 'POST')
                                        .then(onDismissed)
                                        .catch((error) => failed(error, 'Could not dismiss the flag.'))
                                        .finally(() => setBusy(false));
                                }}
                            >
                                Dismiss
                            </Button>
                        )}
                    </div>
                    <p className="text-muted-foreground">{flag.explanation}</p>
                    <small className="text-xs text-muted-foreground">
                        First seen <LocalTime value={flag.firstSeenAt} format={when} /> · last seen{' '}
                        <LocalTime value={flag.lastSeenAt} format={when} />
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
            failed(error, 'Could not load the history.');
        }
    }, [path]);
    useEffect(() => {
        void load();
    }, [load]);
    if (!history) {
        return <p className="text-xs text-muted-foreground">Loading the history…</p>;
    }
    const events = [...history.events, ...older];
    return (
        <div className="grid gap-3 rounded-md border bg-muted/30 p-3" aria-label={`History of ${secret.name}`}>
            <ReadFlags flags={history.flags} onDismissed={() => void load()} label={`Read flags on ${secret.name}`} />
            <div className="grid gap-1">
                <h5 className="text-sm font-medium">Versions</h5>
                <ul className="grid gap-0.5 text-xs text-muted-foreground">
                    {history.versions.map((version) => (
                        <li key={version.version}>
                            Version {version.version} ({version.state}), set by {version.setByName}{' '}
                            <LocalTime value={version.setAt} format={when} />
                            {version.state === 'previous' && version.retireAt && (
                                <>
                                    , readable until <LocalTime value={version.retireAt} format={when} />
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            </div>
            <div className="grid gap-1">
                <h5 className="text-sm font-medium">Reads</h5>
                {history.reads.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No app or plugin has read it or tried to.</p>
                ) : (
                    <table className="w-full text-left text-xs" aria-label={`Reads of ${secret.name}`}>
                        <thead className="text-muted-foreground">
                            <tr>
                                <th className="font-normal">Workload</th>
                                <th className="font-normal">Reads</th>
                                <th className="font-normal">First read</th>
                                <th className="font-normal">Last read</th>
                                <th className="font-normal">Refused</th>
                            </tr>
                        </thead>
                        <tbody>
                            {history.reads.map((read) => (
                                <tr key={read.workload}>
                                    <td>
                                        {read.workloadName}
                                        {read.kind === 'plugin' ? ' (plugin)' : ''}
                                    </td>
                                    <td>{read.reads}</td>
                                    <td>
                                        {read.firstReadAt ? <LocalTime value={read.firstReadAt} format={when} /> : '—'}
                                    </td>
                                    <td>
                                        {read.lastReadAt ? <LocalTime value={read.lastReadAt} format={when} /> : '—'}
                                    </td>
                                    <td>
                                        {read.refused}
                                        {read.lastRefusedAt && (
                                            <>
                                                {' '}
                                                (last <LocalTime value={read.lastRefusedAt} format={when} />)
                                            </>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
            <div className="grid gap-1">
                <h5 className="text-sm font-medium">Events</h5>
                <ul className="grid gap-1 text-xs" aria-label={`Events of ${secret.name}`}>
                    {events.map((event) => (
                        <li key={event.id} className="flex flex-wrap gap-x-2" data-slot="workspace-secret-event">
                            <LocalTime value={event.at} format={when} />
                            <Badge variant={event.kind === 'first-read' ? 'default' : 'outline'}>
                                {EVENTS[event.kind]}
                            </Badge>
                            <span className="text-muted-foreground">
                                {event.actorName}: {event.detail}
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
                                .catch((error) => failed(error, 'Could not load older events.'))
                                .finally(() => setLoading(false));
                        }}
                    >
                        Show older
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
                            {secret.scope === 'workspace' ? 'Workspace' : `Only ${secret.appName}`}
                        </Badge>
                    </div>
                    {secret.description && (
                        <p className="line-clamp-2 text-xs text-muted-foreground" title={secret.description}>
                            {secret.description}
                        </p>
                    )}
                    <small className="text-xs text-muted-foreground">
                        {current ? (
                            <>
                                Version {current.version}, set by {current.setByName}{' '}
                                <LocalTime value={current.setAt} format={when} />
                            </>
                        ) : (
                            'No current value'
                        )}
                        {previous?.retireAt && (
                            <>
                                {' '}
                                · version {previous.version} readable until{' '}
                                <LocalTime value={previous.retireAt} format={when} />
                            </>
                        )}{' '}
                        ·{' '}
                        {secret.lastReadAt ? (
                            <>
                                last read by {secret.lastReadByName ?? 'an app'}{' '}
                                <LocalTime value={secret.lastReadAt} format={when} />
                            </>
                        ) : (
                            'never read'
                        )}
                    </small>
                </div>
                <span className="flex flex-wrap gap-1 max-sm:-ml-2.5">
                    <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={showHistory}
                        aria-label={`History of ${secret.name}`}
                        onClick={() => setShowHistory((open) => !open)}
                    >
                        <History className="size-4" aria-hidden /> History
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReplacing(true)}>
                        <RefreshCw className="size-4" aria-hidden /> Replace…
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Delete ${secret.name}`}
                        onClick={() => {
                            if (
                                globalThis.confirm(
                                    `Delete ${secret.name}? Apps and plugins can no longer read it, and its grants end now. Its versions are kept sealed for the record.`,
                                )
                            ) {
                                run(() => api(path, 'DELETE'), 'Could not delete the secret.');
                            }
                        }}
                    >
                        <Trash2 className="size-4" aria-hidden /> Delete
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
                    aria-label={`Apps and plugins that may read ${secret.name}`}
                >
                    <span className="text-muted-foreground">Read by:</span>
                    {secret.grants.length === 0 && <span className="text-muted-foreground">none yet</span>}
                    {secret.grants.map((grant) => (
                        <Badge key={grant.appId} variant="outline" className="gap-1">
                            {grant.appName}
                            {grant.kind === 'plugin' && <span className="text-muted-foreground">(plugin)</span>}
                            <button
                                type="button"
                                className="rounded-full hover:text-destructive"
                                aria-label={`Revoke ${secret.name} from ${grant.appName}`}
                                disabled={busy}
                                onClick={() =>
                                    run(
                                        () => api(`${path}/grants/${encodeURIComponent(grant.appId)}`, 'DELETE'),
                                        'Could not revoke it.',
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
                            aria-label={`Grant ${secret.name} to an app or plugin`}
                            className={`${field} w-48`}
                            value=""
                            disabled={busy}
                            onChange={(event) => {
                                const appId = event.target.value;
                                if (appId) {
                                    run(
                                        () => api(`${path}/grants/${encodeURIComponent(appId)}`, 'PUT'),
                                        'Could not grant it.',
                                    );
                                }
                            }}
                        >
                            <option value="">Grant to…</option>
                            {grantable.map((app) => (
                                <option key={app.appId} value={app.appId}>
                                    {app.kind === 'plugin' ? `${app.name} (plugin)` : app.name}
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
    const [busy, setBusy] = useState(false);
    const id = plugin.appId.replace(/^plugin:/, '');
    return (
        <div
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3"
            data-slot="workspace-secret-identity"
        >
            <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
                Service identity: the token {plugin.name} signs in to Socio with. Rotate it if it may have leaked.
            </p>
            <Button
                size="sm"
                variant="ghost"
                className="max-sm:w-full"
                disabled={busy}
                aria-label={`Rotate ${plugin.name}’s identity`}
                onClick={() => {
                    if (
                        !globalThis.confirm(
                            `Give ${plugin.name} a new identity token? Its service is updated now; the old token keeps working for 15 minutes while old tasks finish.`,
                        )
                    ) {
                        return;
                    }
                    setBusy(true);
                    void api<{ version?: number }>(`/plugins/${encodeURIComponent(id)}/identity`, 'POST')
                        .then((result) =>
                            toast.success(
                                `Rotated ${plugin.name}’s identity${result.version ? ` (version ${result.version})` : ''}`,
                            ),
                        )
                        .catch((error) => failed(error, 'Could not rotate the identity.'))
                        .finally(() => setBusy(false));
                }}
            >
                <RotateCw className="size-4" aria-hidden /> Rotate identity
            </Button>
        </div>
    );
}

/** "Just now", "25 min ago", "3 h ago", "yesterday", "3 days ago", "on Oct 2". */
export function setAgo(at: number, now = Date.now()) {
    const ms = Math.max(0, now - at);
    if (ms < 60_000) {
        return 'just now';
    }
    if (ms < 3_600_000) {
        return `${Math.floor(ms / 60_000)} min ago`;
    }
    if (ms < 86_400_000) {
        return `${Math.floor(ms / 3_600_000)} h ago`;
    }
    const days = Math.floor(ms / 86_400_000);
    if (days === 1) {
        return 'yesterday';
    }
    if (days < 30) {
        return `${days} days ago`;
    }
    const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
    return `on ${new Date(at).toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' })}`;
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
                            {declared.required ? 'Required' : 'Optional'}
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
                                <span className="font-medium">Set</span>
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
                                    <span className="block text-muted-foreground">Workspace secret</span>
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
                                Not set
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
                            aria-label={`Replace ${declared.name}`}
                            onClick={onAction}
                        >
                            Replace…
                        </Button>
                    ) : shared ? (
                        <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled={busy}
                            onClick={() => onGrant(shared)}
                        >
                            Grant the workspace’s
                        </Button>
                    ) : declared.servedBy ? null : (
                        <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled={busy || open}
                            aria-label={`Set a value for ${declared.name}`}
                            onClick={onAction}
                        >
                            Set a value…
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
            .catch((error) => failed(error, 'Could not grant it.'))
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
                {app.kind === 'plugin' && <Badge variant="outline">Plugin</Badge>}
                {app.declared.length > 0 &&
                    (app.needsSetup.length > 0 ? (
                        <Badge variant="destructive">Needs setup</Badge>
                    ) : (
                        <Badge variant="secondary">Ready</Badge>
                    ))}
                {required.length > 0 && (
                    <span className="text-xs text-muted-foreground sm:ml-auto" data-slot="workspace-secret-progress">
                        {requiredSet} of {required.length} required set
                    </span>
                )}
            </div>
            {app.declared.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">Declares no secrets.</p>
            ) : (
                <ul className="divide-y" aria-label={`Secrets ${app.name} declares`}>
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
    const [state, setState] = useState<WorkspaceSecretsState>();
    const [adding, setAdding] = useState(false);
    const load = useCallback(async () => {
        try {
            setState(await api<WorkspaceSecretsState>('/workspace-secrets'));
        } catch (error) {
            failed(error, 'Could not load the secrets.');
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);
    const apps = state?.apps.filter((app) => app.kind !== 'plugin' && app.declared.length > 0) ?? [];
    // Every plugin service, so its identity can be rotated even when it declares no secrets.
    const plugins = state?.apps.filter((app) => app.kind === 'plugin') ?? [];
    return (
        <section className="grid gap-4" data-slot="workspace-secrets">
            <div className="grid gap-1">
                <h3 className="font-medium">Secrets</h3>
                <p className="text-muted-foreground">
                    API keys and other secrets your workspace apps and plugins read at runtime, sealed with the data
                    key. Values are write-only: once saved, nobody can see them again, here or anywhere; replace a value
                    to change it. An app or plugin reads only the secrets its manifest declares and you grant it. Every
                    change and every read is recorded in the audit log, without the value.
                </p>
            </div>
            {!state ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (
                <>
                    {state.flags.length > 0 && (
                        <div className="grid gap-2">
                            <h4 className="font-medium">Unusual reads</h4>
                            <p className="text-xs text-muted-foreground">
                                Patterns in the audit log worth a look. Each says why it was flagged; dismissing one
                                keeps it on record, and only new evidence flags it again.
                            </p>
                            <ReadFlags flags={state.flags} onDismissed={() => void load()} />
                        </div>
                    )}
                    {apps.length > 0 && (
                        <div className="grid gap-2">
                            <h4 className="font-medium">Apps</h4>
                            <ul className="grid gap-2" aria-label="Apps and the secrets they declare">
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
                            <h4 className="font-medium">Plugins</h4>
                            <ul className="grid gap-2" aria-label="Plugins and the secrets they declare">
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
                            <h4 className="font-medium">All secrets</h4>
                            {!adding && (
                                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAdding(true)}>
                                    <Plus className="size-4" aria-hidden /> New secret
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
                                No secrets yet.
                            </p>
                        ) : (
                            <ul className="grid gap-2" aria-label="Secrets">
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
