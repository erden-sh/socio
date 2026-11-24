import { describe, expect, it } from 'vitest';

import { keptSpaceLine, keptSpaceRows } from '../../src/shell/keep-offline';

// Settings' "Spaces kept offline" rows.

describe('the kept Spaces in Settings', () => {
    const spaces = [
        { id: 'everyday', name: 'Everyday' },
        { id: 'ops', name: 'Operations' },
    ];

    it('lists each kept Space the workspace lists, in the order kept, with its pages and size', () => {
        const sizes = new Map([
            ['ops', { pages: 1, bytes: 900 }],
            ['everyday', { pages: 12, bytes: 348_160 }],
        ]);
        expect(keptSpaceRows(['ops', 'gone', 'everyday'], spaces, sizes)).toEqual([
            { id: 'ops', name: 'Operations', line: '1 page · 900 B', testID: 'settings-kept-space-ops' },
            { id: 'everyday', name: 'Everyday', line: '12 pages · 340 KB', testID: 'settings-kept-space-everyday' },
        ]);
    });

    it('says Measuring… until the sizes come', () => {
        expect(keptSpaceRows(['everyday'], spaces, null).map((row) => row.line)).toEqual(['Measuring…']);
        expect(keptSpaceLine({ pages: 0, bytes: 0 })).toMatch(/^0 pages · /);
    });
});
