import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    FLAG_PAGE_STAGE,
    type FlagAdminView,
    type FlagEvaluation,
    type FlagPage,
    type FlagRule,
    type FlagRuleInput,
    type FlagsAdminState,
} from '@socio/shared/flags';
import { normalizeRole, ROLES } from '@socio/shared/roles';
import type { Role } from '@socio/shared/types';

import { api } from '../../lib/api';
import { EarlyAccessBadge } from '../../shell/flags';
import { useShell } from '../../shell/shell-context';
import { UpstreamIssueLink } from '../whats-new/UpstreamIssueLink';

import { SettingsCard, nativeSelect } from './AccountSettings';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/**
 * The roles these pages offer and name (CB-503): no role above admin. A
 * stored rule's other roles are kept as they are, unnamed.
 */
export const PAGE_ROLES: readonly Role[] = ROLES; // CB-390: `operator` is no longer a role.

/** Lists longer than this get a search box. */
export const SEARCH_FROM = 6;

type Mode = 'inherit' | 'on' | 'off' | 'some';
const modeOf = (rule: FlagRule | undefined): Mode =>
    !rule ? 'inherit' : rule.enabled ? 'on' : rule.roles.length || rule.people.length ? 'some' : 'off';

/**
 * A flag's words, for its card: its values and where they come from, who
 * a rule turns it on for, and what this server's configuration says.
 */
function useFlagWords() {
    const { t } = useTranslation(['settings.features']);
    /**
     * "On for everyone, by …" for a flag's value. Everything above the
     * workspace's rule is this server's configuration: the page names no
     * role and offers no control for it (CB-503).
     */
    const valueLine = (value: FlagEvaluation, who: 'everyone' | 'you') => {
        const source = t(`settings.features:sources.${value.source}`);
        const context = value.enabled ? 'on' : undefined;
        return who === 'everyone'
            ? t('settings.features:value.everyone', { source, context })
            : t('settings.features:value.you', { source, context });
    };
    /** Who a rule turns a flag on for, in words. */
    const targetsLine = (rule: FlagRule, people: FlagsAdminState['people']) => {
        if (rule.enabled) {
            return t('settings.features:targets.everyone');
        }
        const names = new Map(people.map((person) => [person.id, person.name]));
        const named = rule.roles.filter((role) => PAGE_ROLES.includes(role));
        const who = [
            ...named.map((role) => t(`settings.features:roles.${normalizeRole(role)}`)),
            ...rule.people.map((id) => names.get(id) ?? t('settings.features:targets.gone')),
        ];
        // A role these pages don't name still counts: say that someone else has it.
        if (named.length < rule.roles.length) {
            who.push(who.length ? t('settings.features:targets.others') : t('settings.features:targets.somePeople'));
        }
        return who.length ? t('settings.features:targets.only', { who }) : t('settings.features:targets.nobody');
    };
    /**
     * What this server's configuration says about a flag, read-only: its
     * FEATURE_FLAGS value, a stored server rule (and whether admins may
     * change it), and the workspace's plan. Null when it says nothing.
     */
    const serverLine = (flag: FlagAdminView, state: FlagsAdminState): string | null => {
        const parts: string[] = [];
        if (flag.env !== undefined) {
            parts.push(flag.env ? t('settings.features:server.envOn') : t('settings.features:server.envOff'));
        }
        if (flag.instance) {
            const targets = targetsLine(flag.instance, state.people);
            parts.push(flag.instance.locked ? t('settings.features:server.locked', { targets }) : targets);
        }
        if (flag.tier !== undefined) {
            const plan =
                state.tiers.find((tier) => tier.id === state.tierId)?.name ?? t('settings.features:server.plan');
            parts.push(
                flag.tier
                    ? t('settings.features:server.tierIn', { plan })
                    : t('settings.features:server.tierOut', { plan }),
            );
        }
        if (!parts.length) {
            return null;
        }
        const joined = parts.reduceRight((next, first) => t('settings.features:server.join', { first, next }));
        return t('settings.features:server.line', { parts: joined });
    };
    return { valueLine, serverLine };
}

