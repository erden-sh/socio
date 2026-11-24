import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));
import { api } from '../src/lib/api';
import { decidePageReview } from '../src/modules/pages/page-review-decision';
import { PageReviewCard } from '../src/modules/pages/PageReviewCard';

beforeEach(() => {
    vi.mocked(api).mockReset();
});

// The decision's cases are in tests/shared-page-review.test.ts (shared);
// this checks the web's binding to its api.
it('declines malformed drafts without validating or saving them', async () => {
    vi.mocked(api).mockResolvedValue(null);
    expect(await decidePageReview('thread', 'call', { title: '' }, false)).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/conversations/thread/reviewed-page/call');
});

it('hides decisions and unsaved claims until the persisted receipt is checked', () => {
    const html = renderToStaticMarkup(
        <PageReviewCard
            args={{ title: 'Brief', content: 'Evidence', spaceId: 'space' }}
            status="executing"
            respond={async () => {}}
            threadId="thread"
            toolCallId="call"
            onSaved={() => {}}
        />,
    );
    expect(html).toContain('Checking whether this draft was already saved.');
    expect(html).not.toContain('Decline');
    expect(html).not.toContain('Approve &amp; save');
    expect(html).not.toContain('Nothing is saved');
});

it('does not claim a canceled or declined review was unsaved before recovering its receipt', () => {
    for (const result of [undefined, JSON.stringify({ approved: false }), JSON.stringify({ status: 'stopped' })]) {
        const html = renderToStaticMarkup(
            <PageReviewCard
                args={{}}
                status="complete"
                result={result}
                threadId="thread"
                toolCallId="call"
                onSaved={() => {}}
            />,
        );
        expect(html).toContain('Checking whether this draft was already saved.');
        expect(html).not.toContain('No page was saved.');
        expect(html).not.toContain('Decline');
    }
});

it('renders a Markdown table in the draft as a table, not raw pipe text', () => {
    const content = '| Category | Score |\n| --- | --- |\n| Speed | 9 |';
    const html = renderToStaticMarkup(
        <PageReviewCard
            args={{ title: 'Brief', content, spaceId: 'space' }}
            status="executing"
            respond={async () => {}}
            threadId="thread"
            toolCallId="call"
            onSaved={() => {}}
        />,
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Category</th>');
    expect(html).toContain('<td>Speed</td>');
    expect(html).not.toContain('| Category |');
});
