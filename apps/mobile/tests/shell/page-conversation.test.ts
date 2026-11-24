import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Dot } from '@socio/shared/types';

import { hidesTabBar } from '../../src/navigation/routes';
import {
    NO_PAGE_SOCIO,
    NO_PAGE_SOCIO_ADMIN,
    PAGE_CHAT_FAILED,
    PAGE_CHAT_NEEDS_CONNECTION,
    PAGE_CHAT_SETUP,
    pageChatActions,
    pageChatCopy,
    pageChatEntry,
    pageChatSocios,
    pageContextLabel,
    pageContextTap,
    socioOfAction,
} from '../../src/shell/page-conversation';
import { sfSymbolOf } from '../../src/ui/symbols';

// The page conversation's view (CB-499; the web's PageConversation): the socios
// it offers, what to set up first, the words for an open that didn't go, and the
// screens' wiring.

const dot = (id: string, over: Partial<Dot> = {}) =>
    ({ id, name: id.toUpperCase(), spaceId: 's-1', spaceIds: ['s-1'], createdAt: 1, instructions: '', ...over }) as Dot;

const READY = { setup: { missing: [] } } as never;
const src = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
const repo = (file: string) => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');

describe('the page’s socios (CB-499)', () => {
    it('offers the web’s choices: not archived, in the page’s Space, oldest first', () => {
        const dots = [
            dot('d-late', { createdAt: 5 }),
            dot('d-gone', { archivedAt: 3 }),
            dot('d-other', { spaceIds: ['s-2'] }),
            dot('d-early', { createdAt: 2 }),
        ];
        expect(pageChatSocios(dots, 's-1')).toEqual([
            { id: 'd-early', name: 'D-EARLY' },
            { id: 'd-late', name: 'D-LATE' },
        ]);
        expect(repo('packages/client/src/modules/pages/PageConversation.tsx')).toContain(
            'workspace.dots.filter((dot) => !dot.archivedAt && dot.spaceIds.includes(page.spaceId))',
        );
    });

    it('says what to set up first, as the web’s ChatSetup', () => {
        const none = { dots: [dot('d-x', { spaceIds: ['s-2'] })], spaceId: 's-1', workspace: READY };
        expect(pageChatEntry({ ...none, role: 'admin' })).toEqual({
            kind: 'setup',
            line: NO_PAGE_SOCIO_ADMIN,
            web: true,
        });
        expect(pageChatEntry({ ...none, role: 'member' })).toEqual({ kind: 'setup', line: NO_PAGE_SOCIO, web: false });
        const unset = { setup: { missing: ['inference'] } } as never;
        expect(pageChatEntry({ dots: [dot('d-a')], spaceId: 's-1', workspace: unset, role: 'member' })).toEqual({
            kind: 'setup',
            line: PAGE_CHAT_SETUP,
            web: true,
        });
        expect(pageChatEntry({ dots: [dot('d-a')], spaceId: 's-1', workspace: READY, role: 'member' })).toEqual({
            kind: 'socios',
            socios: [{ id: 'd-a', name: 'D-A' }],
        });
    });

    it('names each socio in the menu, and reads the choice back', () => {
        const actions = pageChatActions([
            { id: 'd-a', name: 'Sebas' },
            { id: 'd-b', name: 'Manny' },
        ]);
        expect(actions.map((action) => action.label)).toEqual(['Sebas', 'Manny']);
        expect(actions.map((action) => socioOfAction(action.name))).toEqual(['d-a', 'd-b']);
        expect(socioOfAction('copy')).toBeNull();
        expect(socioOfAction('socio:')).toBeNull();
    });

    it('words an open that didn’t go, never with the server’s text', () => {
        expect(pageChatCopy({ kind: 'done', chat: { id: 'c', dotId: 'd' } })).toBeNull();
        expect(pageChatCopy({ kind: 'blocked', reason: 'offline' })).toBe(PAGE_CHAT_NEEDS_CONNECTION);
        expect(pageChatCopy({ kind: 'blocked', reason: 'update' })).toBe('Update Socio to do this');
        expect(pageChatCopy({ kind: 'refused', reason: 'http-400' })).toBe(
            'Choose a socio in this Space with access enabled.',
        );
        expect(pageChatCopy({ kind: 'refused', reason: 'http-418' })).toBe(PAGE_CHAT_FAILED);
    });
});

describe('the chat’s page banner (CB-499)', () => {
    const page = { id: 'p-1', spaceId: 's-1', title: 'Roadmap' };

    it('goes back to the page it was opened from, else opens it', () => {
        const fromPage = [
            { name: 'SpacesRoot' },
            { name: 'Page', params: { spaceId: 's-1', pageId: 'p-1' } },
            { name: 'Chat', params: { id: 'c' } },
        ];
        expect(pageContextTap(fromPage, 2, page)).toBe('back');
        const other = [{ name: 'Page', params: { spaceId: 's-1', pageId: 'p-2' } }, { name: 'Chat' }];
        expect(pageContextTap(other, 1, page)).toBe('push');
        expect(pageContextTap([{ name: 'Chat' }], 0, page)).toBe('push');
        expect(pageContextLabel(page)).toBe('Working on Roadmap');
    });
});

describe('the screens’ wiring (CB-499)', () => {
    it('puts Ask about this page in the page’s bar, with an SF Symbol and its Material icon', () => {
        const pageScreen = src('screens/page.tsx');
        expect(pageScreen).toContain("id: 'page-chat',");
        expect(pageScreen).toContain("symbol: 'bubble.left',");
        expect(pageScreen).toContain("icon: 'message-circle',");
        expect(pageScreen).toContain('...(ask.menu === null ? {} : { menu: ask.menu }),');
        expect(sfSymbolOf('message-circle')).toBe('bubble.left');
        // The open is the web's, tied to the page and socio that asked.
        expect(pageScreen).toContain('requests.run(scope, () => pageChats.open(spaceId, pageId, dotId), {');
        expect(pageScreen).toContain("requests.select('');");
        // A save still waiting holds it, as the web saves first.
        expect(pageScreen).toContain('useAskAboutPage(spaceId, pageId, waiting !== null || conflicts.length > 0)');
    });

    it('opens the app’s chat screen, which hides the tab bar (CB-491), with the page as its banner', () => {
        expect(src('screens/page.tsx')).toContain("({ type: 'PUSH', payload: { name: 'Chat', params: { id } } })");
        expect(hidesTabBar('Chat')).toBe(true);
        const chat = src('screens/chat.tsx');
        expect(chat).toContain("const page = usePageChatContext(view.kind === 'private' ? id : null);");
        expect(chat).toContain('usePageRefreshAfterTurn(page, running);');
        expect(chat).toContain('<PageContextBanner page={page} onLayout={setBannerHeight} />');
        expect(chat).toContain('const barInset = bar + (page === null ? 0 : bannerHeight);');
        // After a turn the page's Space is pulled: its tree, and the body under the chat.
        expect(src('screens/page-chat-context.tsx')).toContain('.space(spaceId)\n                .pull()');
    });
});
