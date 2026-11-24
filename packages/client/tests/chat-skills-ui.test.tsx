import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { BUILT_IN_SKILLS } from '@socio/shared/chat/chat-skills';

import { useFitComposer } from '../src/modules/chat/chat-composer';
import { loadChatSkills, matchSkills, skillFirst, skillQuery } from '../src/modules/chat/chat-skills';
import { ChatTranscript } from '../src/modules/chat/ChatTranscript';
import { ActiveSkillBar, useActiveSkill, useSkillMenu } from '../src/modules/chat/SkillMenu';
import { ChatSkillsSection } from '../src/modules/settings/ChatSkillsSection';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    vi.restoreAllMocks();
});

const mount = (node: React.ReactNode) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(node));
    return host;
};

/** A composer as the chat's: the `/` menu, then Enter sends. */
function Composer({ onSend }: { onSend: (text: string) => void }) {
    const [draft, setDraft] = useState('');
    const box = useFitComposer(draft);
    const menu = useSkillMenu(draft, setDraft, box);
    return (
        <form>
            {menu.menu}
            <textarea
                ref={box}
                aria-label="Message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                {...menu.boxProps}
                onKeyDown={(event) => {
                    if (menu.onKeyDown(event)) {
                        return;
                    }
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        onSend(draft);
                    }
                }}
            />
        </form>
    );
}

const box = () => host!.querySelector('textarea')!;
const type = (value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
        setValue.call(box(), value);
        box().dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const press = (key: string) =>
    act(() => {
        box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
const options = () =>
    [...host!.querySelectorAll('[role="option"]')].map((option) => [
        option.getAttribute('data-skill'),
        option.getAttribute('aria-selected'),
    ]);

it('narrows skills by the name being typed, once the draft is a `/` and a name', () => {
    expect(skillQuery('/')).toBe('');
    expect(skillQuery('/Grill_m')).toBe('grill-m');
    expect(skillQuery('/grill-me my idea')).toBeUndefined();
    expect(skillQuery('hi /grill')).toBeUndefined();
    expect(matchSkills(BUILT_IN_SKILLS, 'p').map((skill) => skill.name)).toEqual(['compact', 'help', 'report']);
    expect(matchSkills(BUILT_IN_SKILLS, 'me').map((skill) => skill.name)).toEqual(['grill-me']);
    expect(matchSkills(BUILT_IN_SKILLS, 'gr').map((skill) => skill.name)).toEqual(['grill-me']);
});

it('keeps a skill’s name first, with the source around the text after it', () => {
    const source = (text: string) => `From https://x.test/a:\n\n${text}`;
    expect(skillFirst('/grill-me ship Friday', BUILT_IN_SKILLS, source)).toBe(
        '/grill-me From https://x.test/a:\n\nship Friday',
    );
    expect(skillFirst('/compact', BUILT_IN_SKILLS, source)).toBe('/compact');
    expect(skillFirst('/grill_me x', BUILT_IN_SKILLS, source)).toBe('/grill-me From https://x.test/a:\n\nx');
    // An unknown command is text like any other.
    expect(skillFirst('/frobnicate x', BUILT_IN_SKILLS, source)).toBe(source('/frobnicate x'));
});

it('opens the `/` menu, moves and picks by keyboard, and closes on Escape', () => {
    // Offline: the built-in skills only.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const sent: string[] = [];
    mount(<Composer onSend={(text) => sent.push(text)} />);
    expect(host!.querySelector('[role="listbox"]')).toBeNull();
    type('/');
    expect(options()).toEqual([
        ['compact', 'true'],
        ['done', 'false'],
        ['grill-me', 'false'],
        ['help', 'false'],
        ['report', 'false'],
        ['unfurl', 'false'],
    ]);
    expect(box().getAttribute('aria-controls')).toBe(host!.querySelector('[role="listbox"]')!.id);
    press('ArrowDown');
    expect(options()[1]).toEqual(['done', 'true']);
    expect(box().getAttribute('aria-activedescendant')).toBe(host!.querySelectorAll('[role="option"]')[1].id);
    press('ArrowUp');
    press('ArrowUp');
    expect(options()[5]).toEqual(['unfurl', 'true']);
    // Once the arrow keys chose one, Enter picks it: the name and a space,
    // and the menu closes; nothing sent.
    type('/gr');
    expect(options()).toEqual([['grill-me', 'true']]);
    press('ArrowDown');
    press('Enter');
    expect(box().value).toBe('/grill-me ');
    expect(host!.querySelector('[role="listbox"]')).toBeNull();
    expect(sent).toEqual([]);
    // Escape closes it until the draft changes.
    type('/c');
    expect(options()).toEqual([['compact', 'true']]);
    press('Escape');
    expect(host!.querySelector('[role="listbox"]')).toBeNull();
    type('/co');
    expect(options()).toEqual([['compact', 'true']]);
    // Tab completes.
    press('Tab');
    expect(box().value).toBe('/compact ');
    // Enter without the arrow keys sends what was typed: a name in full, or
    // a word that only starts one (`/c`, `/me`), as it is.
    type('/compact');
    press('Enter');
    type('/c');
    press('Enter');
    type('/me');
    press('Enter');
    // No skill by that name: no menu, and Enter sends it as text.
    type('/zz');
    expect(host!.querySelector('[role="listbox"]')).toBeNull();
    press('Enter');
    expect(sent).toEqual(['/compact', '/c', '/me', '/zz']);
});

it('leaves keys to an IME while it composes', () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mount(<Composer onSend={() => {}} />);
    type('/');
    const ime = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
    });
    act(() => {
        box().dispatchEvent(ime);
    });
    expect(ime.defaultPrevented).toBe(false);
    expect(options()[0]).toEqual(['compact', 'true']);
});

