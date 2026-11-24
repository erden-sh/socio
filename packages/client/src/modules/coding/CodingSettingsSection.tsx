import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import {
    CODING_LIMITS,
    CODING_LIMIT_KEYS,
    CODING_MODEL_ID,
    normalRepository,
    validCodingLimit,
    type CodingLimitKey,
    type CodingModelInput,
    type CodingModelView,
    type CodingSettingsState,
    type CodingUsageRow,
} from '@socio/shared/coding/coding-gateway';

import { api } from '../../lib/api';
import { SettingsCard, nativeSelect } from '../settings/AccountSettings';
import { AutosaveHeader, SaveError, SaveStatusNote, useAutosave } from '../settings/autosave';

import { CodingHarnessesSection } from './CodingHarnessesSection';
import { CodingPlansSection } from './CodingPlansSection';
import { CodingRepositoriesSection } from './CodingRepositoriesSection';
import { CodingSandboxSection } from './CodingSandboxSection';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * Settings → Coding (CB-239): the models coding sessions
 * may use, which repositories may send code to an outside provider, the
 * limits over the server's defaults, and the last day's usage. Admins
 * only, while the flag `coding-sessions` is on for them. The repositories
 * card, the sandboxes card, the personal plans card and CB-326's coding
 * agents card join this page (CB-239).
 *
 * Settings save as they change (CB-308), like Workspace settings: a
 * model's fields, its repositories and the limits. Adding a model is an
 * action, with its own button.
 */
export function CodingSettingsSection() {
    const [state, setState] = useState<CodingSettingsState>();
    const [error, setError] = useState('');
    const load = useCallback(
        () =>
            api<CodingSettingsState>('/gateway/coding')
                .then((next) => {
                    setState(next);
                    setError('');
                })
                .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.')),
        [],
    );
    useEffect(() => void load(), [load]);
    /** Saves, and takes the server's answer; throws why it couldn't. */
    const save = useCallback(
        async (path: string, method: string, body?: unknown) =>
            setState(await api<CodingSettingsState>(`/gateway${path}`, method, body)),
        [],
    );
    const change = async (path: string, method: string, body?: unknown) => {
        try {
            await save(path, method, body);
            return true;
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not save.');
            return false;
        }
    };
    if (error) {
        return (
            <SettingsCard>
                <p className="text-muted-foreground" data-slot="coding-error">
                    {error}
                </p>
            </SettingsCard>
        );
    }
    if (!state) {
        return (
            <SettingsCard>
                <p className="text-muted-foreground">Loading…</p>
            </SettingsCard>
        );
    }
    return (
        <>
            <ModelsCard state={state} change={change} save={save} />
            {/* Saved limits come in through the props (useAutosave follows them). */}
            <LimitsCard state={state} save={save} />
            {/* The personal plans for coding. */}
            <CodingPlansSection />
            {/* The coding agents and their terms records (CB-326). */}
            <CodingHarnessesSection />
            <UsageCard state={state} />
            {/* The repositories (CB-239, CB-267). */}
            <CodingRepositoriesSection />
            {/* The sandboxes: registries and workspace retention (CB-239). */}
            <CodingSandboxSection />
        </>
    );
}

type Change = (path: string, method: string, body?: unknown) => Promise<boolean>;
/** Like Change, but throws why it couldn't save, for useAutosave. */
type Save = (path: string, method: string, body?: unknown) => Promise<void>;

