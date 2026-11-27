import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_SKILLS } from '@socio/shared/chat/chat-skills';

import { bubbleStyle } from '../../src/chat/bubble-style';
import {
    CHAT_SKILLS_PATH,
    createChatSkills,
    messageSkill,
    namesUnknownSkill,
    SKILLS_FRESH_MS,
} from '../../src/chat/chat-skills';
import { holdsLink } from '../../src/chat/markdown-links';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { colorsOf } from '../../src/theme/theme';

// CB-415: a person's own messages, and other people's in a room, are Markdown
// in their bubble's colors (the web's `Markdown onBubble`), and a message that
// invoked a chat skill shows it as a chip above the rest (the web's SkillChip).

const SRC = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the skill a message invoked', () => {
    it('is read from the whole message, as the server reads it: never after a quote-reply’s quote', () => {
        // Sol's review of #57: reading the words after the quote showed a chip for a skill that never ran.
        expect(read('screens/message-text.tsx')).toMatch(/messageSkill\(text, known\)/);
        expect(read('screens/message-text.tsx')).not.toMatch(/messageSkill\(rest/);
    });

    it('is a built-in or workspace skill the message starts with, and the words after it', () => {
        expect(messageSkill('/grill-me the onboarding plan', BUILT_IN_SKILLS)).toEqual({
            name: 'grill-me',
            rest: 'the onboarding plan',
        });
        expect(messageSkill('/compact', BUILT_IN_SKILLS)).toEqual({ name: 'compact', rest: '' });
        // Telegram's underscores name the same skill.
        expect(messageSkill('/grill_me now', BUILT_IN_SKILLS)?.name).toBe('grill-me');
        expect(messageSkill('/standup notes', [...BUILT_IN_SKILLS, { name: 'standup' }])).toEqual({
            name: 'standup',
            rest: 'notes',
        });
    });

    it('is none for a `/word` no skill has, or a slash later in the text', () => {
        expect(messageSkill('/etc/hosts is the file', BUILT_IN_SKILLS)).toBeNull();
        expect(messageSkill('see /compact', BUILT_IN_SKILLS)).toBeNull();
        expect(namesUnknownSkill('/standup notes', BUILT_IN_SKILLS)).toBe(true);
        expect(namesUnknownSkill('/compact', BUILT_IN_SKILLS)).toBe(false);
        expect(namesUnknownSkill('Hello', BUILT_IN_SKILLS)).toBe(false);
    });
});

describe("the workspace's skills", () => {
    it('are the built-in ones until read, then the server’s, read at most once a minute', async () => {
        let clock = 1_000;
        const fetch = vi.fn<AuthedFetch>(async () => answer(200, { skills: [{ name: 'standup' }, { bad: 1 }] }));
        const skills = createChatSkills({ fetch, now: () => clock });
        expect(skills.known()).toBe(BUILT_IN_SKILLS);
        const changed = vi.fn();
        skills.subscribe(changed);
        skills.load();
        skills.load();
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(CHAT_SKILLS_PATH, undefined);
        expect(skills.known()).toEqual([{ name: 'standup' }]);
        skills.load();
        expect(fetch).toHaveBeenCalledTimes(1);
        clock += SKILLS_FRESH_MS;
        skills.load();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('keep the built-in ones when the read fails, and ask again only after a minute', async () => {
        let clock = 0;
        const onError = vi.fn();
        const fetch = vi.fn<AuthedFetch>(async () => answer(500, { error: 'boom' }));
        const skills = createChatSkills({ fetch, now: () => clock, onError });
        skills.load();
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
        expect(skills.known()).toBe(BUILT_IN_SKILLS);
        skills.load();
        expect(fetch).toHaveBeenCalledTimes(1);
        clock += SKILLS_FRESH_MS;
        skills.load();
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('Markdown in a bubble', () => {
    const colors = colorsOf('light');
    const reply = {
        paragraph: { color: colors.foreground, fontSize: 14 },
        link: { color: colors['chat-link'], underline: true },
        linkVariants: { '^/issues/CB-1$': { pill: true } },
        code: { color: colors.foreground, backgroundColor: colors.muted },
        codeBlock: { color: colors.foreground, syntaxColors: { keyword: '#cf222e', string: '#0a3069' } },
    };

    it('takes the teal bubble’s white words, its links underlined in them and plain, its code one color', () => {
        const own = bubbleStyle(reply, colors, 'own');
        expect(own.paragraph).toMatchObject({ color: colors['user-bubble-foreground'], fontSize: 14 });
        expect(own.link).toEqual({ color: colors['user-bubble-foreground'], underline: true });
        expect(own.linkVariants).toEqual({});
        expect(own.code?.color).toBe(colors['user-bubble-foreground']);
        expect(own.code?.backgroundColor).not.toBe(colors.muted);
        expect(own.codeBlock?.syntaxColors).toEqual({
            keyword: colors['user-bubble-foreground'],
            string: colors['user-bubble-foreground'],
        });
    });

    it('in a waiting bubble or another person’s, the dark words and the chat’s link color', () => {
        const pending = bubbleStyle(reply, colors, 'pending');
        expect(pending.paragraph?.color).toBe(colors['user-bubble-pending-foreground']);
        expect(pending.link).toEqual({ color: colors['chat-link'], underline: true });
        const other = bubbleStyle(reply, colors, 'other');
        expect(other.paragraph?.color).toBe(colors.foreground);
        // Code on the muted bubble isn't muted on muted.
        expect(other.code?.backgroundColor).toBe(colors.background);
        expect(other.codeBlock?.syntaxColors).toEqual(reply.codeBlock.syntaxColors);
        // A reply keeps its style.
        expect(bubbleStyle(reply, colors, undefined)).toBe(reply);
    });

    it('is drawn for the person’s bubble, a pending one and another’s waiting one, never as plain text', () => {
        const chat = read('screens/chat.tsx');
        expect(chat).toContain("<MessageText text={row.text} surface={theirs ? 'other' : 'own'} />");
        expect(chat).not.toContain('<Text variant="message"');
        expect(read('screens/chat-composer.tsx')).toContain(
            "surface={bubble.waiting || bubble.problem ? 'pending' : 'own'}",
        );
        expect(read('screens/room-parts.tsx')).toContain('<MessageText text={bubble.text} surface="other" />');
        const text = read('screens/message-text.tsx');
        // Made safe as a reply is: nothing in a person's message fetches.
        expect(text).toContain('markdown={safeMarkdown(words)}');
        expect(text).toContain('<SkillChip name={skill.name} surface={surface} />');
    });

    it('is not one accessible element when it holds a link, so its links stay reachable', () => {
        expect(holdsLink('See [the plan](/spaces/a/pages/b)')).toBe(true);
        expect(holdsLink('Docs at https://example.test and <mailto:a@b.test>')).toBe(true);
        expect(holdsLink('www.example.test')).toBe(true);
        expect(holdsLink('Just words [in brackets] and (parens).')).toBe(false);
        expect(read('screens/chat.tsx')).toContain(
            'holdsLink(row.text)\n                                ? { accessible: false }',
        );
    });
});
