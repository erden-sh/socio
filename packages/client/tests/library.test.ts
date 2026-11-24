import { expect, it } from 'vitest';

import { pageExcerpt } from '../src/modules/spaces/SpaceLibrary';

it('shows readable library previews without changing source content', () => {
    const source =
        '---\ntitle: Metadata\n---\n\n# Checklist\n- [ ] First task\n- [x] **Done**\n\n<details><summary>Context</summary>Notes</details>';
    expect(pageExcerpt(source)).toBe('Checklist First task Done Context Notes');
    expect(source).toContain('<details>');
    expect(source).toContain('- [ ]');
});

it('drops a first line that only repeats the page title (CB-308)', () => {
    expect(pageExcerpt('# Weekly **plan**\n\nShip the library.', 'Weekly plan')).toBe('Ship the library.');
    expect(pageExcerpt('\nWeekly plan\nShip it.', 'Weekly plan')).toBe('Ship it.');
    // A first line that only starts with the title stays.
    expect(pageExcerpt('# Weekly plan, revised\nShip it.', 'Weekly plan')).toBe('Weekly plan, revised Ship it.');
    expect(pageExcerpt('# Notes\nShip it.')).toBe('Notes Ship it.');
});
