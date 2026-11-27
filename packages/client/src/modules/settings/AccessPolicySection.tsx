import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import {
    normalizePolicy,
    type AccessPolicyImpact,
    type AccessPolicySaved,
    type AccessPolicyView,
    type SavedAccessPolicy,
    type StepUpChallenge,
    type StepUpProof,
} from '@socio/shared/access-policy';

import { api, ApiError } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { importOrReload } from '../../shell/chunk-reload';

import { SettingsCard } from './AccountSettings';
import { settingsPath } from './sections';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

type Flag = 'password' | 'passkey' | 'signInLink' | 'emailLinks' | 'google' | 'apple' | 'openSignUp';
type ListKey = 'providers' | 'allowedEmails' | 'allowedDomains' | 'adminEmails';

/** What the page edits: what is on, per method and per entry. */
interface Draft {
    flags: Record<Flag, boolean>;
    lists: Record<ListKey, string[]>;
}

/**
 * `optIn`: off unless turned on here (CB-352); the others are on unless
 * turned off. `env`: the variable that turns it off, or `off`, the badge's
 * context when no variable does.
 */
const FLAGS: {
    key: Flag;
    label: `settings.access:methods.${Flag}`;
    env: string;
    off?: 'telegram' | 'email' | 'cloud';
    help?: `settings.access:methods.${'emailLinks' | 'google' | 'apple'}Help`;
    optIn?: boolean;
}[] = [
    { key: 'password', label: 'settings.access:methods.password', env: 'AUTH_PASSWORD' },
    { key: 'passkey', label: 'settings.access:methods.passkey', env: 'AUTH_PASSKEY' },
    { key: 'signInLink', label: 'settings.access:methods.signInLink', env: '', off: 'telegram' },
    {
        key: 'emailLinks',
        label: 'settings.access:methods.emailLinks',
        // Offered once an email channel delivers sign-in links (it needs SMTP_URL).
        env: '',
        off: 'email',
        help: 'settings.access:methods.emailLinksHelp',
        optIn: true,
    },
    {
        key: 'google',
        label: 'settings.access:methods.google',
        // Offered while this server is connected to Socio's cloud services (CB-570).
        env: '',
        off: 'cloud',
        help: 'settings.access:methods.googleHelp',
    },
    {
        key: 'apple',
        label: 'settings.access:methods.apple',
        env: '',
        off: 'cloud',
        help: 'settings.access:methods.appleHelp',
    },
    { key: 'openSignUp', label: 'settings.access:methods.openSignUp', env: 'AUTH_OPEN_SIGNUP' },
];

/** The environment's entries of a list, with their labels. */
function ceilingOf(view: AccessPolicyView, key: ListKey) {
    const signIn = view.signIn?.ceiling;
    if (!signIn) {
        return [];
    }
    if (key === 'providers') {
        return signIn.providers.map(({ id, name }) => ({ id, label: name }));
    }
    return signIn[key].map((id) => ({ id, label: id }));
}

function draftOf(view: AccessPolicyView): Draft {
    const signIn = view.signIn?.inForce;
    return {
        flags: {
            password: signIn?.password ?? false,
            passkey: signIn?.passkey ?? false,
            signInLink: signIn?.signInLink ?? false,
            emailLinks: signIn?.emailLinks ?? false,
            google: signIn?.google ?? false,
            apple: signIn?.apple ?? false,
            openSignUp: signIn?.openSignUp ?? false,
        },
        lists: {
            providers: signIn?.providers ?? [],
            allowedEmails: signIn?.allowedEmails ?? [],
            allowedDomains: signIn?.allowedDomains ?? [],
            adminEmails: signIn?.adminEmails ?? [],
        },
    };
}

/**
 * The policy to save: a method the environment allows and the draft has
 * off is `false`; a list with every environment entry ticked follows the
 * environment (so entries it adds later count), else it is what is ticked.
 */
function policyOf(view: AccessPolicyView, draft: Draft): SavedAccessPolicy {
    const policy: SavedAccessPolicy = {};
    const ceiling = view.signIn?.ceiling;
    if (ceiling) {
        for (const { key, optIn } of FLAGS) {
            if (key === 'emailLinks') {
                if (optIn && ceiling.emailLinks && draft.flags.emailLinks) {
                    policy.emailLinks = true;
                }
            } else if (ceiling[key] && !draft.flags[key]) {
                policy[key] = false;
            }
        }
    }
    const keys: ListKey[] = ceiling ? ['providers', 'allowedEmails', 'allowedDomains', 'adminEmails'] : [];
    for (const key of keys) {
        const all = ceilingOf(view, key).map(({ id }) => id);
        const kept = draft.lists[key].filter((id) => all.includes(id));
        if (kept.length !== all.length) {
            policy[key] = kept;
        }
    }
    return normalizePolicy(policy);
}

