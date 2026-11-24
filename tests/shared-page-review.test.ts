import { beforeEach, expect, it, vi } from 'vitest';

import type { ReviewedPage } from '@socio/shared/pages/page-library';
import {
    decidePageReview,
    matchesReviewedDraft,
    pageReviewApproved,
    pageReviewDeclined,
    pageReviewTool,
    type PageReviewRequest,
} from '@socio/shared/pages/page-review';

// The page-review decision the web and the app share, over a
// request function the client gives it.
const request = vi.fn();
const decide = (args: unknown, approved: boolean) =>
    decidePageReview(request as unknown as PageReviewRequest, 'thread', 'call', args, approved);
const page = (fields: object) => fields as ReviewedPage;

beforeEach(() => {
    request.mockReset();
});

it('declines malformed drafts without validating or saving them', async () => {
    request.mockResolvedValue(null);
    expect(await decide({ title: '' }, false)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/conversations/thread/reviewed-page/call');
});

it('recovers an already committed save instead of emitting a decline', async () => {
    const saved = { id: 'saved', spaceId: 'space' };
    request.mockResolvedValue(saved);
    expect(await decide({}, false)).toBe(saved);
    expect(request).toHaveBeenCalledTimes(1);
});

it('does not decide or save when receipt recovery fails', async () => {
    request.mockRejectedValue(new Error('Access revoked'));
    await expect(decide({}, false)).rejects.toThrow('Access revoked');
    expect(request).toHaveBeenCalledTimes(1);
});

it('checks for a receipt before retrying a save whose response was lost', async () => {
    const draft = { title: 'Brief', content: 'Evidence', spaceId: 'space' };
    const saved = { id: 'saved', ...draft, reviewDraft: draft };
    request.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Connection lost'));
    await expect(decide(draft, true)).rejects.toThrow('Connection lost');
    expect(request).toHaveBeenLastCalledWith('/conversations/thread/reviewed-page', 'POST', {
        ...draft,
        toolCallId: 'call',
    });
    request.mockResolvedValueOnce(saved);
    expect(await decide(draft, true)).toBe(saved);
    expect(request.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(1);
});

it('rejects a changed restored draft before sending a decision or another save', async () => {
    const original = { title: 'Brief', content: 'Approved text', spaceId: 'space' };
    const saved = { id: 'saved', ...original, content: 'The page was edited later.', reviewDraft: original };
    request.mockResolvedValue(saved);
    expect(await decide(original, true)).toMatchObject({ id: 'saved' });
    for (const changed of [
        { ...original, title: 'Changed' },
        { ...original, content: 'Changed' },
        { ...original, spaceId: 'other' },
    ]) {
        await expect(decide(changed, true)).rejects.toThrow('different draft');
    }
    expect(request.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(0);
});

it('matches a receipt to its draft, a left-out Space meaning the saved one', () => {
    const draft = { title: 'Brief', content: 'Text', spaceId: 'space' };
    expect(matchesReviewedDraft(page({ id: 'p', reviewDraft: draft }), { ...draft, spaceId: null })).toBe(true);
    expect(matchesReviewedDraft(page({ id: 'p', reviewDraft: draft }), { ...draft, spaceId: 'other' })).toBe(false);
    // Receipts from before draft binding match any draft.
    expect(matchesReviewedDraft(page({ id: 'p' }), {})).toBe(true);
});

it('builds the tool results the socio reads', () => {
    expect(pageReviewApproved({ id: 'p1', spaceId: 's1' }, '/spaces/s1/pages/p1')).toEqual({
        approved: true,
        pageId: 'p1',
        spaceId: 's1',
        url: '/spaces/s1/pages/p1',
    });
    expect(pageReviewDeclined({ title: 'Brief', content: 'Text' })).toEqual({
        approved: false,
        message: 'The owner declined this draft. Do not save it.',
    });
    const sentBack = pageReviewDeclined({ title: '' });
    expect(sentBack.approved).toBe(false);
    expect(sentBack.message).toMatch(/^The owner sent this draft back: it cannot be saved as sent \(title: /);
    expect(sentBack.message).toContain(`Nothing was saved. Fix it and call ${pageReviewTool.name} again.`);
    expect(pageReviewDeclined(null).message).toContain('(draft: ');
});

// A draft the person edited before saving.
const original = { title: 'Brief', content: 'Socio text', spaceId: 'space' };
const edits = { title: 'Brief, edited ', content: 'Edited text' };
const editedDraft = { ...original, title: 'Brief, edited', content: 'Edited text' };
const decideEdited = (next = edits) =>
    decidePageReview(request as unknown as PageReviewRequest, 'thread', 'call', original, true, next);

it('saves an edited draft and checks the receipt against the edits', async () => {
    const saved = { id: 'saved', ...editedDraft, reviewDraft: editedDraft };
    request.mockResolvedValueOnce(null).mockResolvedValueOnce(saved);
    expect(await decideEdited()).toBe(saved);
    // The title trimmed as the server trims it; the Space stays the draft's.
    expect(request).toHaveBeenLastCalledWith('/conversations/thread/reviewed-page', 'POST', {
        ...editedDraft,
        toolCallId: 'call',
    });
});

it('retries a lost edited save with the same edits, saving once', async () => {
    const saved = { id: 'saved', ...editedDraft, reviewDraft: editedDraft };
    request.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Connection lost'));
    await expect(decideEdited()).rejects.toThrow('Connection lost');
    request.mockResolvedValueOnce(saved);
    expect(await decideEdited()).toBe(saved);
    expect(request.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(1);
});

it('refuses a receipt for other edits, or for the unedited draft, without saving', async () => {
    request.mockResolvedValue({ id: 'saved', ...editedDraft, reviewDraft: editedDraft });
    await expect(decideEdited({ ...edits, content: 'Other edits' })).rejects.toThrow('different draft');
    request.mockResolvedValue({ id: 'saved', ...original, reviewDraft: original });
    await expect(decideEdited()).rejects.toThrow('different draft');
    expect(request.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(0);
});

it('refuses edits the server would refuse, before saving', async () => {
    request.mockResolvedValue(null);
    await expect(decideEdited({ title: '  ', content: 'Text' })).rejects.toThrow(
        /^This draft cannot be saved as edited \(title: /,
    );
    expect(request.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(0);
});

it('matches an edited receipt only through an approved, edited result naming its page', () => {
    const saved = page({ id: 'saved', reviewDraft: editedDraft });
    const result = pageReviewApproved({ id: 'saved', spaceId: 'space' }, '/spaces/space/pages/saved', {
        edited: true,
    });
    expect(matchesReviewedDraft(saved, original)).toBe(false);
    expect(matchesReviewedDraft(saved, original, result)).toBe(true);
    // CopilotKit hands the web the result as JSON text.
    expect(matchesReviewedDraft(saved, original, JSON.stringify(result))).toBe(true);
    expect(matchesReviewedDraft(saved, original, { ...result, pageId: 'other' })).toBe(false);
    expect(matchesReviewedDraft(saved, original, { ...result, edited: undefined })).toBe(false);
    expect(matchesReviewedDraft(saved, original, { ...result, approved: false })).toBe(false);
    expect(matchesReviewedDraft(saved, original, 'not json')).toBe(false);
});

it('tells the socio the person edited the draft, and only then', () => {
    const url = '/spaces/s1/pages/p1';
    const edited = pageReviewApproved({ id: 'p1', spaceId: 's1' }, url, { edited: true });
    expect(edited).toMatchObject({ approved: true, pageId: 'p1', edited: true });
    expect(edited.message).toContain('edited this draft before saving it');
    expect(pageReviewApproved({ id: 'p1', spaceId: 's1' }, url, { edited: false })).not.toHaveProperty('edited');
});
