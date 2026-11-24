import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import type { BackendStatus, InferenceBackendView, OperatorInferenceState } from '@socio/shared/inference';
import { formatNumber } from '@socio/shared/locale';
import type { ForceStopResult, OperatorWork, RunningWork } from '@socio/shared/operator';

import { useRevalidateOn } from '../../hooks/use-tab-refresh';
import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { groupOf } from '../settings/sections';
import { SettingsLayout } from '../settings/SettingsLayout';

import { backendPath, inputOf } from './BackendEditor';
import { ContinuousCopyCard } from './ContinuousCopyCard';
import { DomainsCard } from './DomainsCard';
import { PageSearchCard } from './PageSearchCard';
import { UpdatesCard } from './UpdatesCard';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

const dateTime = (value: number) => new Date(value).toLocaleString();
const STATUS: Record<BackendStatus, string> = {
    ready: 'Ready',
    disabled: 'Disabled',
    incomplete: 'Incomplete',
    key_unreadable: 'Key unreadable',
};

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
// Native selects; `data-slot` keeps the legacy element styles off them.
// 16 px below md, so iOS doesn't zoom in on focus (CB-96); full width, so
// a long model name doesn't widen the page on a phone.
const field =
    'h-9 w-full rounded-md border border-input bg-transparent px-2 text-base shadow-xs md:text-sm dark:bg-input/30';