function ModelsCard({ state, change, save }: { state: CodingSettingsState; change: Change; save: Save }) {
    const [editing, setEditing] = useState<string | 'new' | undefined>();
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="coding-models">
                <div className="grid gap-1">
                    <h3 className="font-medium">Models</h3>
                    <p className="text-muted-foreground">
                        The only models a coding session can use, each on one of the shared backends. A session uses
                        just the model its approval card names. Models on an outside provider are offered only for the
                        repositories you allow below; the others keep code on your own servers.
                    </p>
                </div>
                {state.models.length === 0 && <p className="text-muted-foreground">No models are listed yet.</p>}
                <ul className="grid gap-3">
                    {state.models.map((model) =>
                        editing === model.id ? (
                            <li key={model.id}>
                                <ModelForm
                                    state={state}
                                    model={model}
                                    onDone={() => setEditing(undefined)}
                                    save={save}
                                />
                            </li>
                        ) : (
                            <li key={model.id} className="grid gap-2 rounded-md border p-3" data-slot="coding-model">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="grid min-w-0 gap-0.5">
                                        <span className="font-medium break-words">
                                            {model.label} <span className="text-muted-foreground">({model.id})</span>
                                        </span>
                                        <span className="text-xs text-muted-foreground break-words">
                                            {model.upstreamModel} on {model.backendLabel ?? 'a removed backend'}
                                            {model.backendHost ? ` (${model.backendHost})` : ''} · up to{' '}
                                            {model.maxOutputTokens.toLocaleString('en-US')} output tokens
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {model.outsideProvider ? (
                                            <Badge variant="outline">Outside provider</Badge>
                                        ) : (
                                            <Badge variant="outline">Your servers</Badge>
                                        )}
                                        {!model.enabled && <Badge variant="outline">Off</Badge>}
                                        {!model.backendReady && <Badge variant="outline">Backend not ready</Badge>}
                                    </div>
                                </div>
                                {model.outsideProvider && <RepositoriesField model={model} save={save} />}
                                <div className="flex flex-wrap gap-2">
                                    <Button size="sm" variant="outline" onClick={() => setEditing(model.id)}>
                                        Edit
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            void change(
                                                `/coding/models/${encodeURIComponent(model.id)}`,
                                                'DELETE',
                                            ).then((ok) => ok && toast.success('Model removed'))
                                        }
                                    >
                                        Remove
                                    </Button>
                                </div>
                            </li>
                        ),
                    )}
                </ul>
                {editing === 'new' ? (
                    <ModelForm state={state} onDone={() => setEditing(undefined)} save={save} />
                ) : (
                    <div>
                        <Button size="sm" disabled={!state.backends.length} onClick={() => setEditing('new')}>
                            Add a model
                        </Button>
                        {!state.backends.length && (
                            <p className="mt-2 text-muted-foreground">
                                Add a shared backend under Settings → Platform first.
                            </p>
                        )}
                    </div>
                )}
            </section>
        </SettingsCard>
    );
}

/** The repositories an outside-provider model may be used for. */
function RepositoriesField({ model, save }: { model: CodingModelView; save: Save }) {
    const id = useId();
    const parse = (text: string) =>
        text
            .split(/[\s,]+/)
            .map((item) => item.trim())
            .filter(Boolean);
    const auto = useAutosave({ text: model.repositories.join('\n') }, ({ text }) =>
        save(`/coding/models/${encodeURIComponent(model.id)}/repositories`, 'PUT', { repositories: parse(text) }),
    );
    // Saved when the field loses focus, one a line as the server keeps them.
    const commit = () => {
        const list = parse(auto.value.text);
        if (list.every((item) => normalRepository(item))) {
            auto.edit({ text: list.join('\n') });
        }
        void auto.commit('Repositories saved', ({ text }) => {
            const bad = parse(text).find((item) => !normalRepository(item));
            if (bad) {
                return `“${bad}” is not owner/name.`;
            }
        });
    };
    return (
        <div className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className="text-xs font-medium">
                    Allowed for these repositories (code from them goes to {model.backendHost ?? 'this provider'})
                </label>
                <SaveStatusNote status={auto.status} />
            </div>
            <Textarea
                id={id}
                rows={2}
                value={auto.value.text}
                placeholder="owner/name, one a line"
                onChange={(event) => auto.edit({ text: event.target.value })}
                onBlur={commit}
            />
            <SaveError error={auto.error} />
        </div>
    );
}

type Outside = 'auto' | 'yes' | 'no';
type Values = {
    name: string;
    label: string;
    backendId: string;
    upstream: string;
    maxOutput: string;
    context: string;
    images: boolean;
    enabled: boolean;
    outside: Outside;
};

/**
 * A model's fields. An existing model's save as they change (CB-308): text
 * and numbers when their field loses focus, the rest at once. A new one is
 * added with Add model, once its fields are filled in.
 */