it('lists the workspace’s skills once a `/` is typed, and picks one by click', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
            JSON.stringify({
                skills: [
                    ...BUILT_IN_SKILLS,
                    {
                        name: 'standup',
                        description: 'Write it as a standup.',
                        kind: 'prompt',
                        builtIn: false,
                    },
                ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    mount(<Composer onSend={() => {}} />);
    expect(fetch).not.toHaveBeenCalled();
    type('/st');
    await act(async () => {
        await loadChatSkills();
    });
    expect(String(fetch.mock.calls[0][0])).toBe('/api/chat-skills');
    expect(options()).toEqual([['standup', 'true']]);
    expect(host!.textContent).toContain('Write it as a standup.');
    act(() => (host!.querySelector('[data-skill="standup"]') as HTMLElement).click());
    expect(box().value).toBe('/standup ');
});

it('shows a skill the person invoked as a chip on their message, and an unknown command as text', () => {
    const messages: Message[] = [
        { id: 'u1', role: 'user', content: '/grill-me Rewrite billing in Rust' },
        { id: 'a1', role: 'assistant', content: 'Who asked for it?' },
        { id: 'u2', role: 'user', content: '/compact' },
        { id: 'a2', role: 'assistant', content: 'Compacted: 4 earlier turns.' },
        { id: 'u3', role: 'user', content: '/zz not a skill' },
    ];
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mount(<ChatTranscript messages={messages} calls={[]} />);
    const bubble = (id: string) => host!.querySelector(`[data-message-id="${id}"] [data-chat-body]`)!;
    expect(bubble('u1').querySelector('[data-slot="skill-chip"]')!.textContent).toBe('/grill-me');
    expect(bubble('u1').textContent).toBe('/grill-meRewrite billing in Rust');
    expect(bubble('u2').textContent).toBe('/compact');
    expect(bubble('u2').querySelector('[data-slot="skill-chip"]')).not.toBeNull();
    expect(bubble('u3').querySelector('[data-slot="skill-chip"]')).toBeNull();
    expect(bubble('u3').textContent).toBe('/zz not a skill');
});

it('shows older page chat messages without the page line they were stored with (CB-158)', () => {
    const page = 'From [Plan](/spaces/s/pages/p):\n\n';
    const messages: Message[] = [
        { id: 'u1', role: 'user', content: `${page}When do you keep going?` },
        { id: 'a1', role: 'assistant', content: 'At 10:00.' },
        { id: 'u2', role: 'user', content: `/grill-me ${page}ship Friday` },
        { id: 'a2', role: 'assistant', content: 'Who decided Friday?' },
        {
            id: 'u3',
            role: 'user',
            content: [{ type: 'text', text: `${page}With a picture` }],
        },
        { id: 'a3', role: 'assistant', content: 'Nice.' },
        // Not the app's page line: shown as written.
        { id: 'u4', role: 'user', content: 'From [Plan](https://x.test):\n\nHi' },
    ];
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    mount(<ChatTranscript messages={messages} calls={[]} />);
    const bubble = (id: string) => host!.querySelector(`[data-message-id="${id}"] [data-chat-body]`)!;
    expect(bubble('u1').textContent).toBe('When do you keep going?');
    expect(bubble('u2').querySelector('[data-slot="skill-chip"]')!.textContent).toBe('/grill-me');
    expect(bubble('u2').textContent).toBe('/grill-meship Friday');
    expect(bubble('u3').textContent).toBe('With a picture');
    expect(bubble('u4').textContent).toBe('From Plan:\nHi');
});

it('shows the skill on in a chat above the composer, and ends it', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        return new Response(
            JSON.stringify(
                init?.method === 'POST'
                    ? { ended: 'grill-me' }
                    : {
                          active: {
                              name: 'grill-me',
                              description: 'Get interviewed',
                              startedAt: 1,
                          },
                      },
            ),
            { headers: { 'Content-Type': 'application/json' } },
        );
    });
    function Bar() {
        const skill = useActiveSkill('t 1', false);
        return <ActiveSkillBar active={skill.active} onEnd={() => void skill.end()} />;
    }
    mount(<Bar />);
    await act(async () => {});
    const bar = host!.querySelector('[data-slot="active-skill"]')!;
    expect(bar.textContent).toContain('/grill-me');
    expect(bar.textContent).toContain('On until you’re done');
    await act(async () => {
        (bar.querySelector('button') as HTMLButtonElement).click();
    });
    expect(calls).toEqual(['GET /api/chat-skills/threads/t%201', 'POST /api/chat-skills/threads/t%201/end']);
    expect(host!.querySelector('[data-slot="active-skill"]')).toBeNull();
});

