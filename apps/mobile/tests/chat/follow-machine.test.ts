import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFollowSession,
    DISCLOSURE_RESIZED_MS,
    DISCLOSURE_SETTLE_MS,
    isAtEnd,
    returnsToEndAfterTurn,
    SCROLL_SESSION_GRACE_MS,
} from '../../src/chat/follow-session';
import {
    resolveThreadFeedLiveFollow,
    resolveThreadFeedSubmissionAnchor,
} from '../../vendor/t3code/thread-feed-live-follow';

// The chat's follow machine: T3 Code's thread-feed-live-follow.test.ts
// cases for the two functions vendored (vendor/t3code/SYNC.md), then the scroll
// session that drives it on the chat screen (src/chat/follow-session.ts).

describe('resolveThreadFeedSubmissionAnchor (T3 Code)', () => {
    it('keeps an offline first message at the end', () => {
        expect(
            resolveThreadFeedSubmissionAnchor({
                currentAnchorMessageId: null,
                submittedMessageId: 'offline-first',
                hasStartedTurn: false,
                hasUserMessage: false,
                queuedMessageCount: 0,
                deliveryDeferred: true,
            }),
        ).toBeNull();
    });

    it('anchors the first user message in a thread', () => {
        expect(
            resolveThreadFeedSubmissionAnchor({
                currentAnchorMessageId: null,
                submittedMessageId: 'first-message',
                hasStartedTurn: false,
                hasUserMessage: false,
                deliveryDeferred: false,
                queuedMessageCount: 0,
            }),
        ).toBe('first-message');
    });

    it('preserves the first-message anchor when another message is queued', () => {
        expect(
            resolveThreadFeedSubmissionAnchor({
                currentAnchorMessageId: 'first-message',
                submittedMessageId: 'second-message',
                hasStartedTurn: false,
                hasUserMessage: false,
                deliveryDeferred: false,
                queuedMessageCount: 1,
            }),
        ).toBe('first-message');
    });

    it('does not anchor a follow-up after a user message appears', () => {
        expect(
            resolveThreadFeedSubmissionAnchor({
                currentAnchorMessageId: 'first-message',
                submittedMessageId: 'second-message',
                hasStartedTurn: false,
                hasUserMessage: true,
                deliveryDeferred: false,
                queuedMessageCount: 0,
            }),
        ).toBeNull();
    });

    it('does not anchor a thread that has already started a turn', () => {
        expect(
            resolveThreadFeedSubmissionAnchor({
                currentAnchorMessageId: null,
                submittedMessageId: 'second-message',
                hasStartedTurn: true,
                hasUserMessage: false,
                deliveryDeferred: false,
                queuedMessageCount: 0,
            }),
        ).toBeNull();
    });
});

describe('resolveThreadFeedLiveFollow (T3 Code)', () => {
    it('pauses immediately when the user starts scrolling', () => {
        expect(resolveThreadFeedLiveFollow(true, { type: 'user-scroll-begin' })).toBe(false);
    });

    it('does not mistake programmatic layout compensation for a user scroll', () => {
        expect(
            resolveThreadFeedLiveFollow(true, { type: 'scroll', isAtEnd: false, userScrollSessionActive: false }),
        ).toBe(true);
    });

    it('does not re-arm at the end while a user scroll session is active', () => {
        expect(
            resolveThreadFeedLiveFollow(false, { type: 'scroll', isAtEnd: true, userScrollSessionActive: true }),
        ).toBe(false);
    });

    it.each([
        { isAtEnd: false, userScrollSessionActive: false, expected: false },
        { isAtEnd: true, userScrollSessionActive: false, expected: true },
        { isAtEnd: false, userScrollSessionActive: true, expected: false },
        { isAtEnd: true, userScrollSessionActive: true, expected: false },
    ])('reconciles follow after a disclosure settles: %j', ({ expected, ...state }) => {
        expect(resolveThreadFeedLiveFollow(!expected, { type: 'disclosure-settled', ...state })).toBe(expected);
    });

    it('re-arms at the actual end only after the user scroll session ends', () => {
        expect(
            resolveThreadFeedLiveFollow(false, {
                type: 'user-scroll-end',
                isAtEnd: true,
                userScrollSessionActive: true,
            }),
        ).toBe(true);
        expect(
            resolveThreadFeedLiveFollow(false, {
                type: 'user-scroll-end',
                isAtEnd: false,
                userScrollSessionActive: true,
            }),
        ).toBe(false);
    });
});

