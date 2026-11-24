import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
    CODING_GIT_LIMIT_BOUNDS,
    validCodingRepository,
    type CodingGitLimits,
    type CodingRepositoriesView,
    type CodingRepositoryCheck,
    type CodingRepositoryInput,
    type CodingRepositoryView,
} from '@socio/shared/coding/coding-repos';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';
import { SaveError, SaveStatusNote, useAutosave } from '../settings/autosave';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

/**
 * Settings → Coding → Repositories (CB-239, CB-267), for
 * admins: the repositories coding sessions and extractions may use, each
 * with its base branches, branch prefix, push (after the checklist), who
 * may use it, and extraction; and
 * the Git proxy's limits, in the Coding settings section (the
 * outside-provider models a repository allows are its Models card). The
 * server answers 404 while the coding flags are off; then nothing shows.
 */

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

const list = (text: string) =>
    text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

const LIMIT_LABELS: Record<keyof CodingGitLimits, string> = {
    gitRequestsPerMinute: 'Git requests a minute, per session',
    tokensPerHour: 'GitHub tokens an hour, for the instance',
    tokensPerSessionHour: 'GitHub tokens an hour, per session',
    extractMaxMb: 'Largest extraction (MB)',
    extractMaxFiles: 'Most files in an extraction',
    extractRetentionHours: 'Hours an extraction is kept',
};

/** Throws why `api` couldn't save, for useAutosave to show. */
async function saving<T>(request: Promise<T>) {
    try {
        return await request;
    } catch (failure) {
        throw new Error(message(failure, 'Could not save. Retry.'));
    }
}

/**
 * A repository's settings, saved as they change (CB-308): the text fields
 * when they lose focus, the checkboxes at once. Push goes on only with
 * Turn on push, once the admin confirms the checklist; push changes offer
 * no Undo, which would skip that confirmation.
 */
