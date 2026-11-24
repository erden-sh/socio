import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { OpsRoomAudit, OpsRoomEvent, OpsRoomHeading } from '@socio/shared/operations/operations-access';

import { api } from '../../lib/api';

import { formatWhen } from './format';
import { useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** What each audit line did, as a sentence's verb. */
const ACTION_LABELS: Record<OpsRoomEvent['action'], string> = {
    create: 'made the room',
    convert: 'made their chat a room',
    rename: 'renamed the room',
    invite: 'invited',
    accept: 'joined',
    decline: 'declined the invite',
    expire: 'let the invite run out',
    leave: 'left',
    remove: 'removed',
    role: 'changed the role of',
    archive: 'archived the room',
    unarchive: 'brought the room back',
    socio_request: 'asked for socio',
    socio_authorize: 'let in socio',
    socio_withdraw: 'took out socio',
    lead: 'made the lead',
    bind_source: 'bound',
    unbind_source: 'unbound',
    limits: 'changed the limits',
    denied: 'was refused',
    queue_cancel: 'canceled a queued message of',
    pin: 'changed the pinned facts',
};

/** The actions whose target the sentence names after the verb. */
const NAMES_TARGET = new Set<OpsRoomEvent['action']>([
    'invite',
    'remove',
    'role',
    'socio_request',
    'socio_authorize',
    'socio_withdraw',
    'lead',
    'bind_source',
    'unbind_source',
    'queue_cancel',
]);

/**
 * The room's people in the transcript's heading line (CB-213): its
 * members by name, admins marked, and the invites still open.
 */
export function roomPeople(room: OpsRoomHeading) {
    const active = room.members.filter((member) => member.status === 'active');
    const invited = room.members.length - active.length;
    const names = active.map((member) => (member.role === 'admin' ? `${member.name} (admin)` : member.name)).join(', ');
    return `${names || 'nobody now'}${invited ? `; ${invited} invited` : ''}`;
}

/**
 * Operations → a room → its audit (CB-213): who made it, joined, left,
 * was invited, removed or refused, and its socios and limits, newest
 * first, by name. Never what was said. Read when opened, which the server
 * writes to the access log.
 */
export function RoomAudit({ roomId, via }: { roomId: string; via: string }) {
    const [open, setOpen] = useState(false);
    return (
        <Card data-slot="ops-room-audit" className="gap-0 px-4 py-3 text-sm shadow-xs">
            <details onToggle={(e) => setOpen(e.currentTarget.open)}>
                <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
                    <ShieldCheck size={16} aria-hidden className="shrink-0" />
                    Room audit
                    <span className="text-xs font-normal text-muted-foreground">who joined, left or was refused</span>
                </summary>
                {open && <Events roomId={roomId} via={via} />}
            </details>
        </Card>
    );
}

function Events({ roomId, via }: { roomId: string; via: string }) {
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
                    setError(e instanceof Error ? e.message : 'Could not load.');
                }
            });
        return () => controller.abort();
    }, [roomId, via]);
    if (error) {
        return (
            <p role="alert" className="m-0 mt-3 text-destructive">
                {error}
            </p>
        );
    }
    if (!answer) {
        return <Skeleton className="mt-3 h-16 w-full" />;
    }
    if (!answer.events.length) {
        return <p className="m-0 mt-3 text-muted-foreground">Nothing yet.</p>;
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
                        <span className="font-medium">{event.actorName}</span>{' '}
                        {ACTION_LABELS[event.action] ?? event.action}
                        {NAMES_TARGET.has(event.action) && event.targetName ? ` ${event.targetName}` : ''}
                        {event.detail && <span className="text-muted-foreground"> · {event.detail}</span>}
                    </span>
                    {event.outcome === 'denied' && (
                        <Badge variant="outline" className="text-destructive">
                            Refused
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