it('shows a workspace skill’s history in Settings and rolls back to a revision', async () => {
    const calls: string[] = [];
    const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
        });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const call = `${init?.method ?? 'GET'} ${String(url)}`;
        calls.push(init?.body ? `${call} ${String(init.body)}` : call);
        if (String(url).endsWith('/revisions')) {
            return json({
                revisions: [2, 1].map((revision) => ({
                    revision,
                    description: 'Write it as a standup.',
                    instructions: 'Yesterday, today, blockers.',
                    mode: 'turn',
                    sha256: `${revision}`.repeat(64),
                    restoredFrom: null,
                    createdAt: 1,
                    createdBy: 'alice',
                    createdByName: 'Alice',
                })),
            });
        }
        if (init?.method === 'POST') {
            return json({ skill: {} });
        }
        return json({
            skills: [
                ...BUILT_IN_SKILLS.map((skill) =>
                    skill.name === 'grill-me'
                        ? {
                              ...skill,
                              lock: {
                                  source: 'builtin',
                                  url: 'https://github.com/mattpocock/skills',
                                  path: 'skills/productivity/grilling/SKILL.md',
                                  commit: '5beb35b040e3de97e54fa9e386d7e42d15c295c2',
                                  license: 'MIT, Copyright (c) 2026 Matt Pocock',
                                  sha256: 'a'.repeat(64),
                              },
                          }
                        : skill,
                ),
                {
                    name: 'standup',
                    description: 'Write it as a standup.',
                    kind: 'prompt',
                    mode: 'turn',
                    builtIn: false,
                    instructions: 'Yesterday, today, blockers.',
                    lock: { source: 'workspace', revision: 2, sha256: '2'.repeat(64) },
                },
            ],
        });
    });
    mount(<ChatSkillsSection />);
    await act(async () => {});
    expect(host!.querySelector('[data-skill="grill-me"] [data-slot="skill-lock"]')!.textContent).toContain(
        'mattpocock/skills/skills/productivity/grilling/SKILL.md @ 5beb35b',
    );
    const standup = host!.querySelector('[data-skill="standup"]')!;
    await act(async () => {
        [...standup.querySelectorAll('button')].find((button) => button.textContent === 'History')!.click();
    });
    const rows = [...standup.querySelectorAll('[data-revision]')];
    expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringMatching(/^Revision 2.*Alice.*Current$/),
        expect.stringMatching(/^Revision 1.*Alice.*Roll back$/),
    ]);
    await act(async () => {
        (rows[1].querySelector('button') as HTMLButtonElement).click();
    });
    expect(calls).toContain('POST /api/chat-skills/standup/rollback {"revision":1}');
});
