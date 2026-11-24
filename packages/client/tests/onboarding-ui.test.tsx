// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { OnboardingPreferences } from '@socio/shared/onboarding';

import { openGuides } from '../src/modules/onboarding/events';
import { availableGuides } from '../src/modules/onboarding/guides';
import { chatView } from '../src/modules/onboarding/Onboarding';
import { visibleTarget, waitForTarget } from '../src/modules/onboarding/targets';
import { setHelpAnchor } from '../src/shell/help-anchor';

import { OnboardingFixture, exampleWorkspace } from './fixtures/onboarding-app';
import { exampleModules, exampleState } from './fixtures/onboarding-app';

let root: Root, host: HTMLElement;
let saved: OnboardingPreferences, writes: Array<{ url: string; body: Record<string, unknown> }>;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    saved = {};
    writes = [];
    window.matchMedia = (query: string) =>
        ({
            matches: true,
            media: query,
            addEventListener() {},
            removeEventListener() {},
        }) as unknown as MediaQueryList;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 220,
        height: 80,
        top: 0,
        left: 0,
        bottom: 80,
        right: 220,
        toJSON() {},
    });
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue({
        length: 1,
        item: () => null,
        [Symbol.iterator]: function* () {},
    } as DOMRectList);
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            writes.push({ url, body });
            expect(url).toBe('/api/preferences');
            expect(init?.method).toBe('PATCH');
            saved = { ...saved, ...body.onboarding };
            return Response.json({ dictation: null, onboarding: saved });
        }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
