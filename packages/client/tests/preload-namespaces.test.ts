// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import type { PageI18n } from '@socio/shared/web/web';

import { pageInstance, preloadNamespaces } from '../src/i18n/page-instance';

// A route's clientLoader starts its page's on-demand namespaces without
// waiting for them (`void preloadNamespaces(…)`), so the promise must never
// reject: not when a file fails to load, and not when i18next throws as it
// starts the load.

const page: PageI18n = {
    locale: 'en-US',
    dir: 'ltr',
    manifest: {
        release: '1.0.0',
        locales: { 'en-US': { coverage: 1, ns: { rooms: { hash: 'abc', sourceHash: 'abc' } } } },
    },
    resources: { 'en-US': { common: { product: 'Socio' } } },
    offered: ['en-US'],
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('resolves once the namespaces are in', async () => {
    const instance = pageInstance(page);
    vi.stubGlobal('fetch', async () => Response.json({ title: 'Rooms' }));
    await expect(preloadNamespaces(['rooms'])).resolves.toBeUndefined();
    expect(instance.hasResourceBundle('en-US', 'rooms')).toBe(true);
});

it('resolves when a namespace fails to load', async () => {
    pageInstance(page);
    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
    await expect(preloadNamespaces(['rooms'])).resolves.toBeUndefined();
});

it('resolves when i18next throws as it starts the load', async () => {
    const instance = pageInstance(page);
    vi.spyOn(instance, 'loadNamespaces').mockImplementation(() => {
        throw new Error('backend gone');
    });
    await expect(preloadNamespaces(['rooms'])).resolves.toBeUndefined();
});

it('resolves when i18next’s own promise rejects', async () => {
    const instance = pageInstance(page);
    vi.spyOn(instance, 'loadNamespaces').mockImplementation(() => Promise.reject(new Error('backend gone')));
    await expect(preloadNamespaces(['rooms'])).resolves.toBeUndefined();
});