/** What a backend's capabilities come to, in a line. */
function capabilityLine(backend: InferenceBackendView) {
    const { acceptsImages, maxImages, maxCompletionTokens, contextWindow } = backend.capabilities;
    return [
        acceptsImages ? `images (up to ${maxImages ?? 4})` : 'text only',
        `${formatNumber(maxCompletionTokens ?? 2200)} completion tokens`,
        `${formatNumber(contextWindow ?? 32_768)}-token context`,
    ].join(' · ');
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The running work a force stop would end, as short phrases. */
function workLines(work: RunningWork) {
    return [
        plural(work.turns, 'running turn'),
        plural(work.scheduledTasks, 'scheduled task'),
        plural(work.computerActions, 'computer action'),
        plural(work.jobRuns ?? 0, 'job run'),
    ];
}

/** The result toast's line. */
function stoppedLine(result: ForceStopResult) {
    const parts = [
        result.turns && plural(result.turns, 'turn'),
        result.scheduledTasks && plural(result.scheduledTasks, 'scheduled task'),
        result.computerActions && plural(result.computerActions, 'computer action'),
        result.jobRuns && plural(result.jobRuns, 'job run'),
    ].filter(Boolean);
    return parts.length ? `Stopped ${parts.join(', ')}.` : 'Nothing was running.';
}

/**
 * `/settings/operator` (operators only; the registry sends everyone else
 * home and the server answers 403): the inference backends Dots run on,
 * which one is the default, and the subscriptions users may connect.
 * Selection is manual: no failover between backends. The Updates card
 * shows newer releases and, with the updater, applies one (CB-259). The Domains card
 * sets up the app's host names (NPM and Cloudflare); the Page search card
 * shows search timings by day. In development
 * (`APP_ENV=development`) it says so and can stop all running work.
 */
export function OperatorPage({
    initial,
}: {
    /** The inference settings from the page's loader. */
    initial?: OperatorInferenceState;
} = {}) {
    const [state, setState] = useState<OperatorInferenceState | undefined>(initial);
    const seeded = useRef(!!initial);
    // Another tab (or operator) changed a backend or a setting, or this tab
    // came back: the loader runs again, and its state replaces this one.
    useRevalidateOn('setup');
    useLoaderSeed(initial, setState);
    const [work, setWork] = useState<OperatorWork>();
    const [stopping, setStopping] = useState(false);
    const loadWork = useCallback(
        () =>
            api<OperatorWork>('/operator/work')
                .then(setWork)
                .catch((e) => failed(e, 'Could not load the running work.')),
        [],
    );
    useEffect(() => void loadWork(), [loadWork]);
    const [busy, setBusy] = useState('');
    const load = useCallback(
        () =>
            api<OperatorInferenceState>('/inference')
                .then(setState)
                .catch((e) => failed(e, 'Could not load the inference settings.')),
        [],
    );
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
            return;
        }
        void load();
    }, [load]);
    const act = async (key: string, action: () => Promise<unknown>) => {
        setBusy(key);
        try {
            await action();
        } catch (e) {
            failed(e, 'Could not save.');
        } finally {
            setBusy('');
            await load();
        }
    };
    const settings = (body: {
        defaultBackendId?: string | null;
        allowedByoKinds?: string[];
        byoModels?: Record<string, string | null>;
    }) => api('/inference/settings', 'PUT', body);
    return (
        <SettingsLayout group={groupOf('operator')}>
            <div className="flex items-start justify-between gap-4">
                <p className="m-0 text-sm text-muted-foreground">
                    The models socios run on and the subscriptions people may bring. Changes apply from the next turn.
                </p>
                {work?.environment === 'development' && (
                    <Badge
                        variant="outline"
                        data-slot="environment-badge"
                        title="APP_ENV=development: admins may stop all running work."
                    >
                        Development
                    </Badge>
                )}
            </div>
            <div className="grid gap-6">
                <Card>
                    <CardHeader>
                        <CardTitle>Inference backends</CardTitle>
                        <CardDescription>
                            Shared models everyone&apos;s chats, titles and learning fall back to. The default one is
                            used; there is no automatic failover. Keys are write-only.
                        </CardDescription>
                        <CardAction>
                            <Button asChild>
                                <Link to={backendPath()}>Add backend</Link>
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                        {!state && <Skeleton className="h-24" />}
                        {state && !state.backends.length && (
                            <p className="text-sm text-muted-foreground">
                                No backends yet. Add a self-hosted OpenAI-compatible server, or allow users to bring
                                their own subscription below.
                            </p>
                        )}
                        {state?.backends.map((backend) => (
                            <div
                                key={backend.id}
                                data-slot="backend-row"
                                data-backend={backend.label}
                                className="grid gap-2 rounded-lg border p-4 text-sm"
                            >
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">{backend.label}</span>
                                    <Badge variant={backend.status === 'ready' ? 'secondary' : 'destructive'}>
                                        {STATUS[backend.status]}
                                    </Badge>
                                    {backend.isDefault && <Badge>Default</Badge>}
                                    <label className="ml-auto flex items-center gap-2 text-muted-foreground">
                                        Enabled
                                        <Switch
                                            aria-label={`Enable ${backend.label}`}
                                            checked={backend.enabled}
                                            disabled={!!busy}
                                            onCheckedChange={(enabled) =>
                                                act(`enable:${backend.id}`, () =>
                                                    api(`/inference/backends/${backend.id}`, 'PUT', {
                                                        ...inputOf(backend),
                                                        enabled,
                                                    }),
                                                )
                                            }
                                        />
                                    </label>
                                </div>
                                <div className="text-muted-foreground">
                                    <code className="break-all">{backend.config.baseUrl}</code> · {backend.config.model}{' '}
                                    · {capabilityLine(backend)} · {backend.hasApiKey ? 'key stored' : 'no key'}
                                </div>
                                {backend.lastTest && (
                                    <p
                                        data-slot="backend-test"
                                        className={
                                            backend.lastTest.ok
                                                ? 'text-emerald-700 dark:text-emerald-400'
                                                : 'text-destructive'
                                        }
                                    >
                                        {backend.lastTest.ok ? 'Test passed' : 'Test failed'}: {backend.lastTest.detail}{' '}
                                        <span className="text-muted-foreground">
                                            (
                                            <LocalTime value={backend.lastTest.at} format={dateTime} />)
                                        </span>
                                    </p>
                                )}
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        aria-label={`Test ${backend.label}`}
                                        disabled={!!busy}
                                        onClick={() =>
                                            act(`test:${backend.id}`, () =>
                                                api(`/inference/backends/${backend.id}/test`, 'POST'),
                                            )
                                        }
                                    >
                                        {busy === `test:${backend.id}` ? 'Testing…' : 'Test'}
                                    </Button>
                                    <Button variant="outline" size="sm" asChild>
                                        <Link to={backendPath(backend.id)} aria-label={`Edit ${backend.label}`}>
                                            Edit
                                        </Link>
                                    </Button>
                                    {!backend.isDefault && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            aria-label={`Make ${backend.label} the default`}
                                            disabled={!!busy}
                                            onClick={() =>
                                                act(`default:${backend.id}`, () =>
                                                    settings({ defaultBackendId: backend.id }),
                                                )
                                            }
                                        >
                                            Make default
                                        </Button>
                                    )}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        aria-label={`Delete ${backend.label}`}
                                        disabled={!!busy}
                                        onClick={() => {
                                            if (
                                                globalThis.confirm(
                                                    `Delete ${backend.label}?${backend.isDefault ? ' It is the default: chats then need their own subscription or another backend.' : ''}`,
                                                )
                                            ) {
                                                void act(`delete:${backend.id}`, () =>
                                                    api(`/inference/backends/${backend.id}`, 'DELETE'),
                                                );
                                            }
                                        }}
                                    >
                                        Delete
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>Bring your own subscription</CardTitle>
                        <CardDescription>
                            Kinds people may connect in Account → Inference. Their own chats and scheduled tasks then
                            run on their subscription; the rest stays on the default backend.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3 text-sm">
                        {state && !state.byoKinds.length && (
                            <p className="text-muted-foreground">
                                No subscription kinds are installed on this server yet.
                            </p>
                        )}
                        {state?.byoKinds.map((kind) => (
                            <div
                                key={kind.id}
                                data-slot="byo-kind"
                                data-kind={kind.id}
                                className="grid gap-3 rounded-lg border p-4"
                            >
                                <label className="flex items-center gap-3">
                                    <span className="grid flex-1 gap-0.5">
                                        <span className="font-medium">{kind.label}</span>
                                        <span className="text-muted-foreground">{kind.description}</span>
                                    </span>
                                    <Switch
                                        aria-label={`Allow ${kind.label}`}
                                        checked={kind.allowed}
                                        disabled={!!busy}
                                        onCheckedChange={(allowed) =>
                                            act(`kind:${kind.id}`, () =>
                                                settings({
                                                    allowedByoKinds: state.byoKinds
                                                        .filter((entry) =>
                                                            entry.id === kind.id ? allowed : entry.allowed,
                                                        )
                                                        .map((entry) => entry.id),
                                                }),
                                            )
                                        }
                                    />
                                </label>
                                {kind.models && (
                                    <label className="grid gap-1">
                                        <span className="font-medium">Model</span>
                                        <select
                                            data-slot="native-select"
                                            aria-label={`${kind.label} model`}
                                            className={`${field} min-w-0`}
                                            value={kind.models.selected}
                                            disabled={!!busy}
                                            onChange={(event) => {
                                                const model = event.target.value;
                                                void act(`model:${kind.id}`, () =>
                                                    settings({ byoModels: { [kind.id]: model } }),
                                                );
                                            }}
                                        >
                                            {kind.models.choices.map((choice) => (
                                                <option key={choice.id} value={choice.id}>
                                                    {choice.label}
                                                    {choice.id === kind.models!.default ? ' (default)' : ''}
                                                    {choice.description ? ` · ${choice.description}` : ''}
                                                </option>
                                            ))}
                                        </select>
                                        {kind.models.help && (
                                            <span className="text-muted-foreground">{kind.models.help}</span>
                                        )}
                                    </label>
                                )}
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>
            <UpdatesCard />
            <DomainsCard />
            <PageSearchCard />
            <ContinuousCopyCard />
            {work?.forceStop && (
                <Card className="mt-6" data-slot="running-work">
                    <CardHeader>
                        <CardTitle>Running work</CardTitle>
                        <CardDescription>
                            Development only: stop every running turn now, so a deploy doesn&apos;t wait for them.
                            {work.draining && ' New work is held until the server restarts.'}
                        </CardDescription>
                        <CardAction>
                            <Button
                                variant="destructive"
                                onClick={() => {
                                    void loadWork();
                                    setStopping(true);
                                }}
                            >
                                Stop all running work
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        {workLines(work.work).join(' · ')}
                    </CardContent>
                </Card>
            )}
            {stopping && work && (
                <ForceStopDialog
                    work={work.work}
                    onClose={() => setStopping(false)}
                    onStopped={() => {
                        setStopping(false);
                        void loadWork();
                    }}
                />
            )}
        </SettingsLayout>
    );
}

/** Confirms a force stop, with what is running and whether to hold new work. */
function ForceStopDialog({
    work,
    onClose,
    onStopped,
}: {
    work: RunningWork;
    onClose: () => void;
    onStopped: () => void;
}) {
    const [hold, setHold] = useState(true);
    const [busy, setBusy] = useState(false);
    const stop = async () => {
        setBusy(true);
        try {
            const result = await api<ForceStopResult>('/operator/force-stop', 'POST', { hold });
            toast.success(stoppedLine(result));
            onStopped();
        } catch (e) {
            failed(e, 'Could not stop the running work.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Stop all running work?</DialogTitle>
                    <DialogDescription>
                        Each stopped turn tells its user &ldquo;Stopped by an operator for a deploy.&rdquo; The
                        computers keep running.
                    </DialogDescription>
                </DialogHeader>
                <ul className="grid gap-1 text-sm" data-slot="force-stop-counts">
                    {workLines(work).map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
                <label className="flex items-center gap-2 text-sm">
                    <Switch checked={hold} onCheckedChange={setHold} />
                    Hold new work until the server restarts (for a deploy)
                </label>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button variant="destructive" disabled={busy} onClick={stop}>
                        {busy ? 'Stopping…' : 'Stop all running work'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
