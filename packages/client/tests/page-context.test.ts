import { expect, it } from 'vitest';

import { withoutPageLine } from '../src/modules/pages/page-context';

it('takes off only the page line older page chat messages start with (CB-158)', () => {
    expect(withoutPageLine('From [Notes](/spaces/space/pages/page):\n\nReview this')).toBe('Review this');
    // A source after it stays: the person added that.
    expect(withoutPageLine('From [Notes](/spaces/space/pages/page):\n\nFrom https://x.test/a:\n\nRead it')).toBe(
        'From https://x.test/a:\n\nRead it',
    );
    // Anywhere else, or in another form, it is the person's text.
    for (const text of [
        'Review this',
        'See From [Notes](/spaces/space/pages/page):\n\nhere',
        'From [Notes](/spaces/space/pages/page): Review this',
        'From [Notes](https://x.test/spaces/space/pages/page):\n\nReview this',
    ]) {
        expect(withoutPageLine(text)).toBe(text);
    }
});
