// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import { createReactI18n, I18nextProvider, useTranslation } from '@socio/i18n/react';
import type { PageI18n } from '@socio/shared/web/web';

import { pageInstance } from '../src/i18n/page-instance';
import { onDemand } from '../src/modules/settings/on-demand';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// A card whose words no route inlines (on-demand.tsx): the server renders
// nothing for it (its instance has no backend, so it would call the
// missing namespace ready and print keys), the browser hydrates the same
// nothing, then shows the card once its dictionary is in.

function Card() {
    const { t } = useTranslation(['settings.workspace-limits']);
    return <h3 data-slot="limits">{t('settings.workspace-limits:groups.schedules-jobs.title')}</h3>;
}
const LimitsCard = onDemand(['settings.workspace-limits'], Card);

const page: PageI18n = {
    locale: 'en-US',
    dir: 'ltr',
    manifest: {
        release: '1.0.0',
        locales: { 'en-US': { coverage: 1, ns: { 'settings.workspace-limits': { hash: 'abc', sourceHash: 'abc' } } } },
    },
    resources: { 'en-US': { common: { product: 'Socio' } } },
    offered: ['en-US'],
};

let root: Root | undefined;
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

it('renders an on-demand card neither on the server nor while hydrating, then once its words are in', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // The server's instance: the page's inlined dictionaries, no backend.
    const server = createReactI18n({ locale: page.locale, resources: page.resources as never, namespaces: ['common'] });
    const html = renderToString(
        <I18nextProvider i18n={server}>
            <LimitsCard />
        </I18nextProvider>,
    );
    expect(html).toBe('');

    let served!: () => void;
    const loaded = new Promise<void>((resolve) => (served = resolve));
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            expect(String(url)).toBe('/i18n/en-US/settings.workspace-limits.abc.json');
            served();
            return Response.json({ groups: { 'schedules-jobs': { title: 'Schedules and jobs' } } });
        }),
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.append(host);
    const browser = pageInstance(page);
    const mismatches: unknown[] = [];
    await act(async () => {
        root = hydrateRoot(
            host,
            <I18nextProvider i18n={browser}>
                <LimitsCard />
            </I18nextProvider>,
            { onRecoverableError: (error) => mismatches.push(error) },
        );
    });
    await act(async () => loaded);
    for (let tick = 0; tick < 5 && !host.querySelector('[data-slot="limits"]'); tick++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    expect(mismatches).toEqual([]);
    expect(host.querySelector('[data-slot="limits"]')?.textContent).toBe('Schedules and jobs');
});
