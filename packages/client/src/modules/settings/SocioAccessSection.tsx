import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
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

/** Where a grant was made, in words. */
export function useGrantPlace() {
    const { t } = useTranslation(['settings.shared']);
    return (grant: SocioGrantView) => {
        const title = grant.conversation.title;
        switch (grant.conversation.kind) {
            case 'room':
                return title
                    ? t('settings.shared:grant.place.room', { title })
                    : t('settings.shared:grant.place.roomUntitled');
            case 'schedule':
                return t('settings.shared:grant.place.schedule');
            default:
                return title
                    ? t('settings.shared:grant.place.chat', { title })
                    : t('settings.shared:grant.place.chatUntitled');
        }
    };
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
    const { t } = useTranslation(['settings.shared']);
    const grantPlace = useGrantPlace();
    const when = (value: number) => t('settings.shared:grant.when', { when: new Date(value) });
    const label = grant.app?.label ?? t('settings.shared:grant.removedApp');
    const person = admin && grant.personName ? grant.personName : undefined;
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
                <Badge variant={grant.access === 'read' ? 'secondary' : 'default'}>
                    {t(`settings.shared:grant.access.${grant.access}`)}
                </Badge>
                <span className="flex-1" />
                {onEnd && grant.state === 'live' && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onEnd(grant)}
                        aria-label={t('settings.shared:grant.endLabel', {
                            socio: grant.socioName,
                            app: label,
                            person,
                            context: person ? 'person' : undefined,
                        })}
                    >
                        {t('settings.shared:grant.end')}
                    </Button>
                )}
            </span>
            <span className="text-muted-foreground">
                {t('settings.shared:grant.from', {
                    socio: grant.socioName,
                    place: grantPlace(grant),
                    person,
                    context: person ? 'person' : undefined,
                })}
            </span>
            {grant.task && (
                <span className="whitespace-pre-wrap">
                    {t('settings.shared:grant.task', { task: inertText(grant.task, { max: 500 }) })}
                </span>
            )}
            <span className="text-xs text-muted-foreground">
                {grant.state === 'live' ? (
                    <Trans
                        t={t}
                        i18nKey="settings.shared:grant.live"
                        count={grant.idleMinutes}
                        values={{ count: grant.idleMinutes }}
                        components={{
                            since: <LocalTime value={grant.createdAt} format={when} />,
                            until: <LocalTime value={grant.expiresAt} format={when} />,
                            used: <LocalTime value={grant.lastUsedAt} format={when} />,
                        }}
                    />
                ) : grant.ended ? (
                    <Trans
                        t={t}
                        i18nKey="settings.shared:grant.ended"
                        values={{ reason: grant.ended.reason }}
                        components={{
                            since: <LocalTime value={grant.createdAt} format={when} />,
                            ended: <LocalTime value={grant.ended.at} format={when} />,
                        }}
                    />
                ) : (
                    <Trans
                        t={t}
                        i18nKey="settings.shared:grant.since"
                        components={{ since: <LocalTime value={grant.createdAt} format={when} /> }}
                    />
                )}
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
    const { t } = useTranslation(['settings.shared']);
    return (
        <ConfirmDelete
            title={t('settings.shared:grant.endTitle', {
                socio: grant.socioName,
                app: grant.app?.label ?? t('settings.shared:grant.thisApp'),
            })}
            action={t('settings.shared:grant.end')}
            slot="confirm-end-socio-access"
            onClose={onClose}
            onConfirm={onConfirm}
        >
            {t('settings.shared:grant.endBody')}
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
    const { t } = useTranslation(['settings', 'settings.socio-access']);
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
            ]).catch((e) => failed(e, t('settings.socio-access:loadFailed'))),
        [t],
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
            failed(e, t('settings.socio-access:saveFailed'));
        }
    };
    const live = grants?.filter((grant) => grant.state === 'live') ?? [];
    const ended = grants?.filter((grant) => grant.state === 'ended') ?? [];
    return (
        <section className="grid min-w-0 gap-4" data-slot="socio-access">
            <div className="grid gap-1">
                <h3 className="font-medium">{t('settings:sections.socio-access')}</h3>
                <p className="text-muted-foreground">{t('settings.socio-access:intro')}</p>
            </div>
            <div className="grid min-w-0 gap-2">
                <h4 className="font-medium">{t('settings.socio-access:reading.title')}</h4>
                <p id={policyHelp} className="text-muted-foreground">
                    {t('settings.socio-access:reading.help')}
                </p>
                <ul className="grid min-w-0 gap-2" aria-label={t('settings.socio-access:reading.title')}>
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
                                    aria-label={t('settings.socio-access:reading.label', { socio: dot.name })}
                                    aria-describedby={policyHelp}
                                    value={policy}
                                    disabled={!approvals}
                                    onChange={(event) => void setPolicy(dot.id, event.target.value as ApprovalPolicy)}
                                >
                                    <option value="manual">{t('settings.socio-access:reading.manual')}</option>
                                    <option value="bypass">{t('settings.socio-access:reading.bypass')}</option>
                                    <option value="auto" disabled={!autoAllowed}>
                                        {t('settings.socio-access:reading.auto')}
                                    </option>
                                </select>
                            </li>
                        );
                    })}
                </ul>
            </div>
            <div className="grid min-w-0 gap-2">
                <h4 className="font-medium">{t('settings.socio-access:granted.title')}</h4>
                <ul className="grid min-w-0 gap-2" aria-label={t('settings.socio-access:granted.title')}>
                    {live.map((grant) => (
                        <GrantItem key={grant.id} grant={grant} onEnd={setEnding} />
                    ))}
                    {grants && !live.length && (
                        <li className="text-muted-foreground">{t('settings.socio-access:granted.none')}</li>
                    )}
                </ul>
                {ended.length > 0 && (
                    <details className="grid gap-2" data-slot="ended-grants">
                        <summary className="cursor-pointer text-muted-foreground">
                            {t('settings.socio-access:granted.ended', { n: ended.length })}
                        </summary>
                        <ul
                            className="mt-2 grid min-w-0 gap-2"
                            aria-label={t('settings.socio-access:granted.endedLabel')}
                        >
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
                            toast.success(t('settings.socio-access:endedToast'));
                            await load();
                        } catch (e) {
                            failed(e, t('settings.socio-access:endFailed'));
                        }
                        setEnding(undefined);
                    }}
                />
            )}
        </section>
    );
}
