import { afterEach, describe, expect, it, vi } from 'vitest';

import { webSearch } from '../src/server/search/layer.js';
import { research, type Config } from '../src/server/web/research.js';

const signal = new AbortController().signal;
const config: Config = {
    mode: 'live',
    webSearchProvider: 'disabled',
    apiKey: 'secret',
    model: 'test-model',
    baseUrl: 'https://model.example/v1',
};
afterEach(() => vi.unstubAllGlobals());
describe('research adapters', () => {
    it('does not contact providers in sample mode and labels every result', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const result = await research(
            'Something useful',
            [],
            { mode: 'sample', baseUrl: '' },
            signal,
            () => {},
            webSearch,
        );
        expect(result.sample).toBe(true);
        expect(result.text).toContain('fictional');
        expect(fetch).not.toHaveBeenCalled();
    });
    it('fails visibly for missing live config and unsupported search', async () => {
        await expect(
            research('Research', [], { mode: 'live', baseUrl: '' }, signal, () => {}, webSearch),
        ).rejects.toThrow('not configured');
        // With search disabled there is no source to ground in; the standalone
        // browser reader is gone (CB-319).
        await expect(research('Read https://example.com', [], config, signal, () => {}, webSearch)).rejects.toThrow(
            'not configured',
        );
    });
});
