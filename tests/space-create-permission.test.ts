import { expect, it } from 'vitest';

import { canCreateSpaces, spaceCreatorsInForce } from '@socio/shared/spaces/create-permission';

// The "create Spaces" permission (`@socio/shared/spaces/create-permission`):
// everyone unless an admin keeps it to admins; admins and operators always.

it('lets everyone create Spaces by default', () => {
    expect(spaceCreatorsInForce({})).toBe('everyone');
    for (const role of ['member', 'admin'] as const) {
        expect(canCreateSpaces({ role }, {}), role).toBe(true);
        expect(canCreateSpaces({ role }, { spaceCreators: 'everyone' }), role).toBe(true);
    }
});

it('keeps it to admins and operators when an admin chose admins only', () => {
    const settings = { spaceCreators: 'admins' } as const;
    expect(canCreateSpaces({ role: 'member' }, settings)).toBe(false);
    expect(canCreateSpaces({ role: 'admin' }, settings)).toBe(true);
    expect(canCreateSpaces({ role: 'admin' }, settings)).toBe(true);
});

it('lets no one without a user', () => {
    expect(canCreateSpaces(undefined, {})).toBe(false);
});
