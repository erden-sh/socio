import { Mail } from 'lucide-react';
import { useState } from 'react';

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
                {only ? `You’re invited to the room “${only.title}”.` : `You’re invited to ${invites.length} rooms.`}
            </p>
            <Button size="sm" variant="outline" className={touchTarget} onClick={() => setOpen(true)}>
                Review
            </Button>
            <InvitesDialog open={open} onOpenChange={setOpen} invites={invites} onChanged={() => void reload()} />
        </div>
    );
}