function ModelForm({
    state,
    model,
    onDone,
    save,
}: {
    state: CodingSettingsState;
    model?: CodingModelView;
    onDone: () => void;
    save: Save;
}) {
    const id = useId();
    const firstBackend = state.backends[0];
    const auto = useAutosave<Values>(
        {
            name: model?.id ?? '',
            label: model?.label ?? '',
            backendId: model?.backendId ?? firstBackend?.id ?? '',
            upstream: model?.upstreamModel ?? firstBackend?.model ?? '',
            maxOutput: String(model?.maxOutputTokens ?? 8000),
            context: model?.contextWindow ? String(model.contextWindow) : '',
            images: model?.acceptsImages ?? false,
            enabled: model?.enabled ?? true,
            outside:
                model?.outsideProviderSetting === true
                    ? 'yes'
                    : model?.outsideProviderSetting === false
                      ? 'no'
                      : 'auto',
        },
        (values) => put(values),
    );
    const put = (values: Values) =>
        save(`/coding/models/${encodeURIComponent(values.name)}`, 'PUT', {
            label: values.label.trim(),
            backendId: values.backendId,
            upstreamModel: values.upstream.trim(),
            maxOutputTokens: Number(values.maxOutput),
            contextWindow: values.context.trim() ? Number(values.context) : null,
            acceptsImages: values.images,
            outsideProvider: values.outside === 'auto' ? null : values.outside === 'yes',
            enabled: values.enabled,
        } satisfies CodingModelInput);
    const check = (values: Values) => {
        const output = Number(values.maxOutput);
        const window = values.context.trim() ? Number(values.context) : null;
        if (!CODING_MODEL_ID.test(values.name)) {
            return 'The name is lowercase letters, digits, periods, dashes and underscores.';
        }
        if (!values.label.trim() || !values.upstream.trim()) {
            return 'Give the model a label and an upstream model.';
        }
        if (!Number.isInteger(output) || output < 1) {
            return 'Max output tokens is a whole number.';
        }
        if (window !== null && (!Number.isInteger(window) || window < 1024)) {
            return 'The context window is at least 1 024 tokens.';
        }
    };
    const { value } = auto;
    const backend = state.backends.find((entry) => entry.id === value.backendId);
    /** A typed field, saved when it loses focus (a model being edited). */
    const commit = () => {
        if (!model) {
            return;
        }
        auto.edit({
            label: value.label.trim(),
            upstream: value.upstream.trim(),
            maxOutput: value.maxOutput.trim(),
            context: value.context.trim(),
        });
        void auto.commit('Model saved', check);
    };
    /** A select or a checkbox: saved at once (a model being edited). */
    const choose = (patch: Partial<Values>) => (model ? void auto.change(patch, 'Model saved') : auto.edit(patch));
    const [adding, setAdding] = useState(false);
    const add = async () => {
        const problem = check(value);
        if (problem) {
            return auto.setError(problem);
        }
        auto.setError('');
        setAdding(true);
        try {
            await put(value);
            toast.success('Model added');
            onDone();
        } catch (failure) {
            auto.setError(failure instanceof Error ? failure.message : 'Could not add. Retry.');
            setAdding(false);
        }
    };
    return (
        <div className="grid gap-3 rounded-md border p-3" data-slot="coding-model-form">
            {model && (
                <div className="flex justify-end">
                    <SaveStatusNote status={auto.status} />
                </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="grid gap-1" htmlFor={`${id}-name`}>
                    <span className="text-xs text-muted-foreground">Name (what the agent asks for)</span>
                    <Input
                        id={`${id}-name`}
                        value={value.name}
                        disabled={!!model}
                        maxLength={64}
                        placeholder="orion"
                        onChange={(event) => auto.edit({ name: event.target.value })}
                    />
                </label>
                <label className="grid gap-1" htmlFor={`${id}-label`}>
                    <span className="text-xs text-muted-foreground">Label (on the approval card)</span>
                    <Input
                        id={`${id}-label`}
                        value={value.label}
                        maxLength={80}
                        placeholder="Homelab (qwen38)"
                        onChange={(event) => auto.edit({ label: event.target.value })}
                        onBlur={commit}
                    />
                </label>
                <label className="grid gap-1" htmlFor={`${id}-backend`}>
                    <span className="text-xs text-muted-foreground">Backend</span>
                    <select
                        id={`${id}-backend`}
                        className={nativeSelect}
                        value={value.backendId}
                        onChange={(event) => {
                            const next = state.backends.find((entry) => entry.id === event.target.value);
                            choose({
                                backendId: event.target.value,
                                ...(next && !value.upstream.trim() ? { upstream: next.model } : {}),
                            });
                        }}
                    >
                        {state.backends.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                                {entry.label}
                                {entry.host ? ` (${entry.host})` : ''}
                                {entry.ready ? '' : ' — not ready'}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="grid gap-1" htmlFor={`${id}-upstream`}>
                    <span className="text-xs text-muted-foreground">Upstream model</span>
                    <Input
                        id={`${id}-upstream`}
                        value={value.upstream}
                        maxLength={200}
                        onChange={(event) => auto.edit({ upstream: event.target.value })}
                        onBlur={commit}
                    />
                </label>
                <label className="grid gap-1" htmlFor={`${id}-output`}>
                    <span className="text-xs text-muted-foreground">Max output tokens</span>
                    <Input
                        id={`${id}-output`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={value.maxOutput}
                        onChange={(event) => auto.edit({ maxOutput: event.target.value })}
                        onBlur={commit}
                    />
                </label>
                <label className="grid gap-1" htmlFor={`${id}-context`}>
                    <span className="text-xs text-muted-foreground">Context window (optional)</span>
                    <Input
                        id={`${id}-context`}
                        type="number"
                        inputMode="numeric"
                        min={1024}
                        value={value.context}
                        onChange={(event) => auto.edit({ context: event.target.value })}
                        onBlur={commit}
                    />
                </label>
                <label className="grid gap-1" htmlFor={`${id}-outside`}>
                    <span className="text-xs text-muted-foreground">Where code goes</span>
                    <select
                        id={`${id}-outside`}
                        className={nativeSelect}
                        value={value.outside}
                        onChange={(event) => choose({ outside: event.target.value as Outside })}
                    >
                        <option value="auto">
                            By the backend’s address ({backend?.outsideByDefault ? 'outside provider' : 'your servers'})
                        </option>
                        <option value="no">Your servers</option>
                        <option value="yes">An outside provider</option>
                    </select>
                </label>
            </div>
            <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2" htmlFor={`${id}-images`}>
                    <Checkbox
                        id={`${id}-images`}
                        checked={value.images}
                        onCheckedChange={(next) => choose({ images: next === true })}
                    />
                    Takes images
                </label>
                <label className="flex items-center gap-2" htmlFor={`${id}-enabled`}>
                    <Checkbox
                        id={`${id}-enabled`}
                        checked={value.enabled}
                        onCheckedChange={(next) => choose({ enabled: next === true })}
                    />
                    On
                </label>
            </div>
            <SaveError error={auto.error} />
            <div className="flex flex-wrap gap-2">
                {model ? (
                    <Button size="sm" variant="outline" onClick={onDone}>
                        Done
                    </Button>
                ) : (
                    <>
                        <Button size="sm" disabled={adding} onClick={() => void add()}>
                            Add model
                        </Button>
                        <Button size="sm" variant="outline" onClick={onDone}>
                            Cancel
                        </Button>
                    </>
                )}
            </div>
        </div>
    );
}

/** The limits over the server's defaults, saved as they change (CB-308). */
function LimitsCard({ state, save }: { state: CodingSettingsState; save: Save }) {
    const id = useId();
    const auto = useAutosave(
        Object.fromEntries(CODING_LIMIT_KEYS.map((key) => [key, String(state.limits[key])])) as Record<
            CodingLimitKey,
            string
        >,
        (values) => save('/coding/limits', 'PUT', changes(values)),
    );
    // Each limit as the server takes it: null for one at the server's default.
    const changes = (values: Record<CodingLimitKey, string>) =>
        Object.fromEntries(
            CODING_LIMIT_KEYS.map((key) => {
                const text = values[key].trim();
                const value = text === '' ? NaN : Number(text);
                return [key, value === state.limitDefaults[key] ? null : value];
            }),
        ) as Record<CodingLimitKey, number | null>;
    const commit = () =>
        void auto.commit('Coding limits saved', (values) => {
            for (const [key, value] of Object.entries(changes(values)) as [CodingLimitKey, number | null][]) {
                if (value === null || validCodingLimit(key, value)) {
                    continue;
                }
                const spec = CODING_LIMITS[key];
                return `${spec.label}: use a whole number from ${spec.min.toLocaleString('en-US')} to ${spec.max.toLocaleString('en-US')}.`;
            }
        });
    const usingDefaults = CODING_LIMIT_KEYS.every((key) => state.limits[key] === state.limitDefaults[key]);
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                noValidate
                data-slot="coding-limits"
                // Enter saves too, like leaving a field.
                onSubmit={(event) => {
                    event.preventDefault();
                    commit();
                }}
            >
                <AutosaveHeader title="Limits" status={auto.status}>
                    Token budgets per session, and per person and per socio over a rolling 24 hours, plus how much may
                    run at once. There is no server-wide token budget: these bound the total.
                </AutosaveHeader>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {CODING_LIMIT_KEYS.map((key) => {
                        const spec = CODING_LIMITS[key];
                        return (
                            <div key={key} className="grid content-start gap-1.5">
                                <label htmlFor={`${id}-${key}`} className="font-medium">
                                    {spec.label}
                                </label>
                                <Input
                                    id={`${id}-${key}`}
                                    type="number"
                                    inputMode="numeric"
                                    min={spec.min}
                                    max={spec.max}
                                    className="w-40"
                                    value={auto.value[key]}
                                    onChange={(event) => auto.edit({ [key]: event.target.value })}
                                    onBlur={commit}
                                />
                                <p className="text-xs text-muted-foreground">
                                    {spec.help} Server default {state.limitDefaults[key].toLocaleString('en-US')} (
                                    {spec.env}
                                    ).
                                </p>
                            </div>
                        );
                    })}
                </div>
                <SaveError error={auto.error} />
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        disabled={usingDefaults || auto.status === 'saving'}
                        onClick={() =>
                            void auto.change(
                                Object.fromEntries(
                                    CODING_LIMIT_KEYS.map((key) => [key, String(state.limitDefaults[key])]),
                                ),
                                'Coding limits back to the server’s defaults',
                            )
                        }
                    >
                        Use the server’s defaults
                    </Button>
                </div>
            </form>
        </SettingsCard>
    );
}

function UsageTable({ title, rows }: { title: string; rows: CodingUsageRow[] }) {
    return (
        <div className="grid gap-1 overflow-x-auto">
            <h4 className="text-xs font-medium">{title}</h4>
            {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">None.</p>
            ) : (
                <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                        <tr>
                            <th className="text-left font-normal">Name</th>
                            <th className="text-right font-normal">Requests</th>
                            <th className="text-right font-normal">Prompt</th>
                            <th className="text-right font-normal">Completion</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.id}>
                                <td className="break-words">{row.label}</td>
                                <td className="text-right">{row.requests.toLocaleString('en-US')}</td>
                                <td className="text-right">{row.promptTokens.toLocaleString('en-US')}</td>
                                <td className="text-right">{row.completionTokens.toLocaleString('en-US')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function UsageCard({ state }: { state: CodingSettingsState }) {
    return (
        <SettingsCard>
            <section className="grid gap-3" data-slot="coding-usage">
                <div className="grid gap-1">
                    <h3 className="font-medium">Usage, last 24 hours</h3>
                    <p className="text-muted-foreground">
                        Tokens through the model gateway. Prompts and answers are never stored, only these counts.
                    </p>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <UsageTable title="By person" rows={state.usage.persons} />
                    <UsageTable title="By socio" rows={state.usage.socios} />
                    <UsageTable title="By model" rows={state.usage.models} />
                </div>
            </section>
        </SettingsCard>
    );
}
