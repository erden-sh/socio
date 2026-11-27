import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { invokedSkill, type ActiveChatSkill, type ChatSkillView } from '@socio/shared/chat/chat-skills';

import { api } from '../../lib/api';

import { matchSkills, skillQuery, useChatSkills } from './chat-skills';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The composer's `/` menu (CB-143): typing `/` at the start of an empty
 * message lists the chat skills, narrowed as the name is typed. Arrow keys
 * move and Tab picks; Enter picks only once the arrow keys moved, and
 * otherwise sends what was typed (`/c` as it is, `/compact` the skill).
 * Escape closes; a click picks too. Picking puts `/name ` in the box.
 */
export function useSkillMenu(
    draft: string,
    setDraft: (value: string) => void,
    box: RefObject<HTMLTextAreaElement | null>,
) {
    const { t } = useTranslation(['chat.composer']);
    const { skills, load } = useChatSkills();
    const id = useId();
    const [active, setActive] = useState(0);
    // The arrow keys moved the highlight since the name last changed.
    const [moved, setMoved] = useState(false);
    // The draft Escape closed the menu at, until it changes.
    const [closedAt, setClosedAt] = useState<string>();
    const query = skillQuery(draft);
    const matches = query === undefined || closedAt === draft ? [] : matchSkills(skills, query);
    const open = matches.length > 0;
    // Read the workspace's skills again each time a message starts with `/`,
    // typed or pasted, so the menu has an admin's newest and the message is
    // sent with its skill's name first (`skillFirst`).
    const typing = draft.startsWith('/');
    useEffect(() => {
        if (typing) {
            load(true);
        }
    }, [typing, load]);
    useEffect(() => {
        setActive(0);
        setMoved(false);
    }, [query]);
    const current = matches[Math.min(active, matches.length - 1)];
    const pick = (skill: ChatSkillView) => {
        const value = `/${skill.name} `;
        setDraft(value);
        box.current?.focus();
        requestAnimationFrame(() => box.current?.setSelectionRange(value.length, value.length));
    };
    /** Handles a key for the open menu; true when it did. */
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        // Never while an IME is composing: its keys pick a candidate.
        if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            return false;
        }
        const move = (by: number) => {
            setActive((at) => (at + by + matches.length) % matches.length);
            setMoved(true);
        };
        switch (event.key) {
            case 'ArrowDown':
                move(1);
                break;
            case 'ArrowUp':
                move(-1);
                break;
            case 'Tab':
                if (event.shiftKey) {
                    return false;
                }
                pick(current);
                break;
            case 'Enter':
                // Unless the arrow keys chose one, Enter sends what was typed.
                if (event.shiftKey || !moved) {
                    return false;
                }
                pick(current);
                break;
            case 'Escape':
                setClosedAt(draft);
                break;
            default:
                return false;
        }
        event.preventDefault();
        return true;
    };
    const optionId = (index: number) => `${id}-skill-${index}`;
    return {
        skills,
        onKeyDown,
        /** For the text box: what assistive technology reads of the menu. */
        boxProps: {
            'aria-autocomplete': 'list' as const,
            'aria-controls': open ? `${id}-skills` : undefined,
            'aria-activedescendant': open ? optionId(matches.indexOf(current)) : undefined,
        },
        menu: (
            <div data-slot="skill-menu-anchor" className="relative">
                {open && (
                    <ul
                        id={`${id}-skills`}
                        role="listbox"
                        aria-label={t('chat.composer:skills.menu')}
                        data-slot="skill-menu"
                        className="absolute inset-x-0 bottom-full z-20 mb-3 max-h-64 overflow-y-auto rounded-[14px] border bg-popover p-1 text-popover-foreground shadow-md"
                    >
                        {matches.map((skill, index) => (
                            <li
                                key={skill.name}
                                id={optionId(index)}
                                role="option"
                                aria-selected={skill === current}
                                data-skill={skill.name}
                                className="flex cursor-default flex-col gap-0.5 rounded-[10px] px-2.5 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground aria-selected:ring-2 aria-selected:ring-ring aria-selected:ring-inset"
                                // Keeps the focus in the text box.
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => setActive(index)}
                                onClick={() => pick(skill)}
                            >
                                <span className="font-medium">/{skill.name}</span>
                                <span className="text-xs text-muted-foreground">{skill.description}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        ),
    };
}

/**
 * A person's message that invoked a skill: the skill as a chip, then what
 * they wrote after it (CB-143). The workspace's skills are read when a
 * message names one the built-ins don't have.
 */
export function useSkillSplit(text: string) {
    const { skills, load } = useChatSkills();
    const invoked = invokedSkill(text, skills);
    const named = !invoked && /^\s*\/[a-z0-9]/i.test(text);
    useEffect(() => {
        if (named) {
            load();
        }
    }, [named, load]);
    return invoked;
}

export function SkillChip({ name, className }: { name: string; className?: string }) {
    return (
        <span
            data-slot="skill-chip"
            className={cn(
                'inline-flex w-fit items-center rounded-full bg-current/15 px-2 py-px text-[11px]/[1.7] font-medium',
                className,
            )}
        >
            /{name}
        </span>
    );
}

/**
 * The skill on in a chat until it ends (CB-143, `until-done`, such as
 * `/grill-me`): read when the chat opens and after each turn, and ended
 * from the composer.
 */
export function useActiveSkill(threadId: string, running: boolean) {
    const { t } = useTranslation(['chat.composer']);
    const [active, setActive] = useState<ActiveChatSkill | null>(null);
    const path = `/chat-skills/threads/${encodeURIComponent(threadId)}`;
    useEffect(() => {
        if (running) {
            return;
        }
        let live = true;
        api<{ active: ActiveChatSkill | null }>(path)
            .then((answer) => {
                if (live) {
                    setActive(answer.active ?? null);
                }
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [path, running]);
    const end = () =>
        api(`${path}/end`, 'POST')
            .then(() => setActive(null))
            .catch((error) =>
                toast.error(error instanceof Error ? error.message : t('chat.composer:skills.end-failed')),
            );
    return { active, end };
}

/** Above the composer's text box while a skill is on, with a way to end it. */
export function ActiveSkillBar({
    active,
    onEnd,
    disabled,
}: {
    active: ActiveChatSkill | null;
    onEnd: () => void;
    disabled?: boolean;
}) {
    const { t } = useTranslation(['chat.composer']);
    if (!active) {
        return null;
    }
    return (
        <div
            data-slot="active-skill"
            className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b pt-1.5 pr-0.5 pb-2 pl-1 text-[13px]/[1.4] text-foreground"
        >
            <SkillChip name={active.name} className="bg-muted text-foreground" />
            <p className="m-0 min-w-0 flex-[1_1_14rem] text-[12px]/[1.7] text-muted-foreground">
                {t('chat.composer:skills.active')}
            </p>
            <Button type="button" variant="outline" size="sm" className="ml-auto" disabled={disabled} onClick={onEnd}>
                {t('chat.composer:skills.end')}
            </Button>
        </div>
    );
}
