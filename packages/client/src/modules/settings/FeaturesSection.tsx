import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
    FLAG_PAGE_STAGE,
    FLAG_STAGE_LABELS,
    type FlagAdminView,
    type FlagEvaluation,
    type FlagPage,
    type FlagRule,
    type FlagRuleInput,
    type FlagSource,
    type FlagsAdminState,
} from '@socio/shared/flags';
import { ROLES, roleLabel } from '@socio/shared/roles';
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
const when = (at: number) => new Date(at).toLocaleString();

/**
 * Where a value comes from, as the evaluator decided it. Everything above
 * the workspace's rule is this server's configuration: the page names no
 * role and offers no control for it (CB-503).
 */
const SOURCES: Record<FlagSource, string> = {
    deployment: 'this deployment',
    default: 'its default',
    env: 'this server’s configuration',
    instance: 'this server’s configuration',
    tier: 'this server’s configuration (the workspace’s plan)',
    workspace: 'this workspace’s rule',
};

/** "On for everyone, by …" for a flag's value. */
const valueLine = (value: FlagEvaluation, who: string) =>
    `${value.enabled ? 'On' : 'Off'} ${who}, by ${SOURCES[value.source]}.`;

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

/** Who a rule turns a flag on for, in words. */
const targetsLine = (rule: FlagRule, people: FlagsAdminState['people']) => {
    if (rule.enabled) {
        return 'on for everyone';
    }
    const names = new Map(people.map((person) => [person.id, person.name]));
    const named = rule.roles.filter((role) => PAGE_ROLES.includes(role));
    const who = [
        ...named.map((role) => `${roleLabel(role)}s`),
        ...rule.people.map((id) => names.get(id) ?? 'someone no longer here'),
    ];
    // A role these pages don't name still counts: say that someone else has it.
    if (named.length < rule.roles.length) {
        who.push(who.length ? 'some others' : 'some people');
    }
    return who.length ? `on for ${who.join(', ')} only` : 'off for everyone';
};

/**
 * What this server's configuration says about a flag, read-only: its
 * FEATURE_FLAGS value, a stored server rule (and whether admins may change
 * it), and the workspace's plan. Null when it says nothing.
 */
export function serverLine(flag: FlagAdminView, state: FlagsAdminState): string | null {
    const parts: string[] = [];
    if (flag.env !== undefined) {
        parts.push(`${flag.env ? 'on' : 'off'} by default`);
    }
    if (flag.instance) {
        parts.push(
            `${targetsLine(flag.instance, state.people)}${flag.instance.locked ? ', and admins can’t change it' : ''}`,
        );
    }
    if (flag.tier !== undefined) {
        const plan = state.tiers.find((tier) => tier.id === state.tierId)?.name ?? 'its plan';
        parts.push(flag.tier ? `included in the ${plan} plan` : `not part of the ${plan} plan`);
    }
    return parts.length ? `Set by this server’s configuration: ${parts.join('; ')}.` : null;
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
    const id = useId();
    const label = 'This workspace';
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
                {label}: who has it
            </label>
            <select
                id={`${id}-mode`}
                className={`${nativeSelect} w-full sm:w-fit`}
                value={mode}
                onChange={(event) => setMode(event.target.value as Mode)}
            >
                <option value="inherit">No workspace rule</option>
                <option value="on">On for everyone</option>
                <option value="off">Off for everyone</option>
                <option value="some">On for some roles and people</option>
            </select>
            {mode === 'some' && (
                <div className="grid gap-2">
                    {roles.some((role) => !PAGE_ROLES.includes(role)) && (
                        <p className="text-xs text-muted-foreground" data-slot="flag-rule-others">
                            This rule also includes some others, and keeps them when you save. Choose On for everyone,
                            Off for everyone or No workspace rule to replace it.
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
                                {roleLabel(role)}s
                            </label>
                        ))}
                    </div>
                    <div
                        className="grid max-h-40 gap-1 overflow-y-auto rounded border p-2"
                        role="group"
                        aria-label="People"
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
                Save
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
    const path = `/flags/${encodeURIComponent(flag.key)}/workspace`;
    const save = async (input: FlagRuleInput) => {
        try {
            await api(path, 'PUT', input);
            toast.success(`${flag.title} saved`);
            await reload();
        } catch (e) {
            failed(e, 'Could not save.');
        }
    };
    const clear = async () => {
        try {
            await api(path, 'DELETE');
            toast.success(`${flag.title}: the workspace rule is cleared`);
            await reload();
        } catch (e) {
            failed(e, 'Could not save.');
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
                            Experimental
                        </Badge>
                    </>
                )}
                {flag.stage === 'dev' && <Badge variant="secondary">{FLAG_STAGE_LABELS.dev}</Badge>}
            </div>
            <p className="text-muted-foreground break-words">{flag.description}</p>
            <p className="text-xs text-muted-foreground" data-slot="flag-values">
                {valueLine(flag.everyone, 'for everyone')} {valueLine(flag.you, 'for you')}
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
                <summary className="cursor-pointer">Details</summary>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    <dt>Key</dt>
                    <dd>
                        <code>{flag.key}</code>
                    </dd>
                    {flag.issue && (
                        <>
                            <dt>Board item</dt>
                            <dd>
                                <UpstreamIssueLink issue={flag.issue} />
                            </dd>
                        </>
                    )}
                    <dt>Owner</dt>
                    <dd>{flag.owner}</dd>
                    <dt>Remove by</dt>
                    <dd>{flag.removeBy}</dd>
                    {flag.tools.length > 0 && (
                        <>
                            <dt>Socio tools</dt>
                            <dd>{flag.tools.join(', ')}</dd>
                        </>
                    )}
                </dl>
            </details>
        </li>
    );
}

