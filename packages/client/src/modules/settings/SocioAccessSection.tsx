import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import type { ApprovalPolicy, ApprovalsState } from '@socio/shared/approvals';
import { SOCIO_ACCESS_CAPABILITIES, type SocioGrantView, type SocioGrantsState } from '@socio/shared/socio-access';
import { inertText } from '@socio/shared/text/inert-text';

import { ConfirmDelete } from '../../components/confirm-delete';
import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { useShell } from '../../shell/shell-context';

import { nativeSelect } from '@/components/form-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const when = (value: number) =>
    new Date(value).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
const ACCESS_WORDS: Record<SocioGrantView['access'], string> = {
    read: 'Read',
    write: 'Read and change',
    act: 'Change and ask to act',
    other: 'Other',
};

/** Where a grant was made, in words. */
export function grantPlace(grant: SocioGrantView) {
    const title = grant.conversation.title;
    switch (grant.conversation.kind) {
        case 'room':
            return title ? `the room ${title}` : 'a room';
        case 'schedule':
            return 'a scheduled task';
        default:
            return title ? `the chat ${title}` : 'a private chat';
    }
}

/** One grant: the app by its own address, the socio, what and until when. */
export function GrantItem({
    grant,
    onEnd,
    admin = false,
}: {
    grant: SocioGrantView;
    onEnd?: (grant: SocioGrantView) => void;
    admin?: boolean;
}) {
    const label = grant.app?.label ?? 'A removed app';
    return (
        <li
            className="grid min-w-0 gap-1 rounded-md border p-3 [overflow-wrap:anywhere]"
            data-grant={grant.id}
            data-state={grant.state}
        >
            <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium">{label}</span>
                {grant.app?.origin && (
                    <span className="font-mono text-xs text-muted-foreground">{grant.app.origin}</span>
                )}
                <Badge variant={grant.access === 'read' ? 'secondary' : 'default'}>{ACCESS_WORDS[grant.access]}</Badge>
                <span className="flex-1" />
                {onEnd && grant.state === 'live' && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onEnd(grant)}
                        aria-label={`End ${grant.socioName}’s access to ${label}${admin && grant.personName ? ` for ${grant.personName}` : ''}`}
                    >
                        End access
                    </Button>
                )}
            </span>
            <span className="text-muted-foreground">
                {admin && grant.personName ? `${grant.personName} · ` : ''}
                {grant.socioName}, from {grantPlace(grant)}
            </span>
            {grant.task && <span className="whitespace-pre-wrap">“{inertText(grant.task, { max: 500 })}”</span>}
            <span className="text-xs text-muted-foreground">
                Since <LocalTime value={grant.createdAt} format={when} />
                {grant.state === 'live' ? (
                    <>
                        {' '}
                        · until <LocalTime value={grant.expiresAt} format={when} /> · last used{' '}
                        <LocalTime value={grant.lastUsedAt} format={when} />
                        {` (ends after ${grant.idleMinutes} idle minutes)`}
                    </>
                ) : grant.ended ? (
                    <>
                        {' '}
                        · ended <LocalTime value={grant.ended.at} format={when} />: {grant.ended.reason}
                    </>
                ) : null}
            </span>
        </li>
    );
}

