import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NO_FILTERS } from '@socio/shared/issues/issue-board';
import type { IssueStatus, IssueSummary } from '@socio/shared/issues/issue-types';

import { boardView, NO_BOARD_PREFS, PEEK_ROWS, type BoardPrefs } from '../../src/shell/board';
import {
    ACTIVE_OFFSET,
    BACK_EDGE,
    backSwipeDistance,
    dragPosition,
    FAIL_OFFSET,
    landingScroll,
    pageShift,
    peekTop,
    settleColumn,
    swipeSettle,
    swipeStartsOnCards,
} from '../../src/shell/board-swipe';
import { systemSpring } from '../../src/ui/motion';

// CB-468 (the owner's TestFlight note, 2026-11-21): a sideways swipe on the
// Board's cards moves between its columns as a page view does, the chips
// follow, vertical scrolling and iOS's back swipe keep working, and Reduce
// Motion jumps. The model runs under Node; the screen is read as text, since
// there is no React Native renderer here.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');

const W = 393;
let n = 0;
const issue = (status: IssueStatus): IssueSummary => {
    n += 1;
    return {
        number: n,
        title: `Issue ${n}`,
        status,
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        assigneeId: null,
        updatedAt: 1,
        excerpt: '',
        votes: 0,
        voted: false,
    } as IssueSummary;
};
const view = (issues: readonly IssueSummary[], prefs: Partial<BoardPrefs> = {}) =>
    boardView({
        issues,
        users: {},
        overlays: [],
        prefs: { ...NO_BOARD_PREFS, ...prefs, filters: { ...NO_FILTERS } },
        query: '',
    });

describe('where the swipe may start', () => {
    it('starts on the cards, never on the heading above them', () => {
        expect(swipeStartsOnCards(200, 500, 0, 300, 'ios')).toBe(true);
        expect(swipeStartsOnCards(200, 250, 0, 300, 'ios')).toBe(false);
        // Scrolled 100 down, a touch at 250 is on content 350, a card.
        expect(swipeStartsOnCards(200, 250, 100, 300, 'android')).toBe(true);
    });

    it('leaves iOS’s left edge to the back swipe, and Android’s edges to the system', () => {
        expect(swipeStartsOnCards(BACK_EDGE - 1, 500, 0, 300, 'ios')).toBe(false);
        expect(swipeStartsOnCards(BACK_EDGE, 500, 0, 300, 'ios')).toBe(true);
        expect(swipeStartsOnCards(4, 500, 0, 300, 'android')).toBe(true);
    });

    it('limits the back swipe to the edge only while the board can swipe', () => {
        expect(backSwipeDistance(true)).toEqual({ start: 0, end: BACK_EDGE });
        expect(backSwipeDistance(false)).toBeUndefined();
    });

    it('takes a sideways drag sooner than it gives up on a vertical one', () => {
        expect(FAIL_OFFSET).toBeLessThan(ACTIVE_OFFSET);
    });
});

describe('the cards follow the finger', () => {
    it('moves them with the drag between the first and last column', () => {
        // From column 1 of 4, a drag 100 to the left brings column 2 in.
        expect(dragPosition(W, -100, W, 4)).toBe(W + 100);
        expect(dragPosition(W, 100, W, 4)).toBe(W - 100);
    });

    it('rubber-bands past either end', () => {
        expect(dragPosition(0, 100, W, 4)).toBeCloseTo(-30);
        expect(dragPosition(3 * W, -100, W, 4)).toBeCloseTo(3 * W + 30);
    });

    it('draws each column beside the chosen one by its index', () => {
        expect(pageShift(1, W, W)).toBe(0);
        expect(pageShift(2, W, W)).toBe(W);
        expect(pageShift(0, W + 100, W)).toBe(-W - 100);
    });
});

describe('a release snaps to one column', () => {
    it('turns the page past half way, and goes back short of it', () => {
        expect(settleColumn(W + W * 0.6, 0, W, 1, 4)).toBe(2);
        expect(settleColumn(W + W * 0.4, 0, W, 1, 4)).toBe(1);
        expect(settleColumn(W - W * 0.6, 0, W, 1, 4)).toBe(0);
    });

    it('turns it on a flick however short the drag', () => {
        // A finger moving left at 1000 pt/s, 60 pt in: the next column.
        expect(settleColumn(W + 60, -1000, W, 1, 4)).toBe(2);
        expect(settleColumn(W - 60, 1000, W, 1, 4)).toBe(0);
    });

    it('turns at most one page and never past either end', () => {
        expect(settleColumn(3 * W, -5000, W, 1, 4)).toBe(2);
        expect(settleColumn(-50, 3000, W, 0, 4)).toBe(0);
        expect(settleColumn(3 * W + 50, -3000, W, 3, 4)).toBe(3);
        expect(settleColumn(100, -3000, W, 0, 1)).toBe(0);
    });

    it('settles with the platform’s spring from the finger’s speed, and jumps under Reduce Motion', () => {
        expect(swipeSettle('ios', false, 800)).toEqual({ ...systemSpring('ios', 'spatial'), velocity: 800 });
        expect(swipeSettle('android', false, -200)).toEqual({ ...systemSpring('android', 'spatial'), velocity: -200 });
        expect(swipeSettle('ios', true, 800)).toBeNull();
    });
});

