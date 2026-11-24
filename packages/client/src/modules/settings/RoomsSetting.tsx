import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { formatNumber } from '@socio/shared/locale';
import type { RoomSocioRequest, RoomsReadiness, RoomsSettings } from '@socio/shared/rooms/rooms';

import { api } from '../../lib/api';
import { failure, roomsApi } from '../rooms/api';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';
import { Button } from '@/components/ui/button';

const chats = (count: number) => `${formatNumber(count)} ${count === 1 ? 'chat' : 'chats'}`;
const rooms = (count: number) => `${formatNumber(count)} ${count === 1 ? 'room' : 'rooms'}`;

/** The reconcile line before Rooms is turned on. */
export function readinessLine(readiness: RoomsReadiness) {
    const { private: own, room } = readiness.conversations;
    if (readiness.allPrivate) {
        return `${chats(own)}, all private. Turning Rooms on changes none of them.`;
    }
    return `${chats(own)} private, ${rooms(room)}. Private chats keep their readers either way.`;
}

/**
 * Rooms (CB-207) in Settings → Workspace → General: the admin's switch for
 * shared rooms, off by default, over `ROOMS_ENABLED`. Members read it;
 * admins change it and see how many chats are private before they do.
 * And whether members see their room's use and limits (CB-218), off by
 * default, over `ROOMS_BUDGET_VISIBLE`.
 */
export function RoomsSetting({
    settings,
    readOnly,
    mutate,
}: {
    settings: Partial<RoomsSettings> | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const auto = useAutosave(
        {
            enabled: settings?.enabled ?? false,
            budgetVisible: settings?.budgetVisible ?? false,
        },
        (value) => mutate('/settings', 'PATCH', { rooms: value }),
    );
    const [readiness, setReadiness] = useState<RoomsReadiness>();
    useEffect(() => {
        if (readOnly) {
            return;
        }
        const controller = new AbortController();
        api<RoomsReadiness>('/rooms/readiness', 'GET', undefined, controller.signal)
            // An older server answers without it: no line then.
            .then((value) => value?.conversations && setReadiness(value))
            .catch(() => undefined);
        return () => controller.abort();
    }, [readOnly]);
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="rooms">
                <AutosaveHeader title="Rooms" status={!readOnly ? auto.status : undefined}>
                    Rooms let several people share one conversation with a company socio. Each message runs as the
                    person who sent it, and nobody’s private memories or data are shared. With this on, everyone sees
                    Rooms in the sidebar: they create rooms, share a chat as one and invite people. Rooms are a preview.
                </AutosaveHeader>
                <PermissionRow
                    title="Let members create shared rooms"
                    checked={auto.value.enabled}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { enabled: on },
                            on
                                ? 'Rooms turned on. Everyone sees them in the sidebar.'
                                : 'Rooms turned off. Existing rooms are read-only.',
                        )
                    }
                >
                    Off by default. Turned off later, rooms and invitations leave the app; a room’s link still opens it
                    read-only, and nothing new runs in it.
                </PermissionRow>
                <PermissionRow
                    title="Members see their room’s use and limits"
                    checked={auto.value.budgetVisible}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { budgetVisible: on },
                            on
                                ? 'Members now see their room’s use and limits'
                                : 'Only room admins see a room’s use and limits now',
                        )
                    }
                >
                    Off by default: only room admins see them. On, everyone in a room sees its limits, its current
                    message’s time and tokens, and the day’s total once at least three people have sent messages. Spend
                    on someone’s own model subscription stays theirs.
                </PermissionRow>
                {readiness && (
                    <p className="text-muted-foreground" data-slot="rooms-readiness">
                        {readinessLine(readiness)}
                    </p>
                )}
                {!readOnly && settings?.enabled && <SocioRequests />}
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change this setting.</p>}
            </section>
        </SettingsCard>
    );
}

/**
 * Socios rooms asked for (CB-212), for workspace admins: each room's
 * name, the socio and who asked. Let in makes it answer there; nothing
 * of the room's conversation is shown here.
 */
function SocioRequests() {
    const [requests, setRequests] = useState<RoomSocioRequest[]>();
    const [busy, setBusy] = useState('');
    const load = useCallback((signal?: AbortSignal) => {
        roomsApi.socioRequests(signal).then(setRequests, () => undefined);
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        load(controller.signal);
        return () => controller.abort();
    }, [load]);
    if (!requests?.length) {
        return null;
    }
    return (
        <section className="grid gap-2" data-slot="room-socio-requests">
            <h4 className="font-medium">Socios rooms asked for</h4>
            <ul className="grid gap-2">
                {requests.map((request) => {
                    const key = `${request.roomId}:${request.dotId}`;
                    return (
                        <li key={key} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5">
                            <span className="min-w-0 flex-1">
                                <strong className="font-medium">{request.dotName}</strong> in “{request.roomTitle}”
                                <span className="block text-xs text-muted-foreground">
                                    Asked by {request.requestedByName ?? 'a room admin'}
                                </span>
                            </span>
                            <Button
                                type="button"
                                size="sm"
                                disabled={!!busy}
                                aria-label={`Let ${request.dotName} into ${request.roomTitle}`}
                                onClick={async () => {
                                    setBusy(key);
                                    try {
                                        await roomsApi.authorizeSocio(request.roomId, request.dotId);
                                        toast.success(`${request.dotName} can answer in “${request.roomTitle}”.`);
                                    } catch (error) {
                                        toast.error(failure(error, 'Could not let it in.'));
                                    } finally {
                                        setBusy('');
                                        load();
                                    }
                                }}
                            >
                                Let in
                            </Button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