/** Confirms ending a grant; says what that does. */
export function EndGrantDialog({
    grant,
    onClose,
    onConfirm,
}: {
    grant: SocioGrantView;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
    return (
        <ConfirmDelete
            title={`End ${grant.socioName}’s access to ${grant.app?.label ?? 'this app'}?`}
            action="End access"
            slot="confirm-end-socio-access"
            onClose={onClose}
            onConfirm={onConfirm}
        >
            It stops at once, everywhere: its open pages close and it can’t use the app for this task again. It can ask
            again, on a new card.
        </ConfirmDelete>
    );
}

/**
 * Settings → Account → Socio access (CB-232): whether each socio
 * may read apps for this person without asking (their own opt-in, per
 * socio; write and actions always ask, and an app can insist on asking),
 * and the access they granted, with End access.
 */
export function SocioAccessSection() {
    const shell = useShell();
    const [grants, setGrants] = useState<SocioGrantView[]>();
    const [approvals, setApprovals] = useState<ApprovalsState>();
    const [ending, setEnding] = useState<SocioGrantView>();
    const policyHelp = useId();
    const load = useCallback(
        () =>
            Promise.all([
                api<SocioGrantsState>('/actors/grants').then((answer) => setGrants(answer.grants)),
                api<ApprovalsState>('/approvals').then(setApprovals),
            ]).catch((e) => failed(e, 'Could not load socio access.')),
        [],
    );
    useEffect(() => void load(), [load]);
    const read = SOCIO_ACCESS_CAPABILITIES.read;
    const policyOf = (dotId: string): ApprovalPolicy =>
        approvals?.policies.find((entry) => entry.dotId === dotId && entry.capability === read)?.policy ?? 'manual';
    const autoAllowed = approvals?.capabilities.find((item) => item.id === read)?.auto?.allowed ?? false;
    const setPolicy = async (dotId: string, policy: ApprovalPolicy) => {
        try {
            await api('/approvals/policies', 'PUT', {
                dotId,
                capability: read,
                policy,
            });
            await load();
        } catch (e) {
            failed(e, 'Could not save the choice.');
        }
    };
    const live = grants?.filter((grant) => grant.state === 'live') ?? [];
    const ended = grants?.filter((grant) => grant.state === 'ended') ?? [];
    return (
        <section className="grid min-w-0 gap-4" data-slot="socio-access">
            <div className="grid gap-1">
                <h3 className="font-medium">Socio access</h3>
                <p className="text-muted-foreground">
                    Socios can ask to use your mini apps for you, one task at a time, and only apps you can open
                    yourself. You decide on a card in the chat. Changing data and taking actions always wait for you.
                </p>
            </div>
            <div className="grid min-w-0 gap-2">
                <h4 className="font-medium">Reading without asking</h4>
                <p id={policyHelp} className="text-muted-foreground">
                    For each socio, whether it may read apps for you without a card. Only you can choose this. Apps that
                    ask every time still ask.
                </p>
                <ul className="grid min-w-0 gap-2" aria-label="Reading without asking">
                    {shell.workspace.dots.map((dot) => {
                        const policy = policyOf(dot.id);
                        return (
                            <li
                                key={dot.id}
                                className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between"
                                data-socio={dot.id}
                                data-policy={policy}
                            >
                                <span className="min-w-0 font-medium">{dot.name}</span>
                                <select
                                    className={`${nativeSelect} w-full sm:w-auto`}
                                    aria-label={`Whether ${dot.name} may read apps for you without asking`}
                                    aria-describedby={policyHelp}
                                    value={policy}
                                    disabled={!approvals}
                                    onChange={(event) => void setPolicy(dot.id, event.target.value as ApprovalPolicy)}
                                >
                                    <option value="manual">Ask me every time</option>
                                    <option value="bypass">Let it read without asking</option>
                                    <option value="auto" disabled={!autoAllowed}>
                                        Let auto review decide
                                    </option>
                                </select>
                            </li>
                        );
                    })}
                </ul>
            </div>
            <div className="grid min-w-0 gap-2">
                <h4 className="font-medium">Access you granted</h4>
                <ul className="grid min-w-0 gap-2" aria-label="Access you granted">
                    {live.map((grant) => (
                        <GrantItem key={grant.id} grant={grant} onEnd={setEnding} />
                    ))}
                    {grants && !live.length && (
                        <li className="text-muted-foreground">No socio can use an app for you now.</li>
                    )}
                </ul>
                {ended.length > 0 && (
                    <details className="grid gap-2" data-slot="ended-grants">
                        <summary className="cursor-pointer text-muted-foreground">Ended ({ended.length})</summary>
                        <ul className="mt-2 grid min-w-0 gap-2" aria-label="Ended access">
                            {ended.map((grant) => (
                                <GrantItem key={grant.id} grant={grant} />
                            ))}
                        </ul>
                    </details>
                )}
            </div>
            {ending && (
                <EndGrantDialog
                    grant={ending}
                    onClose={() => setEnding(undefined)}
                    onConfirm={async () => {
                        try {
                            await api(`/actors/grants/${encodeURIComponent(ending.id)}`, 'DELETE');
                            toast.success('Access ended');
                            await load();
                        } catch (e) {
                            failed(e, 'Could not end the access.');
                        }
                        setEnding(undefined);
                    }}
                />
            )}
        </section>
    );
}
