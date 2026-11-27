import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Batch D of the 2026-11-18 parity audit, read as source: the screens draw on
// React Native, which the Node tests can't load.
// - One empty and not-found state (src/ui/empty-state.tsx), the web's
//   EmptyPage: a Local, a bold headline, a line and a way back.
// - The issue's vote is the web's small chip, not a "Vote · 1" button.
// - A page's header names the page, not its Space.

const read = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');
const web = (file: string) => readFileSync(join(import.meta.dirname, '../../../../packages/client/src', file), 'utf8');

/** A function's source, from its declaration to the next top-level declaration. */
function body(source: string, start: string): string {
    const from = source.indexOf(start);
    expect(from, start).toBeGreaterThanOrEqual(0);
    const next = source.slice(from + start.length).search(/\n(?:export )?(?:function|const) /);
    return next < 0 ? source.slice(from) : source.slice(from, from + start.length + next);
}

describe('the shared empty state', () => {
    const state = read('ui/empty-state.tsx');

    it('draws a Local (the web’s default mascot), a bold headline, a line and an action', () => {
        expect(state).toContain('<LocalAvatar character={local ?? characterFor()} size={LOCAL_ART_MAX}');
        // ContentUnavailableView's title: a Title 2, bold.
        expect(state).toMatch(/<Text accessibilityRole="header" variant="title2" weight="bold"/);
        expect(state).toContain('<Button');
        // A tile only where the web draws an icon ("No pages yet").
        expect(state).toContain('<ToneTile tone={tile.tone} icon={tile.icon}');
    });

    it('says the web’s line and way back', () => {
        expect(web('views/NotFound.tsx')).toContain("t('shell:error.not-found.back')");
        // The web's words are its en-US dictionary's (shell).
        const words = (
            JSON.parse(
                readFileSync(new URL('../../../../packages/i18n/locales/en-US/shell.json', import.meta.url), 'utf8'),
            ) as { error: { 'not-found': Record<string, string> } }
        ).error['not-found'];
        expect(words.back).toBe('Back to your socios');
        expect(words.why).toBe("It may have been removed, or it isn't shared with you.");
        expect(state).toContain("BACK_TO_SOCIOS = 'Back to your socios'");
        expect(state).toContain("NOT_SHARED_LINE = 'It may have been removed, or it isn’t shared with you.'");
    });

    it('goes back where the stack can, else to the gate’s root, as the error screen does', () => {
        const hook = body(state, 'export function useWayBack');
        expect(hook).toContain('wayOut(route, navigation.canGoBack(), useRootGate())');
        expect(hook).toContain('navigation.goBack()');
        expect(hook).toContain('StackActions.replace(exit)');
    });

    it('is what a missing page, issue and Space draw, with no tile of their own', () => {
        const screens = {
            'screens/page.tsx': ['page-missing'],
            'screens/issue.tsx': ['issue-missing'],
            'screens/space.tsx': ['space-unavailable', 'space-empty'],
            'screens/chat.tsx': ['chat-missing'],
        };
        for (const [file, ids] of Object.entries(screens)) {
            const source = read(file);
            expect(source, file).toContain("from '../ui/empty-state'");
            for (const id of ids) {
                expect(source, id).toMatch(new RegExp(`<EmptyState[^>]*testID="${id}"`, 's'));
                expect(source, id).not.toMatch(new RegExp(`<View [^>]*testID="${id}"`));
            }
        }
        for (const file of ['screens/page.tsx', 'screens/issue.tsx']) {
            expect(body(read(file), 'function Missing'), file).toContain("useWayBack('");
        }
        expect(body(read('screens/space.tsx'), 'function Unavailable')).toContain("useWayBack('Space')");
    });

    it('is what a missing chat draws, headed as the web’s NotFound for a conversation (batch F)', () => {
        const chat = read('screens/chat.tsx');
        const missing = body(chat, 'function MissingChat');
        expect(missing).toContain("useWayBack('Chat')");
        expect(missing).toContain(
            '<EmptyState headline={headline} line={caption} action={back} testID="chat-missing" />',
        );
        expect(missing).not.toContain('<ToneTile');
        expect(web('views/ChatViews.tsx')).toContain('<NotFound what="Conversation" />');
        expect(read('chat/chat-view.ts')).toContain("CONVERSATION_NOT_FOUND = 'Conversation not found'");
        expect(chat).toContain('headline={ROOM_GONE_TITLE} caption={ROOM_GONE_CAPTION}');
    });

    it('offers New page on an empty Space, as the web’s library does', () => {
        const space = read('screens/space.tsx');
        // The web's words are its en-US dictionary's (spaces).
        const library = (
            JSON.parse(
                readFileSync(new URL('../../../../packages/i18n/locales/en-US/spaces.json', import.meta.url), 'utf8'),
            ) as { library: { 'empty-hint': { none: string } } }
        ).library;
        expect(library['empty-hint'].none).toBe('Create your first page to start organizing this Space.');
        expect(space).toContain("NO_PAGES_LINE = 'Create your first page to start organizing this Space.'");
        expect(space).toMatch(/action=\{\{\s*label: NEW_PAGE,\s*onPress: manage\.newPage,\s*variant: 'primary'/);
    });
});

describe('an issue’s vote', () => {
    const issue = read('screens/issue.tsx');

    it('is a chip with the thumb and the count, filled when voted, not a labelled button', () => {
        const chip = body(issue, 'function VoteChip');
        expect(chip).toContain('testID="issue-vote"');
        expect(chip).toContain('filled={vote.voted}');
        expect(chip).toContain('{String(vote.votes)}');
        expect(issue).not.toContain('`${vote.label} · ${vote.votes}`');
        // Small to look at, still a 44 pt target.
        expect(chip).toContain("'min-h-7 ");
        expect(issue).toContain('const VOTE_HIT_SLOP = { top: 8, bottom: 8');
        // The count and the person's vote stay in its label.
        expect(chip).toContain('accessibilityLabel={vote.accessibilityLabel}');
    });

    it('sits in the meta line beside the pills, not pushed to the edge', () => {
        expect(body(issue, 'function Head')).toContain('<VoteChip');
        expect(body(issue, 'function VoteChip')).not.toContain('ml-auto');
    });
});

describe('a page’s bar (CB-420)', () => {
    it('names the page once its own title scrolls under the bar (Notes’, Files’), the Space only until it is known', () => {
        const reader = body(read('screens/page.tsx'), 'function Reader');
        expect(reader).toContain("title: titleGone ? (view?.title ?? spaceName) : view === null ? spaceName : '',");
        expect(reader).toContain('setTitleGone(titleEnd !== null && y + barInset > titleEnd)');
        expect(reader).toMatch(/id: 'page-edit',\s+label: 'Edit',/);
        expect(reader).not.toContain('HeaderBar');
    });
});