async function until(check: () => boolean) {
    for (const end = Date.now() + 5000; Date.now() < end;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((r) => setTimeout(r, 10)));
    }
    throw Error(document.body.textContent ?? 'Timed out');
}
const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
function click(text: string) {
    act(() => button(text).click());
}
function mount(progress?: OnboardingPreferences) {
    act(() => root.render(<OnboardingFixture workspace={exampleWorkspace('member', progress)} />));
}
it('offers optional onboarding; skip is saved and remains dismissed after a fresh sign-in render', async () => {
    mount();
    click('Skip');
    await until(() => saved['getting-started']?.status === 'dismissed');
    expect(document.querySelector('[data-tour="onboarding-offer"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    mount(saved);
    expect(document.querySelector('[data-tour="onboarding-offer"]')).toBeNull();
    expect(writes).toHaveLength(1);
});
it('opens the offer from the header’s Help button, out of the bottom corner, and keeps it out of the way after Skip (CB-308)', async () => {
    const help = document.createElement('button');
    help.setAttribute('aria-label', 'Help');
    document.body.append(help);
    act(() => setHelpAnchor(help));
    try {
        mount();
        const offer = document.querySelector<HTMLElement>('[data-tour="onboarding-offer"]')!;
        // A popover beside the button, not the fixed panel in the corner.
        expect(offer.dataset.slot).toBe('popover-content');
        expect(offer.className).not.toContain('fixed');
        expect(offer.getAttribute('aria-label')).toBe('Getting started guide');
        expect(offer.textContent).toContain('Find your way around Socio');
        expect(offer.textContent).toContain('Later: Help → Help and guides');
        // It doesn't take the focus from the page.
        expect(offer.contains(document.activeElement)).toBe(false);
        click('Skip');
        await until(() => saved['getting-started']?.status === 'dismissed');
        expect(document.querySelector('[data-tour="onboarding-offer"]')).toBeNull();
        // Help and guides still opens the guides.
        act(() => openGuides());
        expect(document.body.textContent).toContain('Help & getting started');
    } finally {
        act(() => setHelpAnchor(null));
        help.remove();
    }
});

it('opens the offer from Help only on Home, not over another page’s controls (CB-308)', () => {
    const help = document.createElement('button');
    help.setAttribute('aria-label', 'Help');
    document.body.append(help);
    act(() => setHelpAnchor(help));
    try {
        act(() => root.render(<OnboardingFixture workspace={exampleWorkspace('member')} path="/issues" />));
        expect(document.querySelector('[data-tour="onboarding-offer"]')).toBeNull();
    } finally {
        act(() => setHelpAnchor(null));
        help.remove();
    }
});
it('waits off a chat’s or a room’s view, whose composer and status line it would cover (CB-219)', () => {
    for (const path of ['/chats/r1', '/chats/r1/', '/dots/fixture-socio/new']) {
        act(() => root.render(<OnboardingFixture key={path} path={path} workspace={exampleWorkspace('member')} />));
        expect(document.querySelector('[data-tour="onboarding-offer"]')).toBeNull();
    }
    for (const path of ['/', '/dots/fixture-socio', '/spaces/fixture-space']) {
        act(() => root.render(<OnboardingFixture key={path} path={path} workspace={exampleWorkspace('member')} />));
        expect(document.querySelector('[data-tour="onboarding-offer"]')).not.toBeNull();
    }
    expect(chatView('/chats/r1')).toBe(true);
    expect(chatView('/chats')).toBe(false);
    expect(chatView('/dots/x/soul')).toBe(false);
});
it('uses actual Driver, preserves step on Read More, handles routes and records Escape dismissal; replay and restart work', async () => {
    mount();
    click('Start guide');
    await until(() => !!document.querySelector('.driver-popover'));
    expect(document.querySelector('.driver-popover-title')?.textContent).toBe('Welcome to Socio');
    const more = document.querySelector<HTMLAnchorElement>('.socio-tour-links a')!;
    expect(more.getAttribute('href')).toBe('/docs/getting-started');
    expect(more.target).toBe('_blank');
    expect(more.rel).toBe('noopener');
    click('Next');
    await until(() => document.querySelector('.driver-popover-title')?.textContent === 'Choose a socio');
    expect(document.querySelector<HTMLAnchorElement>('.socio-tour-links a')!.getAttribute('href')).toBe('/docs/socios');
    act(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })));
    await until(() => !document.querySelector('.driver-overlay'));
    await until(() => saved['getting-started']?.status === 'dismissed');
    expect(saved['getting-started']?.stepId).toBe('choose-socio');
    act(() => openGuides('getting-started'));
    await until(() => document.querySelector('.driver-popover-title')?.textContent === 'Choose a socio');
    act(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })));
    await until(() => !document.querySelector('.driver-overlay'));
    act(() => openGuides());
    await until(() => !!button('Restart Getting started'));
    click('Restart Getting started');
    await until(() => document.querySelector('.driver-popover-title')?.textContent === 'Welcome to Socio');
    expect(writes.every((x) => Object.keys(x.body).join() === 'onboarding')).toBe(true);
});
it('bounds missing targets, aborts waits on unmount, and never highlights hidden targets', async () => {
    const abort = new AbortController();
    const promise = waitForTarget('[data-never-mounted]', abort.signal, 10);
    expect(await promise).toBeUndefined();
    const cancellation = new AbortController();
    const pending = waitForTarget('[data-never-mounted]', cancellation.signal, 10000);
    cancellation.abort();
    expect(await pending).toBeUndefined();
    const div = document.createElement('div');
    div.dataset.hiddenTarget = '';
    div.style.display = 'none';
    host.append(div);
    expect(visibleTarget('[data-hidden-target]')).toBeUndefined();
    mount({
        'getting-started': {
            version: 1,
            status: 'in_progress',
            stepId: 'page-conversation',
        },
    });
    click('Continue guide');
    await until(() => !!document.querySelector('.driver-popover'));
    expect(document.querySelector('.driver-popover-description')?.textContent).toContain('not visible');
    act(() => root.unmount());
    root = createRoot(host);
    expect(document.querySelector('.driver-overlay')).toBeNull();
});
it('filters admin guides and unavailable features; every substantive step has a topic article and stable identity', () => {
    for (const role of ['member', 'admin'] as const) {
        const workspace = exampleWorkspace(role);
        const context = {
            workspace,
            state: exampleState,
            admin: role !== 'member',
            configured: true,
            homeDot: workspace.dots[0],
        };
        const guides = availableGuides(context, exampleModules);
        expect(guides.some((g) => g.id === 'administration')).toBe(role !== 'member');
        // Running Socio is an admin's guide too (CB-390: no operator role).
        expect(guides.some((g) => g.id === 'operations')).toBe(role === 'admin');
        expect(guides.map((g) => g.title)).not.toContain('Operator guide');
        for (const guide of guides) {
            expect(new Set(guide.steps.map((s) => s.id)).size).toBe(guide.steps.length);
            for (const step of guide.steps) {
                expect(step.article).toMatch(/^\/docs\/[a-z][a-z/-]+$/);
                expect(step.article).not.toBe('/docs');
                if (role === 'member') {
                    expect(step.article).not.toMatch(/\/docs\/(admin|operate)/);
                }
            }
        }
        const unavailable = availableGuides({ ...context, configured: false }, []);
        expect(unavailable.some((g) => g.id === 'goals-schedules')).toBe(false);
        expect(unavailable.flatMap((g) => g.steps).some((s) => s.module)).toBe(false);
    }
});

it('releases a disappearing highlighted target into the bounded fallback without advancing or submitting anything', async () => {
    mount();
    click('Start guide');
    await until(() => !!document.querySelector('.driver-popover'));
    const title = document.querySelector('.driver-popover-title')?.textContent;
    document.querySelector('[data-tour="home"]')!.remove();
    await until(
        () => document.querySelector('.driver-popover-description')?.textContent?.includes('not visible') === true,
    );
    expect(document.querySelector('.driver-popover-title')?.textContent).toBe(title);
    expect(saved['getting-started']?.stepId).toBe('welcome');
    expect(writes.every((x) => x.url === '/api/preferences')).toBe(true);
});

it('pauses the overlay before opening Help and retains a resumable step instead of marking it dismissed', async () => {
    mount();
    click('Start guide');
    await until(() => !!document.querySelector('.driver-popover'));
    click('Next');
    await until(() => document.querySelector('.driver-popover-title')?.textContent === 'Choose a socio');
    act(() => openGuides());
    await until(() => !!button('Continue Getting started'));
    expect(document.querySelector('.driver-overlay')).toBeNull();
    expect(saved['getting-started']?.status).toBe('in_progress');
    click('Continue Getting started');
    await until(() => document.querySelector('.driver-popover-title')?.textContent === 'Choose a socio');
});