function ListEditor({
    view,
    draft,
    field,
    title,
    env,
    help,
    onChange,
}: {
    view: AccessPolicyView;
    draft: Draft;
    field: ListKey;
    title: string;
    env: string;
    help: string;
    onChange: (next: string[]) => void;
}) {
    const { t } = useTranslation(['settings.access']);
    const entries = ceilingOf(view, field);
    const kept = draft.lists[field];
    return (
        <fieldset className="grid gap-1">
            <legend className="font-medium">{title}</legend>
            <p className="text-muted-foreground">
                {help} {t('settings.access:lists.ceiling', { env })}
            </p>
            {entries.length ? (
                <ul className="grid gap-1">
                    {entries.map(({ id, label }) => (
                        <li key={id}>
                            <label className="flex items-center gap-2 break-all">
                                <input
                                    type="checkbox"
                                    className="size-4 shrink-0"
                                    checked={kept.includes(id)}
                                    onChange={(e) =>
                                        onChange(
                                            e.target.checked ? [...kept, id] : kept.filter((entry) => entry !== id),
                                        )
                                    }
                                />
                                {label}
                            </label>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-muted-foreground">{t('settings.access:lists.empty', { env })}</p>
            )}
        </fieldset>
    );
}

function ImpactSummary({ impact }: { impact: AccessPolicyImpact }) {
    const { t } = useTranslation(['settings.access']);
    return (
        <div className="grid gap-1" data-slot="access-impact" aria-live="polite">
            {impact.changes.length ? (
                <ul className="list-disc pl-5">
                    {impact.changes.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            ) : null}
            {impact.sessionsEnded > 0 && (
                <p>{t('settings.access:impact.sessionsEnded', { count: impact.sessionsEnded })}</p>
            )}
            {impact.signsYouOut && <p className="font-medium">{t('settings.access:impact.signsYouOut')}</p>}
            {impact.withoutWayIn.length > 0 && (
                <p>
                    {t('settings.access:impact.withoutWayIn', {
                        people: impact.withoutWayIn.map((p) =>
                            t('settings.access:impact.person', { name: p.name, email: p.email }),
                        ),
                    })}
                </p>
            )}
            {impact.codeRunsStopped > 0 && (
                <p>{t('settings.access:impact.codeRunsStopped', { count: impact.codeRunsStopped })}</p>
            )}
            {impact.refusal && (
                <p className="text-destructive" role="alert">
                    {impact.refusal}
                </p>
            )}
        </div>
    );
}

/**
 * The step-up (CB-124): a challenge for exactly this change, then the
 * admin's password, a passkey, or (mock auth) a confirmation.
 */
function ConfirmChange({
    view,
    policy,
    impact,
    onClose,
    onSaved,
}: {
    view: AccessPolicyView;
    policy: SavedAccessPolicy;
    impact: AccessPolicyImpact;
    onClose: () => void;
    onSaved: (saved: AccessPolicySaved) => void;
}) {
    const { t } = useTranslation(['settings.access']);
    const [challenge, setChallenge] = useState<StepUpChallenge>();
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const body = useMemo(() => ({ policy, version: view.version }), [policy, view]);
    const open = useCallback(
        () =>
            api<StepUpChallenge>('/access-policy/step-up', 'POST', body)
                .then((next) => {
                    setChallenge(next);
                    setError(next.reason);
                })
                .catch((e) => setError(e instanceof Error ? e.message : t('settings.access:errors.start'))),
        [body, t],
    );
    useEffect(() => void open(), [open]);
    const save = async (proof: (id: string) => Promise<StepUpProof>) => {
        if (!challenge) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const saved = await api<AccessPolicySaved>('/access-policy', 'PUT', {
                ...body,
                stepUp: await proof(challenge.id),
            });
            onSaved(saved);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('settings.access:errors.save'));
            // Each challenge works once: get a fresh one for another try.
            if (!(e instanceof ApiError && e.status === 409)) {
                void open();
            }
        } finally {
            setBusy(false);
        }
    };
    const withPassword = (e: FormEvent) => {
        e.preventDefault();
        void save(async (id) => ({ id, password }));
    };
    const withPasskey = () =>
        void save(async (id) => {
            const { startAuthentication } = await importOrReload(() => import('@simplewebauthn/browser'));
            const response = await startAuthentication({
                optionsJSON: challenge!.passkey as never,
            });
            return { id, passkey: response as unknown as Record<string, unknown> };
        });
    const methods = challenge?.methods ?? [];
    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('settings.access:confirm.title')}</DialogTitle>
                    <DialogDescription>{t('settings.access:confirm.description')}</DialogDescription>
                </DialogHeader>
                <ImpactSummary impact={impact} />
                {methods.includes('password') && (
                    <form className="grid gap-2" onSubmit={withPassword}>
                        <label className="grid gap-1">
                            {t('settings.access:confirm.password')}
                            <Input
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoFocus
                            />
                        </label>
                        <div>
                            <Button type="submit" disabled={busy || !password}>
                                {t('settings.access:confirm.withPassword')}
                            </Button>
                        </div>
                    </form>
                )}
                {methods.includes('passkey') && (
                    <div>
                        <Button
                            variant={methods.includes('password') ? 'outline' : 'default'}
                            disabled={busy}
                            onClick={withPasskey}
                        >
                            {t('settings.access:confirm.withPasskey')}
                        </Button>
                    </div>
                )}
                {methods.includes('confirm') && (
                    <div>
                        <Button disabled={busy} onClick={() => void save(async (id) => ({ id, confirm: true }))}>
                            {t('settings.access:confirm.withConfirm')}
                        </Button>
                    </div>
                )}
                {error && (
                    <p className="text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t('settings.access:confirm.cancel')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Settings → Access (CB-124): admins narrow the environment's sign-in
 * methods, allowlists and code-access list. The environment is the
 * ceiling: nothing here can add a method, a person or a domain.
 */
export function AccessPolicySection({ onSignedOut }: { onSignedOut?: () => void }) {
    const { t } = useTranslation(['settings.access']);
    const when = (at: number) => t('settings.access:when', { at: new Date(at) });
    const [view, setView] = useState<AccessPolicyView>();
    const [draft, setDraft] = useState<Draft>();
    const [impact, setImpact] = useState<AccessPolicyImpact>();
    const [confirming, setConfirming] = useState(false);
    const load = useCallback(
        () =>
            api<AccessPolicyView>('/access-policy')
                .then((next) => {
                    setView(next);
                    setDraft(draftOf(next));
                    setImpact(undefined);
                })
                .catch((e) => failed(e, t('settings.access:errors.load'))),
        [t],
    );
    useEffect(() => void load(), [load]);
    const policy = useMemo(() => (view && draft ? policyOf(view, draft) : undefined), [view, draft]);
    const dirty = !!view && !!policy && JSON.stringify(policy) !== JSON.stringify(view.saved);
    useEffect(() => {
        if (!view || !policy || !dirty) {
            setImpact(undefined);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            api<AccessPolicyImpact>(
                '/access-policy/preview',
                'POST',
                { policy, version: view.version },
                controller.signal,
            )
                .then(setImpact)
                .catch((e) => {
                    if (!controller.signal.aborted) {
                        setImpact({
                            changes: [],
                            refusal: e instanceof Error ? e.message : t('settings.access:errors.check'),
                            sessionsEnded: 0,
                            withoutWayIn: [],
                            signsYouOut: false,
                            codeRunsStopped: 0,
                        });
                    }
                });
        }, 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [view, policy, dirty, t]);
    if (!view || !draft) {
        return null;
    }
    const ceiling = view.signIn?.ceiling;
    const setList = (key: ListKey) => (next: string[]) =>
        setDraft({ ...draft, lists: { ...draft.lists, [key]: next } });
    return (
        <>
            <SettingsCard>
                <section className="grid gap-3" data-slot="access-policy">
                    <h3 className="font-medium">{t('settings.access:title')}</h3>
                    <p className="text-muted-foreground">{t('settings.access:intro')}</p>
                    {view.unreadable && (
                        <p className="text-destructive" role="alert">
                            {t('settings.access:unreadable')}
                        </p>
                    )}
                    <p className="text-muted-foreground">
                        {view.updatedAt ? (
                            <Trans
                                t={t}
                                i18nKey="settings.access:version"
                                values={{ version: view.version }}
                                components={{ when: <LocalTime value={view.updatedAt} format={when} /> }}
                            />
                        ) : (
                            t('settings.access:nothingNarrowed')
                        )}
                    </p>
                    {ceiling ? (
                        <>
                            <fieldset className="grid gap-1">
                                <legend className="font-medium">{t('settings.access:methods.title')}</legend>
                                {FLAGS.map(({ key, label, env, off, help }) => (
                                    <label key={key} className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            className="size-4 shrink-0"
                                            checked={draft.flags[key]}
                                            disabled={!ceiling[key]}
                                            onChange={(e) =>
                                                setDraft({
                                                    ...draft,
                                                    flags: { ...draft.flags, [key]: e.target.checked },
                                                })
                                            }
                                        />
                                        {t(label)}
                                        {!ceiling[key] && (
                                            <Badge variant="secondary">
                                                {t('settings.access:methods.offIn', { env, context: off })}
                                            </Badge>
                                        )}
                                        {help && <span className="text-xs text-muted-foreground">{t(help)}</span>}
                                    </label>
                                ))}
                            </fieldset>
                            <ListEditor
                                view={view}
                                draft={draft}
                                field="providers"
                                title={t('settings.access:lists.providers')}
                                env="AUTH_OAUTH_PROVIDERS"
                                help={t('settings.access:lists.providersHelp')}
                                onChange={setList('providers')}
                            />
                            <ListEditor
                                view={view}
                                draft={draft}
                                field="adminEmails"
                                title={t('settings.access:lists.adminEmails')}
                                env="AUTH_ADMIN_EMAILS"
                                help={t('settings.access:lists.adminEmailsHelp')}
                                onChange={setList('adminEmails')}
                            />
                            <ListEditor
                                view={view}
                                draft={draft}
                                field="allowedEmails"
                                title={t('settings.access:lists.allowedEmails')}
                                env="AUTH_ALLOWED_EMAILS"
                                help={t('settings.access:lists.allowedEmailsHelp')}
                                onChange={setList('allowedEmails')}
                            />
                            <ListEditor
                                view={view}
                                draft={draft}
                                field="allowedDomains"
                                title={t('settings.access:lists.allowedDomains')}
                                env="AUTH_ALLOWED_DOMAINS"
                                help={t('settings.access:lists.allowedDomainsHelp')}
                                onChange={setList('allowedDomains')}
                            />
                        </>
                    ) : (
                        <p className="text-muted-foreground">{t('settings.access:mockAuth')}</p>
                    )}
                    <p className="text-muted-foreground" data-slot="code-access-moved">
                        <Trans
                            t={t}
                            i18nKey="settings.access:codeAccess"
                            components={{
                                groupsLink: (
                                    <Link
                                        to={`${settingsPath('people')}?tab=groups`}
                                        className="underline underline-offset-2"
                                    />
                                ),
                            }}
                        />
                    </p>
                    {dirty && impact && <ImpactSummary impact={impact} />}
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={!dirty || !impact || !!impact.refusal} onClick={() => setConfirming(true)}>
                            {t('settings.access:review')}
                        </Button>
                        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(draftOf(view))}>
                            {t('settings.access:undo')}
                        </Button>
                    </div>
                </section>
            </SettingsCard>
            <SettingsCard>
                <section className="grid gap-2">
                    <h3 className="font-medium">{t('settings.access:history.title')}</h3>
                    {view.audit.length ? (
                        <ul className="grid gap-2" aria-label={t('settings.access:history.label')}>
                            {view.audit.map((entry) => (
                                <li key={entry.id} className="grid gap-0.5">
                                    <span>
                                        <Trans
                                            t={t}
                                            i18nKey="settings.access:history.entry"
                                            values={{ actor: entry.actorName }}
                                            components={{ when: <LocalTime value={entry.at} format={when} /> }}
                                        />
                                        {entry.stepUp
                                            ? ` · ${t('settings.access:history.confirmed', { method: entry.stepUp, context: entry.stepUp })}`
                                            : ''}
                                    </span>
                                    <span className="text-muted-foreground break-words">
                                        {entry.detail}
                                        {entry.sessionsEnded
                                            ? ` ${t('settings.access:history.sessionsEnded', { count: entry.sessionsEnded })}`
                                            : ''}
                                        {entry.codeRunsStopped
                                            ? ` ${t('settings.access:history.codeRunsStopped', { count: entry.codeRunsStopped })}`
                                            : ''}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-muted-foreground">{t('settings.access:history.empty')}</p>
                    )}
                </section>
            </SettingsCard>
            {confirming && policy && impact && (
                <ConfirmChange
                    view={view}
                    policy={policy}
                    impact={impact}
                    onClose={() => setConfirming(false)}
                    onSaved={(saved) => {
                        setConfirming(false);
                        toast.success(t('settings.access:confirm.saved'));
                        if (saved.impact.signsYouOut) {
                            onSignedOut?.();
                        } else {
                            void load();
                        }
                    }}
                />
            )}
        </>
    );
}
