import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import {
    normalizePolicy,
    type AccessPolicyImpact,
    type AccessPolicySaved,
    type AccessPolicyView,
    type SavedAccessPolicy,
    type StepUpChallenge,
    type StepUpProof,
} from '@socio/shared/access-policy';
import { dateTimeFormat } from '@socio/shared/locale';

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

const dateTime = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' });
const when = (at: number) => dateTime.format(at);
const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

type Flag = 'password' | 'passkey' | 'signInLink' | 'emailLinks' | 'openSignUp';
type ListKey = 'providers' | 'allowedEmails' | 'allowedDomains' | 'adminEmails';

/** What the page edits: what is on, per method and per entry. */
interface Draft {
    flags: Record<Flag, boolean>;
    lists: Record<ListKey, string[]>;
}

/** `optIn`: off unless turned on here (CB-352); the others are on unless turned off. */
const FLAGS: { key: Flag; label: string; env: string; help?: string; optIn?: boolean }[] = [
    { key: 'password', label: 'Email and password', env: 'AUTH_PASSWORD' },
    { key: 'passkey', label: 'Passkeys', env: 'AUTH_PASSKEY' },
    {
        key: 'signInLink',
        label: 'Sign-in links by Telegram',
        env: 'the Telegram bot',
    },
    {
        key: 'emailLinks',
        label: 'Sign-in links by email',
        // Offered once an email channel delivers sign-in links (it needs SMTP_URL).
        env: 'this server: no email channel',
        help: 'Codes and links go by email to every account. Off by default.',
        optIn: true,
    },
    { key: 'openSignUp', label: 'Open sign-up', env: 'AUTH_OPEN_SIGNUP' },
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
    const entries = ceilingOf(view, field);
    const kept = draft.lists[field];
    return (
        <fieldset className="grid gap-1">
            <legend className="font-medium">{title}</legend>
            <p className="text-muted-foreground">
                {help} The environment ({env}) sets who can be here; untick to take someone off.
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
                <p className="text-muted-foreground">{env} lists nobody, so there is nothing to narrow.</p>
            )}
        </fieldset>
    );
}

