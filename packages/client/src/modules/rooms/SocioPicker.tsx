import { AtSign, ArrowRightLeft } from 'lucide-react';
import { useRef } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { handoffLine, type TranscriptHandoff } from '@socio/shared/rooms/room-handoffs';
import { answeringSocios } from '@socio/shared/rooms/room-view';
import type { RoomSocioView } from '@socio/shared/rooms/rooms';

import { useOnDemand } from '../../i18n/on-demand';
import { ChatIconButton } from '../chat/chat-chrome';

import { touchTarget } from './touch';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * The composer's socio picker (CB-206): the room's socios, to ask one by
 * name. Picking one writes `@Name` into the message, where everyone sees
 * it; the message then goes to that socio instead of the lead. Shown only
 * when the room has more than one socio.
 */
export function SocioPicker({
    socios,
    onPick,
    disabled,
}: {
    socios: readonly RoomSocioView[];
    onPick: (socio: RoomSocioView) => void;
    disabled?: boolean;
}) {
    const { t } = useTranslation(['rooms']);
    // Its words are the room's (rooms), which RoomChat waits for.
    const ready = useOnDemand(['rooms']);
    const active = answeringSocios(socios);
    // A socio picked: focus goes back to the message (`onPick`), not to
    // the picker, so the person types on after the name.
    const picked = useRef(false);
    if (!ready || active.length < 2) {
        return null;
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <ChatIconButton
                    aria-label={t('rooms:picker.label')}
                    title={t('rooms:picker.title')}
                    className="size-11"
                    data-slot="socio-picker"
                >
                    <AtSign size={17} />
                </ChatIconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="min-w-48"
                onCloseAutoFocus={(event) => {
                    if (picked.current) {
                        event.preventDefault();
                    }
                    picked.current = false;
                }}
            >
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {t('rooms:picker.heading')}
                </DropdownMenuLabel>
                {active.map((socio) => (
                    <DropdownMenuItem
                        key={socio.dotId}
                        data-socio={socio.dotId}
                        className={touchTarget}
                        onSelect={() => {
                            picked.current = true;
                            onPick(socio);
                        }}
                    >
                        <span className="min-w-0 flex-1 truncate">{socio.name}</span>
                        {socio.lead && (
                            <span className="shrink-0 text-[11px] text-muted-foreground">{t('rooms:picker.lead')}</span>
                        )}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * A handoff between the room's socios (CB-206), as a line between the
 * replies: who handed the message's work to whom, and why. Its words,
 * never by color alone.
 */
export function HandoffNotice({ handoff }: { handoff: TranscriptHandoff }) {
    return (
        <p
            role="note"
            data-room-handoff={handoff.kind}
            className="mx-auto my-1 flex max-w-full items-start gap-1.5 px-2 text-center text-[12px]/[1.5] text-muted-foreground"
        >
            <ArrowRightLeft className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{handoffLine(handoff)}</span>
        </p>
    );
}
