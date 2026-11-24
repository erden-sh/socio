import { expect, it } from 'vitest';

import { toolError } from '../src/http/tool-error.js';

it('gives a domain error as a tool result: its message, and its status as the code', () => {
    expect(toolError(Object.assign(new Error('Goal not found.'), { status: 404 }))).toEqual({
        error: 'Goal not found.',
        code: 'http_404',
    });
    expect(toolError({ message: 'Not allowed.', status: 403 })).toEqual({ error: 'Not allowed.', code: 'http_403' });
});
