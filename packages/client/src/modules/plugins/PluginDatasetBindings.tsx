import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import type {
    PluginBindingChoice,
    PluginBindingChoices,
    PluginBindingPlan,
    PluginNeedPlan,
} from '@socio/shared/plugins/bindings';

import { dialogSelect, nativeSelect } from '../../components/form-fields';
import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';

import { failed } from './plugin-rows';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * Binding a plugin's dataset needs to workspace datasets (CB-451): at
 * install (`PluginInstallDialog`) and later on the plugin's page
 * (`PluginDatasetsSection`). A `write` need gets a new dataset or an
 * existing one nobody else writes; a `read` need an existing one whose
 * columns fit, or **Not now**. The server checks every choice again.
 * Their words are plugins.bindings': a plugin's page inlines them, and the
 * install dialog loads them on demand.
 */

const NEW = 'new';
const NONE = 'none';

/** A choice as a `<select>` value, and back. */
const valueOf = (choice: PluginBindingChoice) => (choice === null ? NONE : choice === 'new' ? NEW : choice.datasetId);
const choiceOf = (value: string): PluginBindingChoice =>
    value === NONE ? null : value === NEW ? 'new' : { datasetId: value };

/** Whether installing asks the admin anything: a need with explicit access, or one with data from before. */
export const bindingsNeedAsking = (plan: PluginBindingPlan) =>
    plan.needs.some((need) => !need.implicit || need.previous);

