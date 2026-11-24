import { describe, expect, it } from 'vitest';

import {
    AUTOSAVE_DEBOUNCE_MS,
    pageDraftError,
    pageDraftOf,
    pageTitle,
    sameDraft,
    trimmedDraft,
} from '@socio/shared/pages/page-draft';
import type { Page } from '@socio/shared/pages/page-library';

// The page autosave rules the web and the app share.
const page = { id: 'a', title: 'Title', content: 'Body', parentId: null, revision: 3 } as Page;
const refusal = 'Use a title up to 160 characters and a document up to 100,000 characters. Your draft is still here.';

it('takes only the fields an autosave sends, and compares them all', () => {
    const draft = pageDraftOf(page);
    expect(draft).toEqual({ title: 'Title', content: 'Body', parentId: null });
    expect(sameDraft(draft, { ...draft })).toBe(true);
    expect(sameDraft(draft, { ...draft, title: 'Title ' })).toBe(false);
    expect(sameDraft(draft, { ...draft, content: 'Body!' })).toBe(false);
    expect(sameDraft(draft, { ...draft, parentId: 'p' })).toBe(false);
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(800);
});

it('trims the title as the server does, so a sent draft matches the page it gets back', () => {
    expect(pageTitle('  Plans \n')).toBe('Plans');
    const sent = trimmedDraft({ title: 'Plans   ', content: ' keep ', parentId: null });
    expect(sent).toEqual({ title: 'Plans', content: ' keep ', parentId: null });
    expect(sameDraft(sent, pageDraftOf({ ...page, title: 'Plans', content: ' keep ' }))).toBe(true);
});

describe('the limits', () => {
    const draft = (title: string, content = '') => ({ title, content, parentId: null });

    it('refuse an empty title, one over 160 characters after trimming, or a document over 100,000', () => {
        expect(pageDraftError(draft(''))).toBe(refusal);
        expect(pageDraftError(draft('   '))).toBe(refusal);
        expect(pageDraftError(draft('x'.repeat(161)))).toBe(refusal);
        expect(pageDraftError(draft('ok', 'x'.repeat(100001)))).toBe(refusal);
    });

    it('take a title of 1 to 160 characters after trimming and a document up to 100,000', () => {
        expect(pageDraftError(draft('x'))).toBeUndefined();
        expect(pageDraftError(draft('x'.repeat(160)))).toBeUndefined();
        expect(pageDraftError(draft(`  ${'x'.repeat(160)}  `))).toBeUndefined();
        expect(pageDraftError(draft('ok', 'x'.repeat(100000)))).toBeUndefined();
    });
});
