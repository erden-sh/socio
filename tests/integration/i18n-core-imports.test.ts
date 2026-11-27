import { join } from 'node:path';

import { expect, it } from 'vitest';

import { thirdPartyReach } from '../../scripts/check-package-boundary.mjs';

// The native app runs the core entry under plain Node too (its data, sync and
// network code), where React isn't loaded: `@socio/i18n` reaches i18next and
// nothing of React; the binding is `@socio/i18n/react`.
const root = join(import.meta.dirname, '../..');

it('keeps React out of the core entry', () => {
    const reached = thirdPartyReach(root, ['packages/i18n/src/index.ts']).map((line) => line.split(': ')[1]);
    expect(new Set(reached)).toEqual(new Set(['i18next']));
});

it('puts React in the binding', () => {
    const reached = thirdPartyReach(root, ['packages/i18n/src/react.ts']).map((line) => line.split(': ')[1]);
    expect(reached).toContain('react-i18next');
});