function RepositoryCard({
    repository,
    checklist,
    onChange,
}: {
    repository: CodingRepositoryView;
    checklist: readonly string[];
    onChange: (view: CodingRepositoriesView) => void;
}) {
    const id = repository.repository.replace(/[^A-Za-z0-9]/g, '-');
    const name = repository.repository;
    const path = `/gateway/repositories/${name}`;
    const auto = useAutosave(
        {
            bases: repository.baseBranches.join(', '),
            prefix: repository.branchPrefix,
            users: (repository.users ?? []).join(', '),
            push: repository.push,
            extraction: repository.extraction,
            standing: repository.standingExtraction,
        },
        async (values) => {
            const users = list(values.users);
            const body: CodingRepositoryInput = {
                baseBranches: list(values.bases),
                branchPrefix: values.prefix.trim(),
                users: users.length ? users : null,
                push: values.push,
                // Only Turn on push, after the checklist, saves push on.
                ...(values.push && !repository.push ? { pushChecklistConfirmed: true } : {}),
                extraction: values.extraction,
                standingExtraction: values.extraction && values.standing,
            };
            onChange(await saving(api<CodingRepositoriesView>(path, 'PUT', body)));
        },
    );
    /** Push chosen, waiting for the checklist. */
    const [wantPush, setWantPush] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const turningPushOn = wantPush && !auto.value.push;
    const commit = () => {
        auto.edit({
            bases: list(auto.value.bases).join(', '),
            prefix: auto.value.prefix.trim(),
            users: list(auto.value.users).join(', '),
        });
        void auto.commit(`${name} saved`);
    };
    const remove = async () => {
        setBusy(true);
        auto.setError('');
        try {
            onChange(await api<CodingRepositoriesView>(path, 'DELETE'));
            toast.success(`${name} removed`);
        } catch (failure) {
            auto.setError(message(failure, 'Could not remove. Retry.'));
            setBusy(false);
        }
    };
    const check = async () => {
        setBusy(true);
        try {
            setNote((await api<CodingRepositoryCheck>(`${path}/check`)).message);
        } catch (failure) {
            setNote(message(failure, 'Could not check. Retry.'));
        }
        setBusy(false);
    };
    return (
        <li className="grid gap-3 rounded-lg border p-4" data-slot="coding-repository">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h4 className="font-medium break-all">{name}</h4>
                    <SaveStatusNote status={auto.status} />
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void check()}>
                        Check GitHub App
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void remove()}>
                        Remove
                    </Button>
                </div>
            </div>
            {note && (
                <p className="text-muted-foreground" role="status">
                    {note}
                </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                    <label htmlFor={`${id}-bases`} className="font-medium">
                        Base branches
                    </label>
                    <Input
                        id={`${id}-bases`}
                        value={auto.value.bases}
                        placeholder="main"
                        spellCheck={false}
                        onChange={(event) => auto.edit({ bases: event.target.value })}
                        onBlur={commit}
                    />
                </div>
                <div className="grid gap-1.5">
                    <label htmlFor={`${id}-prefix`} className="font-medium">
                        Branch prefix
                    </label>
                    <Input
                        id={`${id}-prefix`}
                        value={auto.value.prefix}
                        spellCheck={false}
                        onChange={(event) => auto.edit({ prefix: event.target.value })}
                        onBlur={commit}
                    />
                </div>
                <div className="grid gap-1.5">
                    <label htmlFor={`${id}-users`} className="font-medium">
                        Who may use it (ids; empty: everyone on the code-access list)
                    </label>
                    <Input
                        id={`${id}-users`}
                        value={auto.value.users}
                        spellCheck={false}
                        onChange={(event) => auto.edit({ users: event.target.value })}
                        onBlur={commit}
                    />
                </div>
            </div>
            <div className="grid gap-2">
                <label className="flex items-center gap-2">
                    <Checkbox
                        checked={auto.value.push || wantPush}
                        onCheckedChange={(value) => {
                            if (value === true) {
                                setWantPush(true);
                                return;
                            }
                            setWantPush(false);
                            setConfirmed(false);
                            if (auto.value.push) {
                                void auto.change({ push: false }, `Push turned off for ${name}`, false);
                            }
                        }}
                    />
                    Sessions may push to their own branches and open draft pull requests
                </label>
                {turningPushOn && (
                    <div className="grid gap-2 rounded-lg bg-muted p-3" data-slot="push-checklist">
                        <p>Before turning push on, confirm on GitHub (Socio can’t check these):</p>
                        <ul className="list-disc pl-5">
                            {checklist.map((item) => (
                                <li key={item}>{item}</li>
                            ))}
                        </ul>
                        <label className="flex items-center gap-2">
                            <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
                            I confirmed these
                        </label>
                        <div>
                            <Button
                                type="button"
                                size="sm"
                                disabled={!confirmed || auto.status === 'saving'}
                                onClick={() => {
                                    setWantPush(false);
                                    setConfirmed(false);
                                    void auto.change({ push: true }, `Push turned on for ${name}`, false);
                                }}
                            >
                                Turn on push
                            </Button>
                        </div>
                    </div>
                )}
                <label className="flex items-center gap-2">
                    <Checkbox
                        checked={auto.value.extraction}
                        onCheckedChange={(value) =>
                            void auto.change(
                                { extraction: value === true },
                                value === true
                                    ? `Extractions turned on for ${name}`
                                    : `Extractions turned off for ${name}`,
                            )
                        }
                    />
                    Workspace apps may get approved extractions
                </label>
                <label className="flex items-center gap-2">
                    <Checkbox
                        checked={auto.value.extraction && auto.value.standing}
                        disabled={!auto.value.extraction}
                        onCheckedChange={(value) =>
                            void auto.change(
                                { standing: value === true },
                                value === true
                                    ? `Standing extraction access allowed for ${name}`
                                    : `Standing extraction access turned off for ${name}`,
                            )
                        }
                    />
                    People may give standing extraction access (up to 7 days)
                </label>
            </div>
            <SaveError error={auto.error} />
        </li>
    );
}

