import { Mail } from 'lucide-react';
import { useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { roomsOn } from '@socio/shared/rooms/room-view';

import { useShell } from '../../shell/shell-context';

import { InvitesDialog } from './RoomDialogs';
import { touchTarget } from './touch';
import { useRoomInvites } from './use-room';

import { Button } from '@/components/ui/button';

/**
 * On Home (CB-212): "You're invited to 2 rooms", with Review, while
 * Rooms are on and an invitation waits. The sidebar lists them too, but
 * a phone's sidebar is closed, so an invitation would go unseen.
 */
export function RoomInvitesNotice() {
    const { t } = useTranslation(['rooms.nav']);
    const { state, workspace } = useShell();
    const { invites, reload } = useRoomInvites(roomsOn(state), workspace);
    const [open, setOpen] = useState(false);
    if (!invites.length) {
        return null;
    }
    const only = invites.length === 1 ? invites[0] : undefined;
    return (
        <div
            role="status"
            data-slot="room-invites-notice"
            className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/50 px-4 py-3 text-sm"
        >
            <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="min-w-0 flex-1">
                {only
                    ? t('rooms.nav:invites.one', { title: only.title })
                    : t('rooms.nav:invites.many', { count: invites.length })}
            </p>
            <Button size="sm" variant="outline" className={touchTarget} onClick={() => setOpen(true)}>
                {t('rooms.nav:invites.review')}
            </Button>
            <InvitesDialog open={open} onOpenChange={setOpen} invites={invites} onChanged={() => void reload()} />
        </div>
    );
}
