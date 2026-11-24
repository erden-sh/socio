import { expect, it } from 'vitest';

import { count, isObject, roundTokens } from '@socio/shared/runs/token-usage';

it('reads a round’s tokens from TanStack’s usage shape', () => {
    expect(
        roundTokens({
            promptTokens: 120,
            completionTokens: 30,
            promptTokensDetails: { cachedTokens: 100 },
            completionTokensDetails: { reasoningTokens: 12 },
        }),
    ).toEqual({ inputTokens: 120, outputTokens: 30, reasoningTokens: 12, cachedTokens: 100 });
});

it('reads AG-UI’s usage array, and leaves out what was not reported', () => {
    expect(roundTokens([{ inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 }])).toEqual({
        inputTokens: 5,
        outputTokens: 2,
        cachedTokens: 1,
    });
    expect(roundTokens([{ inputTokens: -1, outputTokens: 2.6, reasoningTokens: Number.NaN }])).toEqual({
        outputTokens: 3,
    });
});

it('gives nothing for usage that is not an object', () => {
    expect(roundTokens(undefined)).toEqual({});
    expect(roundTokens([])).toEqual({});
    expect(roundTokens('12')).toEqual({});
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(count('3')).toBeUndefined();
});