/** The Git proxy's limits, saved as they change (CB-308). */
function LimitsForm({
    view,
    onChange,
}: {
    view: CodingRepositoriesView;
    onChange: (view: CodingRepositoriesView) => void;
}) {
    const keys = Object.keys(LIMIT_LABELS) as Array<keyof CodingGitLimits>;
    const auto = useAutosave(
        Object.fromEntries(keys.map((key) => [key, String(view.limits[key])])) as Record<keyof CodingGitLimits, string>,
        async (values) =>
            onChange(
                await saving(
                    api<CodingRepositoriesView>(
                        '/gateway/git-limits',
                        'PUT',
                        Object.fromEntries(keys.map((key) => [key, Number(values[key])])),
                    ),
                ),
            ),
    );
    const commit = () =>
        void auto.commit('Git limits saved', (values) => {
            for (const key of keys) {
                const value = Number(values[key].trim() || NaN);
                const { min, max } = CODING_GIT_LIMIT_BOUNDS[key];
                if (!Number.isInteger(value) || value < min || value > max) {
                    return `${LIMIT_LABELS[key]}: use a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`;
                }
            }
        });
    return (
        <form
            className="grid gap-3"
            noValidate
            data-slot="coding-git-limits"
            // Enter saves too, like leaving a field.
            onSubmit={(event) => {
                event.preventDefault();
                commit();
            }}
        >
            <div className="flex items-baseline justify-between gap-3">
                <h4 className="font-medium">Limits</h4>
                <SaveStatusNote status={auto.status} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                {keys.map((key) => (
                    <div key={key} className="grid gap-1.5">
                        <label htmlFor={`coding-limit-${key}`}>{LIMIT_LABELS[key]}</label>
                        <Input
                            id={`coding-limit-${key}`}
                            type="number"
                            inputMode="numeric"
                            min={CODING_GIT_LIMIT_BOUNDS[key].min}
                            max={CODING_GIT_LIMIT_BOUNDS[key].max}
                            value={auto.value[key]}
                            onChange={(event) => auto.edit({ [key]: event.target.value })}
                            onBlur={commit}
                        />
                        <span className="text-xs text-muted-foreground">Server default {view.limitDefaults[key]}</span>
                    </div>
                ))}
            </div>
            <SaveError error={auto.error} />
        </form>
    );
}

export function CodingRepositoriesSection() {
    const [view, setView] = useState<CodingRepositoriesView>();
    const [adding, setAdding] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        api<CodingRepositoriesView>('/gateway/repositories', 'GET', undefined, controller.signal)
            // Only a repositories answer: anything else shows nothing.
            .then((next) => {
                if (Array.isArray(next?.repositories)) {
                    setView(next);
                }
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    if (!view) {
        return null;
    }
    const add = async () => {
        const name = adding.trim();
        if (!validCodingRepository(name)) {
            setError('Name the repository as owner/name, such as acme/app.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            setView(await api<CodingRepositoriesView>(`/gateway/repositories/${name}`, 'PUT', {}));
            setAdding('');
        } catch (failure) {
            setError(message(failure, 'Could not add. Retry.'));
        }
        setBusy(false);
    };
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="coding-repositories">
                <div className="grid gap-1">
                    <h3 className="font-medium">Repositories</h3>
                    <p className="text-muted-foreground">
                        The GitHub repositories socios may work on in coding sessions, and copy parts of for workspace
                        apps, through the GitHub App connected under General → GitHub App. The App must be installed on
                        each one’s owner. Sessions push only to their own branches, after Socio checks every commit;
                        nothing reaches the base branches.
                    </p>
                </div>
                <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void add();
                    }}
                >
                    <div className="grid min-w-0 flex-1 gap-1.5">
                        <label htmlFor="coding-repository-add" className="font-medium">
                            Add a repository
                        </label>
                        <Input
                            id="coding-repository-add"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={141}
                            placeholder="owner/name"
                            value={adding}
                            onChange={(event) => setAdding(event.target.value)}
                        />
                    </div>
                    {/* An action, not a setting: it adds a repository to the list. */}
                    <Button disabled={busy}>Add repository</Button>
                </form>
                {error && (
                    <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                        {error}
                    </p>
                )}
                {view.repositories.length ? (
                    <ul className="grid gap-3">
                        {view.repositories.map((repository) => (
                            <RepositoryCard
                                // Saved changes come in through the props (useAutosave
                                // follows them).
                                key={repository.repository}
                                repository={repository}
                                checklist={view.checklist}
                                onChange={setView}
                            />
                        ))}
                    </ul>
                ) : (
                    <p className="text-muted-foreground">No repositories yet.</p>
                )}
                <LimitsForm view={view} onChange={setView} />
            </section>
        </SettingsCard>
    );
}
