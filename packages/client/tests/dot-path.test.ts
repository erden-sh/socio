import { describe, expect, it } from 'vitest';

import type { Dot } from '@socio/shared/types';

import { dotPath, newChatPath } from '../src/modules/chat/nav';

const dot = { id: 'd1' } as Dot;

describe('dotPath', () => {
    // CB-89: the same page every time, whatever chats there are.
    it('opens the Dot’s home page', () => {
        expect(dotPath(dot)).toBe('/dots/d1');
    });
    it('starts a new chat under it', () => {
        expect(newChatPath(dot)).toBe('/dots/d1/new');
        expect(newChatPath({ id: 'a b' })).toBe('/dots/a%20b/new');
    });
});
