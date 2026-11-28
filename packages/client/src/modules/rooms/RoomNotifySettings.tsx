import { useId, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    DEFAULT_ROOM_NOTIFY_LEVEL,
    ROOM_NOTIFY_CHOICES,
    ROOM_NOTIFY_LEVELS,
    type RoomNotifyLevel,
    type RoomNotifySetting,
} from '@socio/shared/rooms/room-notices';
import { roomsOn } from '@socio/shared/rooms/room-view';
import type { Conversation } from '@socio/shared/types';

import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';
import { SettingsCard } from '../settings/AccountSettings';

import { failure } from './api';
import { touchTarget } from './touch';

import {
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';

/** The reader's level in a room, as the chat list gives it. */
export const roomNotifyLevel = (thread: Pick<Conversation, 'roomNotify'>) =>
    thread.roomNotify ?? DEFAULT_ROOM_NOTIFY_LEVEL;

/** The room is muted for the reader: its news shows, quietly. */
export const roomMuted = (thread: Pick<Conversation, 'roomNotify'>) => thread.roomNotify === 'mute';

const isLevel = (value: string): value is RoomNotifyLevel => (ROOM_NOTIFY_LEVELS as readonly string[]).includes(value);

/**
 * In a room's ⋯ menu (CB-216): what of the room reaches the reader as
 * notifications, theirs alone to choose: everything, mentions and their
 * own turns (the default), or nothing. Saved at once; their other devices
 * follow at their next poll.
 */
export function RoomNotifyItems({ thread }: { thread: Conversation }) {
    const { t } = useTranslation(['rooms.nav']);
    const shell = useShell();
    const labelId = useId();
    const [level, setLevel] = useState(roomNotifyLevel(thread));
    const save = async (next: string) => {
        if (!isLevel(next) || next === level) {
            return;
        }
        const previous = level;
        setLevel(next);
        try {
            await api<RoomNotifySetting>(`/rooms/${encodeURIComponent(thread.id)}/notifications`, 'PUT', {
                level: next,
            });
            // Show the change at once in the sidebar (the crossed bell and the
            // quieter unread count), before the refresh round-trip reconciles
            // it: the workspace's room row reads `roomNotify` from here (Rooms
            // follow-ups). `mentions` is the default, stored as no row, so it
            // patches to `undefined` to match what the server's list carries.
            shell.patchConversation(thread.id, {
                roomNotify: next === DEFAULT_ROOM_NOTIFY_LEVEL ? undefined : next,
            });
            await shell.refresh();
        } catch (error) {
            setLevel(previous);
            shell.patchConversation(thread.id, {
                roomNotify: previous === DEFAULT_ROOM_NOTIFY_LEVEL ? undefined : previous,
            });
            toast.error(failure(error, t('rooms.nav:errors.notify')));
        }
    };
    return (
        <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel id={labelId} className="text-xs font-normal text-muted-foreground">
                {t('rooms.nav:menu.notify')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
                aria-labelledby={labelId}
                value={level}
                onValueChange={(next) => void save(next)}
                data-slot="room-notify"
            >
                {ROOM_NOTIFY_CHOICES.map((choice) => (
                    <DropdownMenuRadioItem
                        key={choice.level}
                        value={choice.level}
                        title={choice.note}
                        className={touchTarget}
                        // Keeps the menu open, so the choice shows as made.
                        onSelect={(event) => event.preventDefault()}
                    >
                        {choice.label}
                    </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
        </>
    );
}

/**
 * Account → Notifications → Rooms (CB-216), while Rooms are on: whether a
 * room's members see when the person is looking at it, and where each
 * room's own notifications are chosen.
 */
export function RoomNotificationsCard() {
    const { t } = useTranslation(['rooms.notify']);
    const { state, workspace, mutate } = useShell();
    const [busy, setBusy] = useState(false);
    // A shell without its state yet (a test's) shows none of it.
    if (!state || !roomsOn(state)) {
        return null;
    }
    const shown = workspace.preferences?.roomPresence !== 'hidden';
    return (
        <SettingsCard>
            <section className="grid gap-3" data-slot="room-notifications">
                <h3 className="font-medium">{t('rooms.notify:title')}</h3>
                <p className="text-muted-foreground">{t('rooms.notify:body')}</p>
                <label className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                        <span className="font-medium">{t('rooms.notify:presence.label')}</span>
                        <span className="block text-muted-foreground">{t('rooms.notify:presence.hint')}</span>
                    </span>
                    <Switch
                        aria-label={t('rooms.notify:presence.label')}
                        checked={shown}
                        disabled={busy}
                        onCheckedChange={async (show) => {
                            setBusy(true);
                            if (
                                await mutate('/preferences', 'PATCH', {
                                    roomPresence: show ? 'shown' : 'hidden',
                                })
                            ) {
                                toast.success(
                                    show ? t('rooms.notify:presence.shown') : t('rooms.notify:presence.hidden'),
                                );
                            }
                            setBusy(false);
                        }}
                    />
                </label>
            </section>
        </SettingsCard>
    );
}
