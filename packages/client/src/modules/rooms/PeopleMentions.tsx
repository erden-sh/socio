import { AtSign } from 'lucide-react';
import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useState,
    type KeyboardEvent,
    type ReactNode,
    type RefObject,
    type SyntheticEvent,
} from 'react';

import type { TranscriptMention } from '@socio/shared/rooms/room-notices';
import {
    insertMention,
    matchingPeople,
    mentionQuery,
    type MentionablePerson,
    type PersonMention,
} from '@socio/shared/rooms/room-people-mentions';
import { combineMentionables, keptMentions, type MentionCandidate } from '@socio/shared/rooms/room-view';

import { PersonAvatar } from './RoomSpeaker';
import { touchTarget } from './touch';

import { cn } from '@/lib/utils';

/**
 * People's @mentions in the room's composer (CB-216): typing `@` and the
 * start of a name lists the room's members that fit (never anyone outside
 * it, nor the writer); ↑ ↓ move, Enter or Tab picks, Escape closes, and
 * a click picks too. Each shows the avatar the room gives that person,
 * and two people with one name their number too (`personLabels`). A pick puts `@Name` in the text and records the
 * person by id, so two people with one name stay apart; the message
 * carries the picks still in its text (`payload`). Text typed without
 * picking mentions nobody.
 *
 * The composer spreads `inputProps` on its text box, asks `onKeyDown`
 * first, renders `list` above the box and `status` (a polite live region,
 * always there) anywhere, sends `payload(text)` with the message and
 * calls `reset` once it went.
 */
