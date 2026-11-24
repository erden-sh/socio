import { describe, expect, it } from 'vitest';

import type { ApprovalView } from '@socio/shared/approvals';

import { asksTo, NEEDS_YOUR_APPROVAL } from '../../src/chat/approval-card';
import {
    approvalPath,
    approvalsList,
    INBOX_APPROVALS_SHOWN,
    inboxApprovals,
    RECENT_SHOWN,
    SEE_ALL,
} from '../../src/shell/approvals';
import { approval } from '../sync/helpers';

// The approvals list and the Inbox's approval rows, under Node.

const view = (id: string, status = 'pending', fields: Record<string, unknown> = {}) =>
    approval(id, status, fields) as unknown as ApprovalView;

describe('the approvals list', () => {
    it('shows the requests waiting first, newest first, then the recent decisions by when they were decided', () => {
        const list = approvalsList([
            view('old-wait', 'pending', { createdAt: 10 }),
            view('done-early', 'approved', { createdAt: 5, decidedAt: 20 }),
            view('new-wait', 'pending', { createdAt: 30 }),
            view('done-late', 'denied', { createdAt: 1, decidedAt: 40 }),
            view('expired', 'expired', { createdAt: 25, decidedAt: null, decidedVia: 'expiry' }),
        ]);
        expect(list.waiting.map((item) => item.id)).toEqual(['new-wait', 'old-wait']);
        // A decision with no time sorts by when it was asked.
        expect(list.recent.map((item) => item.id)).toEqual(['done-late', 'expired', 'done-early']);
        expect(list.waitingLabel).toBe('2 waiting');
    });

    it('keeps the server’s 50 most recent decisions, and says nothing waits', () => {
        const decided = Array.from({ length: RECENT_SHOWN + 5 }, (_, index) =>
            view(`d${index}`, 'approved', { decidedAt: index }),
        );
        const list = approvalsList(decided);
        expect(list.waiting).toEqual([]);
        expect(list.waitingLabel).toBeNull();
        expect(list.recent).toHaveLength(RECENT_SHOWN);
        expect(list.recent[0]?.id).toBe(`d${RECENT_SHOWN + 4}`);
    });

    it('links to the web’s paths', () => {
        expect(approvalPath('a1')).toBe('/approvals/a1');
        expect(approvalPath('a/b c')).toBe('/approvals/a%2Fb%20c');
    });
});

describe('the Inbox’s approvals', () => {
    it('lists the newest few waiting, then See all with the count; decisions never show', () => {
        const views = [
            ...Array.from({ length: 5 }, (_, index) => view(`w${index}`, 'pending', { createdAt: index })),
            view('done', 'approved', { createdAt: 99, decidedAt: 100 }),
        ];
        const inbox = inboxApprovals(views);
        expect(inbox.waiting).toBe(5);
        expect(inbox.rows.map((row) => row.id)).toEqual(['w4', 'w3', 'w2']);
        expect(inbox.rows).toHaveLength(INBOX_APPROVALS_SHOWN);
        const first = views[4] as ApprovalView;
        expect(inbox.rows[0]).toEqual({
            id: 'w4',
            title: asksTo(first),
            summary: 'Create dataset “w4”',
            accessibilityLabel: `${asksTo(first)}. ${NEEDS_YOUR_APPROVAL}. Create dataset “w4”`,
        });
        expect(inbox.seeAllLabel).toBe(`${SEE_ALL}, 5 waiting`);
    });

    it('shows a request with no summary by what it asks alone', () => {
        const inbox = inboxApprovals([view('w', 'pending', { summary: '  ' })]);
        expect(inbox.rows[0]?.summary).toBeNull();
        expect(inbox.rows[0]?.accessibilityLabel).toBe(`${inbox.rows[0]?.title}. ${NEEDS_YOUR_APPROVAL}`);
    });
});