describe('the neighbor comes in where it lands', () => {
    it('draws the neighbor’s first card where the chosen one’s is, or under the bar once past the heading', () => {
        expect(peekTop(400, 0, 100)).toBe(400);
        expect(peekTop(400, 350, 100)).toBe(100);
    });

    it('scrolls the list on landing only when past the heading, so the first card stays where the peek drew it', () => {
        expect(landingScroll(400, 0, 100)).toBeNull();
        expect(landingScroll(400, 1200, 100)).toBe(300);
        // After the landing scroll, the first card's top is the peek's.
        expect(400 - landingScroll(400, 1200, 100)!).toBe(peekTop(400, 1200, 100));
    });

    it('gives each column its neighbors’ first rows, none past either end or in the list', () => {
        const issues = [issue('triage'), ...Array.from({ length: PEEK_ROWS + 3 }, () => issue('open')), issue('ready')];
        const first = view(issues);
        expect(first.column).toBe('triage');
        expect(first.neighbors.before).toBeNull();
        expect(first.neighbors.after?.status).toBe('open');
        expect(first.neighbors.after?.rows).toHaveLength(PEEK_ROWS);

        const middle = view(issues, { column: 'open' });
        expect(middle.neighbors.before?.status).toBe('triage');
        expect(middle.neighbors.before?.rows).toHaveLength(1);
        expect(middle.neighbors.after?.status).toBe(middle.columns[2]!.status);

        const last = view(issues, { column: middle.columns.at(-1)!.status });
        expect(last.neighbors.after).toBeNull();
        expect(last.neighbors.before?.empty).toBe(last.columns.at(-2)!.count === 0);

        const list = view(issues, { view: 'list' });
        expect(list.neighbors).toEqual({ before: null, after: null });
    });
});

describe('the Board is wired to the swipe', () => {
    const board = read('screens/board.tsx');
    const gesture = read('screens/board-swipe-gesture.ts');

    it('pans around the one vertical list, which stays the page’s first scroll view (the large title)', () => {
        expect(board).toMatch(/<GestureDetector gesture=\{pan\}>\s*<LegendList/);
        expect(board).toContain('activeOffsetX: [-ACTIVE_OFFSET, ACTIVE_OFFSET]');
        expect(board).toContain('failOffsetY: [-FAIL_OFFSET, FAIL_OFFSET]');
        expect(board).toContain('enabled: swiping');
        expect(board).toContain("const swiping = view.layout === 'board' && view.columns.length > 1;");
    });

    it('fails the pan off the cards, and keeps iOS’s back swipe to the edge on the board', () => {
        expect(gesture).toContain('GestureStateManager.fail(event.handlerTag)');
        expect(gesture).toContain('swipeStartsOnCards(');
        expect(board).toContain('gestureResponseDistance: backSwipeDistance(swiping)');
    });

    it('moves every card and the empty line, and draws both neighbors as pictures', () => {
        expect(board.match(/<SwipePage swipe=\{swipe\} index=\{columnIndex\}>/g)).toHaveLength(2);
        expect(board).toContain('peek={view.neighbors.before}');
        expect(board).toContain('peek={view.neighbors.after}');
        expect(board).toContain('pointerEvents="none"');
        expect(board).toContain('importantForAccessibility="no-hide-descendants"');
    });

    it('chooses the column a release lands on, and settles under Reduce Motion at once', () => {
        expect(board).toContain('setPrefs({ ...prefs, column: status });');
        expect(board).toContain('reduceMotion, onLand: land');
        expect(gesture).toContain('reduceMotion: ReduceMotion.System');
    });

    it('scrolls the chosen chip into view, and the chips still choose', () => {
        expect(board).toContain('scroller.current?.scrollTo({');
        expect(board).toContain('animated: !reduceMotion');
        expect(board).toContain('onPress={() => onColumn(column.status)}');
    });
});
