import { useEffect, useState } from 'react';

import {
    CODING_RETENTION_DAYS,
    type CodingSandboxSettingsInput,
    type CodingSandboxSettingsView,
} from '@socio/shared/coding/coding-sessions';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from '../settings/autosave';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * Settings → Coding → Sandboxes (CB-239), for admins: the package
 * registries a coding sandbox may read (download only, over
 * `CODING_EGRESS_ALLOW`) and how long an unused workspace is kept (over
 * `CODING_WORKSPACE_RETENTION_DAYS`). Each shows the server's default and
 * can go back to it. The server answers 404 while the flag
 * `coding-sessions` is off for the admin; then nothing shows.
 */

const lines = (registries: string) => registries.split(' ').join('\n');

const failure = (error: unknown) => (error instanceof Error ? error.message : 'Could not save. Retry.');

export function CodingSandboxSection() {
    const [view, setView] = useState<CodingSandboxSettingsView>();
    useEffect(() => {
        const controller = new AbortController();
        api<CodingSandboxSettingsView>('/gateway/sandbox', 'GET', undefined, controller.signal)
            // Only a settings answer: anything else shows nothing.
            .then((next) => {
                if (typeof next?.registries === 'string') {
                    setView(next);
                }
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    if (!view) {
        return null;
    }
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="coding-sandbox">
                {/* Saved values come in through the props (useAutosave follows them). */}
                <SandboxForm view={view} onChange={setView} />
            </section>
        </SettingsCard>
    );
}

/** One `name=host` a line, as the field shows them. */
const normalLines = (text: string) => text.split(/\s+/).filter(Boolean).join('\n');

/**
 * Saved as they change (CB-308), each field when it loses focus.
 * `registriesSet` and `daysSet`: saved here, over the server's default;
 * Undo of a first change goes back to the default rather than saving it.
 */
function SandboxForm({
    view,
    onChange,
}: {
    view: CodingSandboxSettingsView;
    onChange: (view: CodingSandboxSettingsView) => void;
}) {
    const auto = useAutosave(
        {
            registries: lines(view.registries),
            registriesSet: view.registriesSaved,
            days: String(view.retentionDays),
            daysSet: view.retentionDaysSaved,
        },
        async (values) => {
            const input: CodingSandboxSettingsInput = {
                registries: values.registriesSet ? values.registries.split(/\s+/).filter(Boolean).join(' ') : null,
                retentionDays: values.daysSet ? Number(values.days) : null,
            };
            try {
                onChange(await api<CodingSandboxSettingsView>('/gateway/sandbox', 'PUT', input));
            } catch (problem) {
                throw new Error(failure(problem));
            }
        },
    );
    const busy = auto.status === 'saving';
    const commit = () => {
        const saved = auto.saved();
        const registries = normalLines(auto.value.registries);
        const days = auto.value.days.trim();
        auto.edit({
            registries,
            registriesSet: registries === saved.registries ? saved.registriesSet : true,
            days,
            daysSet: days === saved.days ? saved.daysSet : true,
        });
        void auto.commit(
            (next, previous) =>
                next.days !== previous.days ? 'Workspace retention saved' : 'Package registries saved',
            (value) => {
                const days = Number(value.days || NaN);
                const { min, max } = CODING_RETENTION_DAYS;
                if (!Number.isInteger(days) || days < min || days > max) {
                    return `Keep workspaces ${min} to ${max} days.`;
                }
            },
        );
    };
    return (
        <form
            className="grid gap-4"
            noValidate
            // Enter in the days saves too, like leaving the field.
            onSubmit={(event) => {
                event.preventDefault();
                commit();
            }}
        >
            <AutosaveHeader title="Sandboxes" status={auto.status}>
                What a coding session’s sandbox can reach besides Socio, and how long a person’s workspace is kept
                between sessions. Changes apply to sandboxes started after them.
            </AutosaveHeader>
            <div className="grid gap-1.5">
                <label htmlFor="coding-registries" className="font-medium">
                    Package registries
                </label>
                <Textarea
                    id="coding-registries"
                    rows={4}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono"
                    aria-describedby="coding-registries-help"
                    value={auto.value.registries}
                    onChange={(event) => auto.edit({ registries: event.target.value })}
                    onBlur={commit}
                />
                <span id="coding-registries-help" className="text-xs text-muted-foreground">
                    One <code>name=host</code> per line: the sandbox reads <code>host</code> as{' '}
                    <code>name.registry.socio.internal</code>, download only, without credentials. Server default:{' '}
                    <span className="font-mono [overflow-wrap:anywhere]">{view.registriesDefault}</span>
                    {view.registriesSaved ? '' : ' (in use)'}.
                </span>
                {view.registriesSaved && (
                    <div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void auto.change({ registriesSet: false }, 'Registries back to default')}
                        >
                            Use the server default
                        </Button>
                    </div>
                )}
            </div>
            <div className="grid gap-1.5">
                <label htmlFor="coding-retention" className="font-medium">
                    Keep unused workspaces for (days)
                </label>
                <Input
                    id="coding-retention"
                    type="number"
                    inputMode="numeric"
                    min={CODING_RETENTION_DAYS.min}
                    max={CODING_RETENTION_DAYS.max}
                    className="max-w-40"
                    aria-describedby="coding-retention-help"
                    value={auto.value.days}
                    onChange={(event) => auto.edit({ days: event.target.value })}
                    onBlur={commit}
                />
                <span id="coding-retention-help" className="text-xs text-muted-foreground">
                    A person’s workspace for a socio and repository is removed after this long unused, and at once when
                    they are deactivated, the socio is archived or the repository leaves the list. Server default{' '}
                    {view.retentionDaysDefault}
                    {view.retentionDaysSaved ? '' : ' (in use)'}.
                </span>
                {view.retentionDaysSaved && (
                    <div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void auto.change({ daysSet: false }, 'Retention back to default')}
                        >
                            Use the server default
                        </Button>
                    </div>
                )}
            </div>
            <SaveError error={auto.error} />
        </form>
    );
}
