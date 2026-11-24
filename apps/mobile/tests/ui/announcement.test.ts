import { describe, expect, it } from 'vitest';

import { announcement, announcesHere } from '../../src/ui/announcement';

// What iOS's screen reader is told as a Field's error or a Banner's words
// come and go (src/ui/use-announcement.ts keeps the last message said and asks
// this on every change).

/** Each message in turn, as the hook sees them, with what it announces. */
function run(first: string | undefined, messages: readonly (string | undefined)[]) {
    let said = first;
    return messages.map((message) => {
        const text = announcement(said, message);
        said = message;
        return text;
    });
}

describe('announcements', () => {
    it('say a field’s error when it appears, once, and again when it changes or comes back', () => {
        // onAppear: nothing counts as said before the first render.
        expect(run(undefined, [undefined, 'Enter an address.', 'Enter an address.', 'No workspace there.'])).toEqual([
            undefined,
            'Enter an address.',
            undefined,
            'No workspace there.',
        ]);
        expect(run(undefined, ['Enter an address.', undefined, 'Enter an address.'])).toEqual([
            'Enter an address.',
            undefined,
            'Enter an address.',
        ]);
    });

    it('say an error banner when it appears, even under React’s second run of an effect', () => {
        expect(run(undefined, ['Couldn’t reach the workspace.', 'Couldn’t reach the workspace.'])).toEqual([
            'Couldn’t reach the workspace.',
            undefined,
        ]);
    });

    it('say another banner only when its words change', () => {
        // Without onAppear, its first words count as said.
        const words = 'This socio is archived.';
        expect(run(words, [words, words, 'The workspace is paused.'])).toEqual([
            undefined,
            undefined,
            'The workspace is paused.',
        ]);
    });

    it('say nothing for no message or an empty one', () => {
        expect(announcement(undefined, undefined)).toBeUndefined();
        expect(announcement('Before', '')).toBeUndefined();
    });

    it('are said by the hook on iOS always, and on Android only when no view shows the message', () => {
        expect(announcesHere('ios', { shown: true })).toBe(true);
        expect(announcesHere('ios', { shown: false })).toBe(true);
        // A shown message has its view's live region on Android.
        expect(announcesHere('android', { shown: true })).toBe(false);
        expect(announcesHere('android', { shown: false })).toBe(true);
    });
});