function ImpactSummary({ impact }: { impact: AccessPolicyImpact }) {
    return (
        <div className="grid gap-1" data-slot="access-impact" aria-live="polite">
            {impact.changes.length ? (
                <ul className="list-disc pl-5">
                    {impact.changes.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            ) : null}
            {impact.sessionsEnded > 0 && <p>{impact.sessionsEnded} session(s) will end.</p>}
            {impact.signsYouOut && <p className="font-medium">This signs you out: sign in again another way.</p>}
            {impact.withoutWayIn.length > 0 && (
                <p>
                    Left without a way to sign in: {impact.withoutWayIn.map((p) => `${p.name} (${p.email})`).join(', ')}
                    .
                </p>
            )}
            {impact.codeRunsStopped > 0 && <p>{impact.codeRunsStopped} queued or running code run(s) will stop.</p>}
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
                .catch((e) => setError(e instanceof Error ? e.message : 'Could not start.')),
        [body],
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
            setError(e instanceof Error ? e.message : 'Could not save.');
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
                    <DialogTitle>Confirm the change</DialogTitle>
                    <DialogDescription>
                        Every change to sign-in needs you to confirm it is you. Every admin is told about it.
                    </DialogDescription>
                </DialogHeader>
                <ImpactSummary impact={impact} />
                {methods.includes('password') && (
                    <form className="grid gap-2" onSubmit={withPassword}>
                        <label className="grid gap-1">
                            Your password
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
                                Confirm with password
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
                            Confirm with a passkey
                        </Button>
                    </div>
                )}
                {methods.includes('confirm') && (
                    <div>
                        <Button disabled={busy} onClick={() => void save(async (id) => ({ id, confirm: true }))}>
                            Confirm (development sign-in)
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
                        Cancel
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
                .catch((e) => failed(e, 'Could not load the access policy.')),
        [],
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
                            refusal: e instanceof Error ? e.message : 'Could not check.',
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
    }, [view, policy, dirty]);
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
                    <h3 className="font-medium">Sign-in</h3>
                    <p className="text-muted-foreground">
                        The server&apos;s environment is the ceiling: here you can only turn a sign-in method off and
                        take people or domains off its lists. Adding anything needs a stack update. Every change needs
                        you to confirm it with your password or a passkey, ends the sessions that no longer qualify, and
                        is shown to every admin.
                    </p>
                    {view.unreadable && (
                        <p className="text-destructive" role="alert">
                            The saved policy could not be read, so the environment applies. Save it again to fix it.
                        </p>
                    )}
                    <p className="text-muted-foreground">
                        {view.updatedAt ? (
                            <>
                                Version {view.version}, saved <LocalTime value={view.updatedAt} format={when} />.
                            </>
                        ) : (
                            'Nothing narrowed yet: the environment applies.'
                        )}
                    </p>
                    {ceiling ? (
                        <>
                            <fieldset className="grid gap-1">
                                <legend className="font-medium">Ways to sign in</legend>
                                {FLAGS.map(({ key, label, env, help }) => (
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
                                        {label}
                                        {!ceiling[key] && <Badge variant="secondary">off in {env}</Badge>}
                                        {help && <span className="text-xs text-muted-foreground">{help}</span>}
                                    </label>
                                ))}
                            </fieldset>
                            <ListEditor
                                view={view}
                                draft={draft}
                                field="providers"
                                title="Sign-in providers"
                                env="AUTH_OAUTH_PROVIDERS"
                                help="OAuth and OpenID Connect providers on the sign-in screen."
                                onChange={setList('providers')}
                            />
                            <ListEditor
                                view={view}
                                draft={draft}
                                field="adminEmails"
                                title="Admin emails"
                                env="AUTH_ADMIN_EMAILS"
                                help="Verified emails that are always admins. Taking one off makes that person a member at their next request, unless their own role is admin."
                                onChange={setList('adminEmails')}
                            />
                            <ListEditor
                                view={view}
                                draft={draft}
                                field="allowedEmails"
                                title="Allowed emails"
                                env="AUTH_ALLOWED_EMAILS"
                                help="Who may create their own account through a provider."
                                onChange={setList('allowedEmails')}
                            />
                            <ListEditor
                                view={view}
                                draft={draft}
                                field="allowedDomains"
                                title="Allowed domains"
                                env="AUTH_ALLOWED_DOMAINS"
                                help="Email domains whose people may create their own account through a provider."
                                onChange={setList('allowedDomains')}
                            />
                        </>
                    ) : (
                        <p className="text-muted-foreground">
                            This server signs in with the local picker (mock auth), so there are no sign-in methods to
                            narrow.
                        </p>
                    )}
                    <p className="text-muted-foreground" data-slot="code-access-moved">
                        Who may run code is now a permission: admins have it, and others get it from a group under{' '}
                        <Link to={`${settingsPath('people')}?tab=groups`} className="underline underline-offset-2">
                            People → Groups
                        </Link>
                        .
                    </p>
                    {dirty && impact && <ImpactSummary impact={impact} />}
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={!dirty || !impact || !!impact.refusal} onClick={() => setConfirming(true)}>
                            Review and confirm
                        </Button>
                        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(draftOf(view))}>
                            Undo changes
                        </Button>
                    </div>
                </section>
            </SettingsCard>
            <SettingsCard>
                <section className="grid gap-2">
                    <h3 className="font-medium">History</h3>
                    {view.audit.length ? (
                        <ul className="grid gap-2" aria-label="Access policy history">
                            {view.audit.map((entry) => (
                                <li key={entry.id} className="grid gap-0.5">
                                    <span>
                                        <LocalTime value={entry.at} format={when} /> · {entry.actorName}
                                        {entry.stepUp ? ` · confirmed with ${entry.stepUp}` : ''}
                                    </span>
                                    <span className="text-muted-foreground break-words">
                                        {entry.detail}
                                        {entry.sessionsEnded ? ` ${entry.sessionsEnded} session(s) ended.` : ''}
                                        {entry.codeRunsStopped ? ` ${entry.codeRunsStopped} code run(s) stopped.` : ''}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-muted-foreground">No changes yet.</p>
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
                        toast.success('Access policy saved; every admin was told.');
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
