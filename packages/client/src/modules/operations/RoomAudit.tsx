import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { OpsRoomAudit, OpsRoomEvent, OpsRoomHeading } from '@socio/shared/operations/operations-access';

import { useOnDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';

import { formatWhen } from './format';
import { useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Each audit action's sentence, by its key in `events`; `-target` adds the one it names. */
const EVENT_KEYS = {
    create: 'create',
    convert: 'convert',
    rename: 'rename',
    invite: 'invite',
    accept: 'accept',
    decline: 'decline',
    expire: 'expire',
    leave: 'leave',
    remove: 'remove',
    role: 'role',
    archive: 'archive',
    unarchive: 'unarchive',
    socio_request: 'socio-request',
    socio_authorize: 'socio-authorize',
    socio_withdraw: 'socio-withdraw',
    lead: 'lead',
    bind_source: 'bind-source',
    unbind_source: 'unbind-source',
    limits: 'limits',
    denied: 'denied',
    queue_cancel: 'queue-cancel',
    pin: 'pin',
} as const satisfies Record<OpsRoomEvent['action'], string>;

/** The actions whose sentence names their target after the verb, by their key in `events`. */
const TARGET_KEYS = {
    invite: 'invite-target',
    remove: 'remove-target',
    role: 'role-target',
    socio_request: 'socio-request-target',
    socio_authorize: 'socio-authorize-target',
    socio_withdraw: 'socio-withdraw-target',
    lead: 'lead-target',
    bind_source: 'bind-source-target',
    unbind_source: 'unbind-source-target',
    queue_cancel: 'queue-cancel-target',
} as const;
const targetKey = (action: OpsRoomEvent['action']) =>
    Object.hasOwn(TARGET_KEYS, action) ? TARGET_KEYS[action as keyof typeof TARGET_KEYS] : undefined;

/**
 * The room's people in the transcript's heading line (CB-213): its
 * members by name, admins marked, and the invites still open.
 */
export function useRoomPeople() {
    const { t } = useTranslation(['operations.transcript']);
    return (room: OpsRoomHeading) => {
        const active = room.members.filter((member) => member.status === 'active');
        const invited = room.members.length - active.length;
        const names = active.map((member) =>
            member.role === 'admin' ? t('operations.transcript:about.admin', { name: member.name }) : member.name,
        );
        const people = names.length
            ? t('operations.transcript:about.names', { names })
            : t('operations.transcript:about.nobody');
        return invited ? t('operations.transcript:about.invited', { people, count: invited }) : people;
    };
}

/**
 * Operations → a room → its audit (CB-213): who made it, joined, left,
 * was invited, removed or refused, and its socios and limits, newest
 * first, by name. Never what was said. Read when opened, which the server
 * writes to the access log.
 */
export function RoomAudit({ roomId, via }: { roomId: string; via: string }) {
    const { t } = useTranslation(['operations.transcript']);
    const [open, setOpen] = useState(false);
    return (
        <Card data-slot="ops-room-audit" className="gap-0 px-4 py-3 text-sm shadow-xs">
            <details onToggle={(e) => setOpen(e.currentTarget.open)}>
                <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
                    <ShieldCheck size={16} aria-hidden className="shrink-0" />
                    {t('operations.transcript:audit.title')}
                    <span className="text-xs font-normal text-muted-foreground">
                        {t('operations.transcript:audit.subtitle')}
                    </span>
                </summary>
                {open && <Events roomId={roomId} via={via} />}
            </details>
        </Card>
    );
}

function Events({ roomId, via }: { roomId: string; via: string }) {
    const { t } = useTranslation(['operations.room-audit', 'operations']);
    const ready = useOnDemand(['operations.room-audit']);
    const { timeZone } = useOpsSettings();
    const [answer, setAnswer] = useState<OpsRoomAudit>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        api<OpsRoomAudit>(
            `/operations/chats/${encodeURIComponent(roomId)}/room-events?via=${via}`,
            'GET',
            undefined,
            controller.signal,
        )
            .then((found) => !controller.signal.aborted && setAnswer(found))
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : t('operations:load-failed'));
                }
            });
        return () => controller.abort();
    }, [roomId, via, t]);
    if (error) {
        return (
            <p role="alert" className="m-0 mt-3 text-destructive">
                {error}
            </p>
        );
    }
    if (!answer || !ready) {
        return <Skeleton className="mt-3 h-16 w-full" />;
    }
    if (!answer.events.length) {
        return <p className="m-0 mt-3 text-muted-foreground">{t('operations.room-audit:empty')}</p>;
    }
    return (
        <ul data-slot="ops-room-events" className="m-0 mt-3 grid list-none gap-1 p-0">
            {answer.events.map((event) => (
                <li
                    key={event.id}
                    data-action={event.action}
                    data-outcome={event.outcome}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                >
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                        <EventSentence event={event} />
                        {event.detail && <span className="text-muted-foreground"> · {event.detail}</span>}
                    </span>
                    {event.outcome === 'denied' && (
                        <Badge variant="outline" className="text-destructive">
                            {t('operations.room-audit:refused')}
                        </Badge>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {formatWhen(event.at, timeZone)}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/** "Ada invited Mo": who did what, to whom when the action names someone. */
function EventSentence({ event }: { event: OpsRoomEvent }) {
    const { t } = useTranslation(['operations.room-audit']);
    const components = { actor: <span className="font-medium" /> };
    const target = targetKey(event.action);
    if (target && event.targetName) {
        return (
            <Trans
                t={t}
                i18nKey={`operations.room-audit:events.${target}`}
                values={{ actor: event.actorName, target: event.targetName }}
                components={components}
            />
        );
    }
    if (Object.hasOwn(EVENT_KEYS, event.action)) {
        return (
            <Trans
                t={t}
                i18nKey={`operations.room-audit:events.${EVENT_KEYS[event.action]}`}
                values={{ actor: event.actorName }}
                components={components}
            />
        );
    }
    return (
        <Trans
            t={t}
            i18nKey="operations.room-audit:events.other"
            values={{ actor: event.actorName, action: event.action }}
            components={components}
        />
    );
}