describe('isAtEnd', () => {
    const metrics = (y: number) => ({
        contentOffset: { y },
        contentSize: { height: 2000 },
        layoutMeasurement: { height: 800 },
    });

    it('is exactly the end, give or take a rounding error, not a wider threshold', () => {
        expect(isAtEnd(metrics(1200))).toBe(true);
        expect(isAtEnd(metrics(1199.5))).toBe(true);
        expect(isAtEnd(metrics(1190))).toBe(false);
        expect(isAtEnd(metrics(0))).toBe(false);
    });

    it('holds a transcript shorter than the screen at its end', () => {
        expect(
            isAtEnd({ contentOffset: { y: 0 }, contentSize: { height: 300 }, layoutMeasurement: { height: 800 } }),
        ).toBe(true);
    });
});

describe('the scroll session', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('follows from the start, and the list scrolling itself (rows growing) never stops it', () => {
        const session = createFollowSession();
        expect(session.following).toBe(true);
        session.scroll(false);
        expect(session.following).toBe(true);
    });

    it('stops following as the person drags, and stays off when they leave it away from the end', () => {
        const session = createFollowSession();
        const changes = vi.fn();
        session.subscribe(changes);
        session.dragBegin();
        expect(session.following).toBe(false);
        session.scroll(false);
        session.dragEnd(false);
        vi.advanceTimersByTime(SCROLL_SESSION_GRACE_MS);
        expect(session.following).toBe(false);
        // Once the session closed, the list's own scrolls away from the end don't change it.
        session.scroll(false);
        expect(session.following).toBe(false);
        expect(changes).toHaveBeenCalledTimes(1);
    });

    it('follows again when the person lets go exactly at the end, once the session closes', () => {
        const session = createFollowSession();
        session.dragBegin();
        session.scroll(true);
        // Still inside the session: reaching the end doesn't re-arm yet.
        expect(session.following).toBe(false);
        session.dragEnd(true);
        vi.advanceTimersByTime(SCROLL_SESSION_GRACE_MS - 1);
        expect(session.following).toBe(false);
        vi.advanceTimersByTime(1);
        expect(session.following).toBe(true);
    });

    it('keeps the session open through momentum, and closes it where momentum ends', () => {
        const session = createFollowSession();
        session.dragBegin();
        session.dragEnd(false);
        vi.advanceTimersByTime(SCROLL_SESSION_GRACE_MS / 2);
        session.momentumBegin();
        vi.advanceTimersByTime(SCROLL_SESSION_GRACE_MS * 4);
        expect(session.following).toBe(false);
        session.scroll(true);
        expect(session.following).toBe(false);
        session.momentumEnd(true);
        expect(session.following).toBe(true);
    });

    it('re-arms on its own when the list reaches the end with no session open (a status-bar tap, then back)', () => {
        const session = createFollowSession();
        session.dragBegin();
        session.dragEnd(false);
        vi.advanceTimersByTime(SCROLL_SESSION_GRACE_MS);
        expect(session.following).toBe(false);
        session.scroll(true);
        expect(session.following).toBe(true);
    });

    it('follows again on reset (a send, Jump to latest), even mid-session', () => {
        const session = createFollowSession();
        session.dragBegin();
        session.dragEnd(false);
        session.reset();
        expect(session.following).toBe(true);
        vi.advanceTimersByTime(SCROLL_SESSION_GRACE_MS);
        expect(session.following).toBe(true);
    });

    it('stops following when the person opens a row, so the row stays put instead of the end (CB-437)', () => {
        const session = createFollowSession();
        const atEnd = vi.fn(() => false);
        // Idle at the end of a long chat: the steps open below the row, the end isn't kept in view.
        session.disclosure(false, atEnd);
        expect(session.following).toBe(false);
        // Once the row settles, the end is below: it stays off (Jump to latest shows).
        vi.advanceTimersByTime(DISCLOSURE_SETTLE_MS);
        expect(atEnd).toHaveBeenCalledTimes(1);
        expect(session.following).toBe(false);
        // The list's own scrolls away from the end don't bring it back; reaching the end does.
        session.scroll(false);
        expect(session.following).toBe(false);
        session.scroll(true);
        expect(session.following).toBe(true);
    });

    it('follows again once the row settles with the list still at its end (a short chat, a row closed)', () => {
        const session = createFollowSession();
        session.disclosure(false, () => true);
        expect(session.following).toBe(false);
        expect(session.holding).toBe(true);
        vi.advanceTimersByTime(DISCLOSURE_SETTLE_MS);
        expect(session.following).toBe(true);
        expect(session.holding).toBe(false);
    });

    it('reads the end once rows stop resizing, not before', () => {
        const session = createFollowSession();
        const atEnd = vi.fn(() => true);
        session.disclosure(false, atEnd);
        session.resized();
        vi.advanceTimersByTime(DISCLOSURE_RESIZED_MS - 1);
        session.resized();
        vi.advanceTimersByTime(DISCLOSURE_RESIZED_MS - 1);
        expect(atEnd).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(atEnd).toHaveBeenCalledTimes(1);
        expect(session.following).toBe(true);
        // Rows resizing with no row opened (a reply streaming in) read nothing.
        session.resized();
        vi.advanceTimersByTime(DISCLOSURE_SETTLE_MS);
        expect(atEnd).toHaveBeenCalledTimes(1);
    });

    it('leaves following to the person when they drag before the row settles', () => {
        const session = createFollowSession();
        const atEnd = vi.fn(() => true);
        session.disclosure(false, atEnd);
        session.dragBegin();
        vi.advanceTimersByTime(DISCLOSURE_SETTLE_MS);
        expect(atEnd).not.toHaveBeenCalled();
        expect(session.following).toBe(false);
    });

    it('keeps following through a row opened while a reply streams at the end (CB-437)', () => {
        const session = createFollowSession();
        const atEnd = vi.fn(() => false);
        session.disclosure(true, atEnd);
        expect(session.following).toBe(true);
        expect(session.holding).toBe(false);
        vi.advanceTimersByTime(DISCLOSURE_SETTLE_MS);
        expect(session.following).toBe(true);
        expect(atEnd).not.toHaveBeenCalled();
        // Away from the end it stays off either way.
        session.dragBegin();
        session.dragEnd(false);
        vi.advanceTimersByTime(SCROLL_SESSION_GRACE_MS);
        session.disclosure(true, atEnd);
        expect(session.following).toBe(false);
    });

    it('leaves no timer behind once disposed', () => {
        const session = createFollowSession();
        session.dragBegin();
        session.dragEnd(true);
        session.disclosure(false, () => true);
        session.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('the end of a turn', () => {
    it('goes back to the end only when a turn just ended while the list follows', () => {
        expect(returnsToEndAfterTurn(true, false, true)).toBe(true);
        expect(returnsToEndAfterTurn(true, false, false)).toBe(false);
        expect(returnsToEndAfterTurn(false, false, true)).toBe(false);
        expect(returnsToEndAfterTurn(false, true, true)).toBe(false);
        expect(returnsToEndAfterTurn(true, true, true)).toBe(false);
    });
});