function NeedField({
    need,
    value,
    onChange,
    select,
    disabled,
}: {
    need: PluginNeedPlan;
    value: string;
    onChange: (value: string) => void;
    select: string;
    disabled?: boolean;
}) {
    const { t } = useTranslation(['plugins.bindings']);
    const id = `plugin-need-${need.need}`;
    const chosen = need.candidates.find((candidate) => candidate.id === value);
    const columns = need.tables
        .map((table) =>
            t('plugins.bindings:table', { table: table.table, columns: table.columns.map((column) => column.name) }),
        )
        .join('; ');
    return (
        <div className="grid gap-1.5" data-slot="plugin-need" data-need={need.need}>
            <label htmlFor={id} className="font-medium">
                {need.need}{' '}
                <span className="font-normal text-muted-foreground">
                    · {need.access === 'write' ? t('plugins.bindings:writes') : t('plugins.bindings:reads')}
                </span>
            </label>
            {need.description && <p className="text-muted-foreground">{need.description}</p>}
            {columns && <p className="text-xs text-muted-foreground">{t('plugins.bindings:expects', { columns })}</p>}
            <select
                id={id}
                data-slot="native-select"
                className={select}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value)}
            >
                {need.access === 'write' ? (
                    <option value={NEW}>{t('plugins.bindings:new')}</option>
                ) : (
                    <option value={NONE}>{t('plugins.bindings:not-now')}</option>
                )}
                {need.bound && (
                    <option value={need.bound.datasetId}>
                        {t('plugins.bindings:bound-now', { name: need.bound.datasetName })}
                    </option>
                )}
                {need.candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id} disabled={!!candidate.problem}>
                        {[
                            candidate.id === need.previous?.datasetId
                                ? t('plugins.bindings:used-before', { name: candidate.name })
                                : candidate.name,
                            candidate.writer ? t('plugins.bindings:written-by', { name: candidate.writer.name }) : '',
                            candidate.problem ? t('plugins.bindings:does-not-fit') : '',
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    </option>
                ))}
            </select>
            {chosen?.problem && <p className="text-xs text-destructive">{chosen.problem}</p>}
            {need.candidates.some((candidate) => candidate.problem) && (
                <details className="text-xs text-muted-foreground">
                    <summary>{t('plugins.bindings:why')}</summary>
                    <ul className="mt-1 grid gap-1">
                        {need.candidates
                            .filter((candidate) => candidate.problem)
                            .map((candidate) => (
                                <li key={candidate.id}>
                                    <Trans
                                        t={t}
                                        i18nKey="plugins.bindings:problem"
                                        values={{ name: candidate.name, problem: candidate.problem ?? '' }}
                                        components={{ name: <strong /> }}
                                    />
                                </li>
                            ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

/**
 * Install with the admin's bindings: one field per need, each preselected
 * as the server suggests (the dataset it used before, when it fits).
 */
function PluginInstallForm({
    name,
    plan,
    onClose,
    onInstall,
}: {
    name: string;
    plan: PluginBindingPlan;
    onClose: () => void;
    onInstall: (bindings: PluginBindingChoices) => Promise<void>;
}) {
    const { t } = useTranslation(['plugins.bindings']);
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(plan.needs.map((need) => [need.need, valueOf(need.preselected)])),
    );
    const [busy, setBusy] = useState(false);
    const install = async () => {
        setBusy(true);
        try {
            await onInstall(Object.fromEntries(Object.entries(values).map(([need, value]) => [need, choiceOf(value)])));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="plugin-install-bindings">
                <DialogHeader>
                    <DialogTitle>{t('plugins.bindings:install.title', { name })}</DialogTitle>
                    <DialogDescription>{t('plugins.bindings:install.description')}</DialogDescription>
                </DialogHeader>
                <form
                    className="grid gap-4 text-sm"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void install();
                    }}
                >
                    {plan.needs.map((need) => (
                        <NeedField
                            key={need.need}
                            need={need}
                            value={values[need.need] ?? NEW}
                            select={dialogSelect}
                            disabled={busy}
                            onChange={(value) => setValues((now) => ({ ...now, [need.need]: value }))}
                        />
                    ))}
                </form>
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={onClose}>
                        {t('plugins.bindings:install.cancel')}
                    </Button>
                    <Button disabled={busy} onClick={() => void install()}>
                        {busy ? t('plugins.bindings:install.installing') : t('plugins.bindings:install.install')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Install with the admin's bindings (`PluginInstallForm`), once its words are in. */
export const PluginInstallDialog = onDemand(['plugins.bindings'], PluginInstallForm);

/**
 * The plugin page's **Datasets** section: each need, the dataset it is
 * bound to, and a change of it (another dataset, a new one, or unbinding a
 * read need), saved at once.
 */
export function PluginDatasetsSection({ pluginId }: { pluginId: string }) {
    const { t } = useTranslation(['plugins.bindings']);
    // The latest t, for callbacks and effects that shouldn't run again when the language changes.
    const latestT = useRef(t);
    latestT.current = t;
    const [plan, setPlan] = useState<PluginBindingPlan>();
    const [busy, setBusy] = useState<string>();
    const load = useCallback(
        () =>
            api<PluginBindingPlan>(`/plugins/${pluginId}/bindings`)
                .then(setPlan)
                .catch((error) => failed(error, latestT.current('plugins.bindings:load-failed'))),
        [pluginId],
    );
    useEffect(() => void load(), [load]);
    // A plan of another shape (an older server) shows nothing.
    if (!Array.isArray(plan?.needs)) {
        return null;
    }
    if (!plan.needs.length) {
        return <p className="text-muted-foreground">{t('plugins.bindings:none')}</p>;
    }
    const change = async (need: PluginNeedPlan, value: string) => {
        setBusy(need.need);
        try {
            await api(`/plugins/${pluginId}/bindings/${encodeURIComponent(need.need)}`, 'PUT', {
                choice: choiceOf(value),
            });
            toast.success(
                value === NONE
                    ? t('plugins.bindings:unbound', { need: need.need })
                    : t('plugins.bindings:bound', { need: need.need }),
            );
        } catch (error) {
            failed(error, t('plugins.bindings:change-failed'));
        } finally {
            setBusy(undefined);
            await load();
        }
    };
    return (
        <div className="grid gap-4" data-slot="plugin-datasets">
            {plan.needs.map((need) => (
                <div key={need.need} className="grid gap-1">
                    <NeedField
                        need={need}
                        value={need.bound ? need.bound.datasetId : need.access === 'write' ? NEW : NONE}
                        select={`${nativeSelect} w-full max-w-md`}
                        disabled={busy !== undefined}
                        onChange={(value) => void change(need, value)}
                    />
                    <p className="text-xs text-muted-foreground" data-slot="plugin-need-state">
                        {need.bound
                            ? t('plugins.bindings:state.bound', {
                                  name: need.bound.datasetName,
                                  context: need.access === 'read' ? 'read' : 'write',
                              })
                            : t('plugins.bindings:state.unbound')}
                    </p>
                </div>
            ))}
        </div>
    );
}
