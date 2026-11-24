import { expect, it } from 'vitest';

import { formatTokens } from '@socio/shared/token-count';

it('shows small token counts whole', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(453)).toBe('453');
    expect(formatTokens(999)).toBe('999');
});

it('shows thousands with one decimal', () => {
    expect(formatTokens(1_000)).toBe('1.0k');
    expect(formatTokens(1_289)).toBe('1.3k');
    expect(formatTokens(72_240)).toBe('72.2k');
    expect(formatTokens(399_100)).toBe('399.1k');
});

it('shows millions with two decimals, from where thousands would round up', () => {
    expect(formatTokens(999_949)).toBe('999.9k');
    expect(formatTokens(999_950)).toBe('1.00M');
    expect(formatTokens(1_358_500)).toBe('1.36M');
    expect(formatTokens(12_000_000)).toBe('12.00M');
    expect(formatTokens(1_234_567_890)).toBe('1,234.57M');
});
