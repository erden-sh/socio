import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { RoomSocioRequest, RoomsReadiness, RoomsSettings } from '@socio/shared/rooms/rooms';

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { failure, roomsApi } from '../rooms/api';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';
import { Button } from '@/components/ui/button';

/** The reconcile line before Rooms is turned on. */
export function useReadinessLine() {
    const { t } = useTranslation(['settings.workspace-rooms']);
    return (readiness: RoomsReadiness) => {
        const { private: own, room } = readiness.conversations;
        if (readiness.allPrivate) {
            return t('settings.workspace-rooms:readiness.allPrivate', { count: own });
        }
        return t('settings.workspace-rooms:readiness.mixed', {
            chats: t('settings.workspace-rooms:readiness.chats', { count: own }),
            rooms: t('settings.workspace-rooms:readiness.rooms', { count: room }),
        });
    };
}

/**
 * Rooms (CB-207) in Settings → Workspace → General: the admin's switch for
 * shared rooms, off by default, over `ROOMS_ENABLED`. Members read it;
 * admins change it and see how many chats are private before they do.
 * And whether members see their room's use and limits (CB-218), off by
 * default, over `ROOMS_BUDGET_VISIBLE`.
 */
function RoomsSettingBody({
    settings,
    readOnly,
    mutate,
}: {
    settings: Partial<RoomsSettings> | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace-rooms', 'settings.workspace']);
    const readinessLine = useReadinessLine();
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
                <AutosaveHeader
                    title={t('settings.workspace-rooms:title')}
                    status={!readOnly ? auto.status : undefined}
                >
                    {t('settings.workspace-rooms:intro')}
                </AutosaveHeader>
                <PermissionRow
                    title={t('settings.workspace-rooms:enable.title')}
                    checked={auto.value.enabled}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { enabled: on },
                            t('settings.workspace-rooms:enable.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace-rooms:enable.description')}
                </PermissionRow>
                <PermissionRow
                    title={t('settings.workspace-rooms:budget.title')}
                    checked={auto.value.budgetVisible}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { budgetVisible: on },
                            t('settings.workspace-rooms:budget.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace-rooms:budget.description')}
                </PermissionRow>
                {readiness && (
                    <p className="text-muted-foreground" data-slot="rooms-readiness">
                        {readinessLine(readiness)}
                    </p>
                )}
                {!readOnly && settings?.enabled && <SocioRequests />}
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.setting')}</p>}
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
    const { t } = useTranslation(['settings.workspace-rooms']);
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
            <h4 className="font-medium">{t('settings.workspace-rooms:requests.title')}</h4>
            <ul className="grid gap-2">
                {requests.map((request) => {
                    const key = `${request.roomId}:${request.dotId}`;
                    return (
                        <li key={key} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5">
                            <span className="min-w-0 flex-1">
                                <Trans
                                    t={t}
                                    i18nKey="settings.workspace-rooms:requests.request"
                                    values={{ socio: request.dotName, room: request.roomTitle }}
                                    components={{ socio: <strong className="font-medium" /> }}
                                />
                                <span className="block text-xs text-muted-foreground">
                                    {request.requestedByName
                                        ? t('settings.workspace-rooms:requests.askedBy', {
                                              name: request.requestedByName,
                                          })
                                        : t('settings.workspace-rooms:requests.askedByAdmin')}
                                </span>
                            </span>
                            <Button
                                type="button"
                                size="sm"
                                disabled={!!busy}
                                aria-label={t('settings.workspace-rooms:requests.letInLabel', {
                                    socio: request.dotName,
                                    room: request.roomTitle,
                                })}
                                onClick={async () => {
                                    setBusy(key);
                                    try {
                                        await roomsApi.authorizeSocio(request.roomId, request.dotId);
                                        toast.success(
                                            t('settings.workspace-rooms:requests.letInDone', {
                                                socio: request.dotName,
                                                room: request.roomTitle,
                                            }),
                                        );
                                    } catch (error) {
                                        toast.error(failure(error, t('settings.workspace-rooms:requests.letInFailed')));
                                    } finally {
                                        setBusy('');
                                        load();
                                    }
                                }}
                            >
                                {t('settings.workspace-rooms:requests.letIn')}
                            </Button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

/** Below the fold: its words load when it mounts (settings.workspace-rooms, in no route's entry). */
export const RoomsSetting = onDemand(['settings.workspace-rooms'], RoomsSettingBody);