const PAGES: Record<FlagPage, { title: string; intro: string; empty: string }> = {
    features: {
        title: 'Optional features',
        intro: 'Released features this workspace may switch off, or keep for some roles and people only.',
        empty: 'No optional features right now.',
    },
    'features-dev': {
        title: 'In development',
        intro: 'Unfinished features, listed only because this is an internal deployment. Customer deployments never have them on.',
        empty: 'Nothing in development right now.',
    },
    'early-access': {
        title: 'Early access',
        intro: 'Experimental features, ready to try before they are released. They may change or go away. Turn one on for the workspace, or for some roles and people only: people can’t turn them on for themselves.',
        empty: 'Nothing in early access right now.',
    },
};

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
    const shell = useShell();
    const searchId = useId();
    const [state, setState] = useState<FlagsAdminState>();
    const [query, setQuery] = useState('');
    const load = useCallback(
        () =>
            api<FlagsAdminState>('/flags')
                .then(setState)
                .catch((e) => failed(e, 'Could not load features.')),
        [],
    );
    const reload = useCallback(() => Promise.all([load(), shell.refresh()]), [load, shell]);
    useEffect(() => void load(), [load]);
    const stage = FLAG_PAGE_STAGE[page];
    const listed = useMemo(() => state?.flags.filter((flag) => flag.stage === stage) ?? [], [state, stage]);
    if (!state) {
        return (
            <SettingsCard>
                <p className="text-muted-foreground">Loading…</p>
            </SettingsCard>
        );
    }
    const { title, intro, empty } = PAGES[page];
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
                            {intro} Changes apply on their next request and their socios’ next turn.
                        </p>
                    </div>
                    {listed.length > SEARCH_FROM && (
                        <div className="grid gap-1">
                            <label htmlFor={searchId} className="sr-only">
                                Search {title.toLowerCase()}
                            </label>
                            <Input
                                id={searchId}
                                type="search"
                                data-slot="features-search"
                                placeholder="Search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </div>
                    )}
                    {listed.length === 0 ? (
                        <p className="text-muted-foreground" data-slot="features-empty">
                            {empty}
                        </p>
                    ) : shown.length === 0 ? (
                        <p className="text-muted-foreground" data-slot="features-no-match">
                            Nothing matches “{query.trim()}”.
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
                    <h3 className="font-medium">Recent changes</h3>
                    {audit.length === 0 ? (
                        <p className="text-muted-foreground">No changes yet.</p>
                    ) : (
                        <ol className="grid gap-1 text-xs">
                            {audit.map((line, index) => (
                                <li key={index} className="break-words">
                                    <span className="text-muted-foreground">{when(line.createdAt)}</span>{' '}
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
export const auditLine = (line: FlagsAdminState['audit'][number]) => {
    const verb = line.action === 'remove' ? 'cleared' : 'changed';
    let scope: string | undefined;
    try {
        scope = (JSON.parse(line.detail) as { scope?: string }).scope;
    } catch {
        scope = undefined;
    }
    if (scope === 'workspace') {
        return `${line.actorName} ${verb} the workspace rule for ${line.targetId}`;
    }
    if (scope === 'person') {
        return `${line.actorName} ${verb} their own choice for ${line.targetId} (no longer used)`;
    }
    return `This server’s configuration ${verb} ${line.targetId}`;
};