/**
 * The workspace rule's editor: follow the layer below, on or off for
 * everyone, or on for some roles and people only.
 */
function RuleEditor({
    rule,
    people,
    onSave,
    onClear,
}: {
    rule: FlagRule | undefined;
    people: FlagsAdminState['people'];
    onSave: (input: FlagRuleInput) => Promise<void>;
    onClear: () => Promise<void>;
}) {
    const { t } = useTranslation(['settings.features']);
    const id = useId();
    const label = t('settings.features:rule.label');
    const [mode, setMode] = useState<Mode>(modeOf(rule));
    const [roles, setRoles] = useState<Role[]>(rule?.roles ?? []);
    const [chosen, setChosen] = useState<string[]>(rule?.people ?? []);
    const [busy, setBusy] = useState(false);
    const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
    const save = async () => {
        setBusy(true);
        try {
            if (mode === 'inherit') {
                await onClear();
            } else {
                await onSave({
                    enabled: mode === 'on',
                    roles: mode === 'some' ? roles : [],
                    people: mode === 'some' ? chosen : [],
                });
            }
        } finally {
            setBusy(false);
        }
    };
    return (
        <fieldset className="grid gap-2 rounded-md border p-3" data-slot="flag-rule" aria-label={label}>
            <legend className="px-1 text-xs font-medium text-muted-foreground">{label}</legend>
            <label htmlFor={`${id}-mode`} className="sr-only">
                {t('settings.features:rule.who')}
            </label>
            <select
                id={`${id}-mode`}
                className={`${nativeSelect} w-full sm:w-fit`}
                value={mode}
                onChange={(event) => setMode(event.target.value as Mode)}
            >
                <option value="inherit">{t('settings.features:rule.inherit')}</option>
                <option value="on">{t('settings.features:rule.on')}</option>
                <option value="off">{t('settings.features:rule.off')}</option>
                <option value="some">{t('settings.features:rule.some')}</option>
            </select>
            {mode === 'some' && (
                <div className="grid gap-2">
                    {roles.some((role) => !PAGE_ROLES.includes(role)) && (
                        <p className="text-xs text-muted-foreground" data-slot="flag-rule-others">
                            {t('settings.features:rule.others')}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {PAGE_ROLES.map((role) => (
                            <label key={role} className="flex items-center gap-1.5">
                                <input
                                    type="checkbox"
                                    className="size-4"
                                    checked={roles.includes(role)}
                                    onChange={() => setRoles(toggle(roles, role))}
                                />
                                {t(`settings.features:roles.${normalizeRole(role)}`)}
                            </label>
                        ))}
                    </div>
                    <div
                        className="grid max-h-40 gap-1 overflow-y-auto rounded border p-2"
                        role="group"
                        aria-label={t('settings.features:rule.people')}
                    >
                        {people.map((person) => (
                            <label key={person.id} className="flex items-center gap-1.5">
                                <input
                                    type="checkbox"
                                    className="size-4"
                                    checked={chosen.includes(person.id)}
                                    onChange={() => setChosen(toggle(chosen, person.id))}
                                />
                                <span className="min-w-0 break-words">{person.name}</span>
                            </label>
                        ))}
                    </div>
                </div>
            )}
            <Button size="sm" className="w-fit" disabled={busy} onClick={() => void save()}>
                {t('settings.features:rule.save')}
            </Button>
        </fieldset>
    );
}

function FlagCard({
    flag,
    state,
    reload,
}: {
    flag: FlagAdminView;
    state: FlagsAdminState;
    reload: () => Promise<unknown>;
}) {
    const { t } = useTranslation(['settings', 'settings.features']);
    const { valueLine, serverLine } = useFlagWords();
    const path = `/flags/${encodeURIComponent(flag.key)}/workspace`;
    const save = async (input: FlagRuleInput) => {
        try {
            await api(path, 'PUT', input);
            toast.success(t('settings.features:flag.saved', { flag: flag.title }));
            await reload();
        } catch (e) {
            failed(e, t('settings.features:flag.saveFailed'));
        }
    };
    const clear = async () => {
        try {
            await api(path, 'DELETE');
            toast.success(t('settings.features:flag.cleared', { flag: flag.title }));
            await reload();
        } catch (e) {
            failed(e, t('settings.features:flag.saveFailed'));
        }
    };
    const server = serverLine(flag, state);
    return (
        <li className="grid gap-2 rounded-lg border p-3" data-slot="flag" data-key={flag.key} data-stage={flag.stage}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h4 className="font-medium break-words">{flag.title}</h4>
                {flag.stage === 'early-access' && (
                    <>
                        <EarlyAccessBadge />
                        <Badge variant="secondary" data-slot="flag-experimental">
                            {t('settings.features:flag.experimental')}
                        </Badge>
                    </>
                )}
                {flag.stage === 'dev' && <Badge variant="secondary">{t('settings:sections.features-dev')}</Badge>}
            </div>
            <p className="text-muted-foreground break-words">{flag.description}</p>
            <p className="text-xs text-muted-foreground" data-slot="flag-values">
                {valueLine(flag.everyone, 'everyone')} {valueLine(flag.you, 'you')}
            </p>
            {server && (
                <p className="text-xs text-muted-foreground" data-slot="flag-server">
                    {server}
                </p>
            )}
            {flag.workspaceBlocked ? (
                <p className="text-muted-foreground" data-slot="flag-blocked">
                    {flag.workspaceBlocked}
                </p>
            ) : (
                <RuleEditor
                    key={`workspace-${flag.workspace?.updatedAt ?? 0}`}
                    rule={flag.workspace}
                    people={state.people}
                    onSave={save}
                    onClear={clear}
                />
            )}
            <details className="text-xs text-muted-foreground" data-slot="flag-details">
                <summary className="cursor-pointer">{t('settings.features:flag.details')}</summary>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    <dt>{t('settings.features:flag.key')}</dt>
                    <dd>
                        <code>{flag.key}</code>
                    </dd>
                    {flag.issue && (
                        <>
                            <dt>{t('settings.features:flag.issue')}</dt>
                            <dd>
                                <UpstreamIssueLink issue={flag.issue} />
                            </dd>
                        </>
                    )}
                    <dt>{t('settings.features:flag.owner')}</dt>
                    <dd>{flag.owner}</dd>
                    <dt>{t('settings.features:flag.removeBy')}</dt>
                    <dd>{flag.removeBy}</dd>
                    {flag.tools.length > 0 && (
                        <>
                            <dt>{t('settings.features:flag.tools')}</dt>
                            <dd>{t('settings.features:flag.toolList', { tools: flag.tools })}</dd>
                        </>
                    )}
                </dl>
            </details>
        </li>
    );
}

const matches = (flag: FlagAdminView, query: string) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const text = `${flag.title} ${flag.description} ${flag.key}`.toLowerCase();
    return words.every((word) => text.includes(word));
};

/**
 * Settings → Workspace → Optional features, Early access and In
 * development (CB-169, CB-182, CB-503), for admins: the flags of one stage, each with its value
 * for the workspace and for them and where it comes from, what this
 * server's configuration decides (read-only), the workspace's rule, and
 * the recent changes. Flags in development have a page of their own, in
 * an internal deployment only.
 */
export function FeaturesSection({ page = 'features' }: { page?: FlagPage }) {
    const { t } = useTranslation(['settings', 'settings.features']);
    const auditLine = useAuditLine();
    const shell = useShell();
    const searchId = useId();
    const [state, setState] = useState<FlagsAdminState>();
    const [query, setQuery] = useState('');
    const load = useCallback(
        () =>
            api<FlagsAdminState>('/flags')
                .then(setState)
                .catch((e) => failed(e, t('settings.features:loadFailed'))),
        [t],
    );
    const reload = useCallback(() => Promise.all([load(), shell.refresh()]), [load, shell]);
    useEffect(() => void load(), [load]);
    const stage = FLAG_PAGE_STAGE[page];
    const listed = useMemo(() => state?.flags.filter((flag) => flag.stage === stage) ?? [], [state, stage]);
    if (!state) {
        return (
            <SettingsCard>
                <p className="text-muted-foreground">{t('settings.features:loading')}</p>
            </SettingsCard>
        );
    }
    const title = t(`settings:sections.${page}`);
    const shown = query.trim() ? listed.filter((flag) => matches(flag, query)) : listed;
    const keys = new Set(listed.map((flag) => flag.key));
    const audit = state.audit.filter((line) => line.targetKind === 'feature_flag' && keys.has(line.targetId));
    return (
        <>
            <SettingsCard>
                <section className="grid gap-3" data-slot="features" data-page={page}>
                    <div className="grid gap-1">
                        <h3 className="font-medium">{title}</h3>
                        <p className="text-muted-foreground">
                            {t(`settings.features:pages.${page}.intro`)} {t('settings.features:applies')}
                        </p>
                    </div>
                    {listed.length > SEARCH_FROM && (
                        <div className="grid gap-1">
                            <label htmlFor={searchId} className="sr-only">
                                {t(`settings.features:pages.${page}.search`)}
                            </label>
                            <Input
                                id={searchId}
                                type="search"
                                data-slot="features-search"
                                placeholder={t('settings.features:search')}
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </div>
                    )}
                    {listed.length === 0 ? (
                        <p className="text-muted-foreground" data-slot="features-empty">
                            {t(`settings.features:pages.${page}.empty`)}
                        </p>
                    ) : shown.length === 0 ? (
                        <p className="text-muted-foreground" data-slot="features-no-match">
                            {t('settings.features:noMatch', { query: query.trim() })}
                        </p>
                    ) : (
                        <ul className="grid gap-3">
                            {shown.map((flag) => (
                                <FlagCard key={flag.key} flag={flag} state={state} reload={reload} />
                            ))}
                        </ul>
                    )}
                </section>
            </SettingsCard>
            <SettingsCard>
                <section className="grid gap-2" data-slot="flag-audit">
                    <h3 className="font-medium">{t('settings.features:audit.title')}</h3>
                    {audit.length === 0 ? (
                        <p className="text-muted-foreground">{t('settings.features:audit.none')}</p>
                    ) : (
                        <ol className="grid gap-1 text-xs">
                            {audit.map((line, index) => (
                                <li key={index} className="break-words">
                                    <span className="text-muted-foreground">
                                        {t('settings.features:audit.when', { when: new Date(line.createdAt) })}
                                    </span>{' '}
                                    {auditLine(line)}
                                </li>
                            ))}
                        </ol>
                    )}
                </section>
            </SettingsCard>
        </>
    );
}

/**
 * An audit line in the page's words. A workspace rule's change names the
 * admin; a server-level change names no one (CB-503), and a retired
 * personal choice says so.
 */
export function useAuditLine() {
    const { t } = useTranslation(['settings.features']);
    return (line: FlagsAdminState['audit'][number]) => {
        const values = {
            actor: line.actorName,
            flag: line.targetId,
            context: line.action === 'remove' ? 'remove' : undefined,
        };
        let scope: string | undefined;
        try {
            scope = (JSON.parse(line.detail) as { scope?: string }).scope;
        } catch {
            scope = undefined;
        }
        if (scope === 'workspace') {
            return t('settings.features:audit.workspace', values);
        }
        if (scope === 'person') {
            return t('settings.features:audit.person', values);
        }
        return t('settings.features:audit.server', values);
    };
}
