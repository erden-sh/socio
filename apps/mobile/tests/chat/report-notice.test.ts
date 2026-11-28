import { createElement as h } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPORT_NOTICE_MS, reportNotice } from '../../src/chat/reply-reports';
import type { ReactionsState } from '../../src/sync/reactions';

// The quiet line under a reply about its report (CB-382), rendered with fake
// timers: each notice runs out `REPORT_NOTICE_MS` after it shows, whatever
// outcome comes after it.

vi.mock('react-native', () => ({ AccessibilityInfo: { announceForAccessibility: () => {} } }));

const { useReportNotice } = await import('../../src/screens/report-notice');

type Outcome = ReactionsState['report'];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function harness() {
    const seen: { notice: ReturnType<typeof useReportNotice>['notice'] }[] = [];
    let say: ReturnType<typeof useReportNotice>['say'] = () => {};
    const refresh = vi.fn(() => Promise.resolve());
    function Probe({ outcome }: { outcome: Outcome }) {
        const result = useReportNotice(outcome, refresh);
        seen.push({ notice: result.notice });
        say = result.say;
        return null;
    }
    let root: ReactTestRenderer | undefined;
    return {
        refresh,
        render(outcome: Outcome) {
            act(() => {
                if (root === undefined) {
                    root = create(h(Probe, { outcome }));
                } else {
                    root.update(h(Probe, { outcome }));
                }
            });
        },
        say: (messageId: string, text: string) =>
            act(() => {
                say(messageId, text);
            }),
        shown: () => seen.at(-1)?.notice ?? null,
        unmount: () =>
            act(() => {
                root?.unmount();
            }),
    };
}

describe('a report’s quiet notice', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs out on time when a queued outcome follows a failed one', () => {
        vi.useFakeTimers();
        const view = harness();
        view.render(undefined);
        view.render({ messageId: 'a1', outcome: 'unavailable', seq: 1 });
        expect(view.shown()).toEqual({ messageId: 'a1', text: reportNotice('unavailable') });
        expect(view.refresh).toHaveBeenCalledTimes(1);
        act(() => {
            vi.advanceTimersByTime(REPORT_NOTICE_MS / 2);
        });
        // Report B, queued, has no words: A's notice keeps its own expiry.
        view.render({ messageId: 'b1', outcome: 'queued', seq: 2 });
        expect(view.shown()?.messageId).toBe('a1');
        act(() => {
            vi.advanceTimersByTime(REPORT_NOTICE_MS / 2);
        });
        expect(view.shown()).toBeNull();
        view.unmount();
    });

    it('gives a notice that replaces another its own full time', () => {
        vi.useFakeTimers();
        const view = harness();
        view.render({ messageId: 'a1', outcome: 'unavailable', seq: 1 });
        act(() => {
            vi.advanceTimersByTime(REPORT_NOTICE_MS - 1000);
        });
        view.render({ messageId: 'b1', outcome: 'consent-changed', seq: 2 });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(view.shown()).toEqual({ messageId: 'b1', text: reportNotice('consent-changed') });
        act(() => {
            vi.advanceTimersByTime(REPORT_NOTICE_MS);
        });
        expect(view.shown()).toBeNull();
        // The screen's own words run out the same way.
        view.say('c1', 'Couldn’t check.');
        expect(view.shown()?.messageId).toBe('c1');
        act(() => {
            vi.advanceTimersByTime(REPORT_NOTICE_MS);
        });
        expect(view.shown()).toBeNull();
        view.unmount();
    });
});
