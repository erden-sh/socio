import type { Message } from '@ag-ui/core';
import { Bot } from 'lucide-react';

import type { TranscriptMention } from '@socio/shared/rooms/room-notices';
import { initials, personTones as personToneIndexes, toneIndex } from '@socio/shared/rooms/room-speakers';
import type { Dot, MessageAuthor } from '@socio/shared/types';

import { Mascot } from '../../locals/Mascot';

import { MentionedYou } from './PeopleMentions';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/** A room message's checked mentions (CB-216), as the transcript gives them. */
type RoomMentioned = { mentions?: TranscriptMention[] };

// Soft tones for people's avatars, picked by name: a help to tell people
// apart at a glance, never the only cue (the name is always beside it).
const TONES = [
    'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100',
    'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
    'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100',
    'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
    'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100',
    'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
];
export const toneOf = (name: string) => TONES[toneIndex(name, TONES.length)]!;

/** Each person's avatar tone in a room, by id, as a class (shared's `personTones`). */
export const personTones = (people: Iterable<{ id?: string; name: string }>): Map<string, string> =>
    new Map([...personToneIndexes(people, TONES.length)].map(([id, at]) => [id, TONES[at]!]));

/** A person's round avatar: their initials. The name is said beside it. */
export function PersonAvatar({
    name,
    tone,
    className,
}: {
    name: string;
    /** Their tone in the room (`personTones`); else their name's. */
    tone?: string;
    className?: string;
}) {
    return (
        <Avatar className={cn('size-5', className)} aria-hidden>
            <AvatarFallback className={cn('text-[9px] font-semibold', tone ?? toneOf(name))}>
                {initials(name)}
            </AvatarFallback>
        </Avatar>
    );
}

/**
 * Who wrote a room message (CB-212), above it: the socio with its mascot
 * and a "socio" tag, another person with their avatar and name, the
 * reader's own as "You". In words, never by color or side alone, so
 * a screen reader and a phone's narrow column tell them apart too. Names
 * are the server's (CB-210 stamps the sender's id); a message stored
 * before senders were recorded shows as a team member's.
 */
export function RoomSpeaker({
    message,
    dot,
    socioName,
    tone,
    shownName,
}: {
    message: Message & { author?: MessageAuthor };
    /**
     * The socio that wrote a reply: the one the reply names (CB-212), else
     * the lead of a one-socio room. Undefined when it isn't known: then it
     * says `socioName`, or "A socio".
     */
    dot?: Dot;
    /** The reply's socio's name, when it is no socio this reader has. */
    socioName?: string;
    /** The person's avatar tone in this room (`personTones`). */
    tone?: string;
    /**
     * The person's name as the room shows it, when another active member
     * shares it (`personLabels`): "Ana Lima · 2".
     */
    shownName?: string;
}) {
    const label = 'flex max-w-full min-w-0 items-center gap-1.5 px-1 text-[12px] font-medium text-muted-foreground';
    if (message.role === 'assistant' && !dot) {
        return (
            <span className={label} data-room-speaker="socio">
                <Bot className="size-4 shrink-0" aria-hidden />
                <span className="truncate text-foreground">{socioName ?? 'A socio'}</span>
                {socioName && (
                    <span className="shrink-0 rounded-sm border px-1 text-[10px] leading-4 font-normal">socio</span>
                )}
            </span>
        );
    }
    if (message.role === 'assistant' && dot) {
        return (
            <span className={label} data-room-speaker="socio">
                <Mascot
                    identity={dot.id}
                    character={dot.character}
                    name={dot.name}
                    small
                    decorative
                    className="size-5 shrink-0"
                />
                <span className="truncate text-foreground">{dot.name}</span>
                <span className="shrink-0 rounded-sm border px-1 text-[10px] leading-4 font-normal">socio</span>
            </span>
        );
    }
    if (message.role !== 'user') {
        return null;
    }
    if (message.author?.you) {
        return (
            <span className={label} data-room-speaker="you">
                You
            </span>
        );
    }
    const name = message.author?.name ?? 'Team member';
    return (
        <span className={label} data-room-speaker="person" data-chat-author>
            <PersonAvatar name={name} tone={tone} />
            <span className="truncate">{shownName ?? name}</span>
            <MentionedYou mentions={(message as RoomMentioned).mentions} />
        </span>
    );
}