export function usePeopleMentions({
    text,
    setText,
    box,
    people,
    tones,
    labels,
    socios,
    renderSocio,
}: {
    text: string;
    setText: (text: string) => void;
    box: RefObject<HTMLTextAreaElement | null>;
    people: readonly MentionablePerson[];
    /**
     * Each person's avatar tone in the room (`personTones`), so two people
     * with one name look as different here as in the transcript.
     */
    tones?: ReadonlyMap<string, string>;
    /**
     * Two people with one name, in words (`personLabels`): "Ana Lima · 2".
     * The text still gets `@Ana Lima`; the pick is recorded by id.
     */
    labels?: ReadonlyMap<string, string>;
    /**
     * The room's active socios (CB-284), to @mention alongside people. A
     * socio pick inserts `@Name` and routes by the text (no people-mention
     * payload): the server's `parseRoomMentions` names it.
     */
    socios?: readonly MentionCandidate[];
    /** A socio candidate's avatar (its mascot), for the list (CB-284). */
    renderSocio?: (socio: MentionCandidate) => ReactNode;
}) {
    const listId = useId();
    const [picked, setPicked] = useState<PersonMention[]>([]);
    const [caret, setCaret] = useState<number>();
    const [active, setActive] = useState(0);
    // Escape, or a pick, closes the list for the `@` it was open for.
    const [dismissed, setDismissed] = useState<number>();
    const query = caret === undefined ? undefined : mentionQuery(text, Math.min(caret, text.length));
    const all: MentionCandidate[] = socios?.length
        ? combineMentionables(people, socios)
        : people.map((person) => ({ ...person, kind: 'person' as const }));
    const candidates = query && dismissed !== query.start ? matchingPeople(all, query.query) : [];
    const open = candidates.length > 0;
    const current = Math.min(active, Math.max(candidates.length - 1, 0));

    const pick = useCallback(
        (candidate: MentionCandidate) => {
            if (!query || caret === undefined) {
                return;
            }
            const next = insertMention(text, query.start, caret, candidate.name);
            setText(next.text);
            // A person is recorded by id for notification (CB-216); a socio
            // routes by the `@Name` text the server parses (CB-206, CB-284), so
            // it carries no people-mention.
            if (candidate.kind === 'person') {
                setPicked((list) => [
                    ...list.filter((mention) => mention.userId !== candidate.userId),
                    { userId: candidate.userId, label: candidate.name },
                ]);
            }
            setCaret(next.caret);
            setActive(0);
            // The picked name fits its own `@` still: closed for it.
            setDismissed(query.start);
            requestAnimationFrame(() => {
                const textarea = box.current;
                textarea?.focus();
                textarea?.setSelectionRange(next.caret, next.caret);
            });
        },
        [box, caret, query, setText, text],
    );

    // Closed for one `@` only: another (or none) opens it again.
    const start = query?.start;
    useEffect(() => {
        if (dismissed !== undefined && start !== dismissed) {
            setDismissed(undefined);
        }
    }, [dismissed, start]);

    // Typing moves the caret too: read it after each change of the text,
    // while the box has the focus.
    useLayoutEffect(() => {
        const textarea = box.current;
        if (textarea && textarea === document.activeElement) {
            setCaret(textarea.selectionStart);
        }
    }, [box, text]);

    const track = (event: SyntheticEvent<HTMLTextAreaElement>) => {
        const at = event.currentTarget.selectionStart;
        if (at !== caret) {
            setCaret(at);
            setActive(0);
        }
    };

    /** Handles the list's keys while it is open; true when it took the key. */
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!open || event.nativeEvent.isComposing) {
            return false;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((current + step + candidates.length) % candidates.length);
            return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            pick(candidates[current]!);
            return true;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            setDismissed(query?.start);
            return true;
        }
        return false;
    };

    const optionId = (index: number) => `${listId}-option-${index}`;
    const list = open ? (
        <ul
            id={listId}
            role="listbox"
            aria-label="People and socios in the room"
            data-slot="people-mentions"
            // Shorter while a phone's keyboard leaves little room (CB-219).
            className="mb-1 max-h-48 overflow-y-auto rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md keyboard-short:max-h-28"
        >
            {candidates.map((candidate, index) => {
                const socio = candidate.kind === 'socio';
                return (
                    <li
                        key={`${candidate.kind}:${candidate.userId}`}
                        id={optionId(index)}
                        role="option"
                        aria-selected={index === current}
                        data-mention-option={candidate.userId}
                        data-mention-kind={candidate.kind}
                        className={cn(
                            'flex min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-1',
                            touchTarget,
                            index === current && 'bg-accent text-accent-foreground ring-2 ring-ring ring-inset',
                        )}
                        // Keeps the text box focused, and its caret.
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => pick(candidate)}
                    >
                        {socio && renderSocio ? (
                            renderSocio(candidate)
                        ) : (
                            <PersonAvatar name={candidate.name} tone={tones?.get(candidate.userId)} />
                        )}
                        <span className="min-w-0 truncate">
                            {socio ? candidate.name : (labels?.get(candidate.userId) ?? candidate.name)}
                        </span>
                        {socio && (
                            <span className="ml-auto shrink-0 rounded-sm border px-1 text-[10px] leading-4 font-normal text-muted-foreground">
                                {candidate.lead ? 'socio · lead' : 'socio'}
                            </span>
                        )}
                    </li>
                );
            })}
        </ul>
    ) : null;

    // The text box is a textbox, not a combobox (a <textarea> takes no other
    // role), so its list opening is said in words, politely: how many fit,
    // once per change, never per key (CB-219). Socios are named too (CB-284).
    const said = open
        ? (() => {
              const peopleCount = candidates.filter((c) => c.kind === 'person').length;
              const socioCount = candidates.filter((c) => c.kind === 'socio').length;
              const parts: string[] = [];
              if (peopleCount) {
                  parts.push(`${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}`);
              }
              if (socioCount) {
                  parts.push(`${socioCount} ${socioCount === 1 ? 'socio' : 'socios'}`);
              }
              return `${parts.join(' and ')} to mention`;
          })()
        : '';
    const status = (
        <span role="status" className="sr-only" data-slot="people-mentions-status">
            {said}
        </span>
    );

    return {
        list,
        status,
        onKeyDown,
        inputProps: {
            onSelect: track,
            onClick: track,
            'aria-autocomplete': 'list' as const,
            'aria-haspopup': 'listbox' as const,
            'aria-controls': open ? listId : undefined,
            'aria-activedescendant': open ? optionId(current) : undefined,
        },
        /** What the message says of its mentions, if any. */
        payload: (sent: string) => {
            const mentions = keptMentions(sent, picked);
            return mentions.length ? { mentions } : {};
        },
        reset: () => {
            setPicked([]);
            setDismissed(undefined);
        },
    };
}

/**
 * Beside the name of a room message that mentions the reader (CB-216):
 * "@ you", said in words for a screen reader. Only the server's checked
 * mentions show, never `@Name` text alone.
 */
export function MentionedYou({ mentions }: { mentions?: readonly TranscriptMention[] }) {
    if (!mentions?.some((mention) => mention.you)) {
        return null;
    }
    return (
        <span
            data-slot="mentioned-you"
            // The transcript's link teal in light: the brand is under 4.5:1 on its
            // tint at this size (CB-219).
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-primary/10 px-1 text-[10px] leading-4 font-medium text-[#357360] dark:text-primary"
        >
            <AtSign className="size-3" aria-hidden />
            <span aria-hidden>you</span>
            <span className="sr-only">mentions you</span>
        </span>
    );
}
