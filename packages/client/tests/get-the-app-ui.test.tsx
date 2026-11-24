// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SignInMethods } from '@socio/shared/auth';

import { SignInSetup } from '../src/shell/current-user';
import { appLink, forgetAppLink, GetTheAppBanner, GetTheAppDialog, onPhone } from '../src/shell/GetTheApp';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-352: "Get the app", the banner and the workspace QR code.

const LINK = 'https://link.socio.sh/app/w/brain.example.com';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
let host: HTMLDivElement;
let root: Root;
let answer: () => Response;
let fetched: number;
// Real accounts (the mock sign-in has no app-link route).
const Banner = ({ accounts = true }: { accounts?: boolean }) => (
    <SignInSetup.Provider value={accounts ? ({ password: true } as unknown as SignInMethods) : undefined}>
        <GetTheAppBanner />
    </SignInSetup.Provider>
);

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    answer = () => Response.json({ url: LINK });
    fetched = 0;
    vi.stubGlobal('fetch', async () => {
        fetched += 1;
        return answer();
    });
    localStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    forgetAppLink();
});

async function settle() {
    for (let i = 0; i < 5; i++) {
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
}
const banner = () => host.querySelector('[data-slot="get-the-app-banner"]');
const asPhone = (userAgent: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);

it('tells a phone from a computer', () => {
    expect(onPhone(IPHONE)).toBe(true);
    expect(onPhone('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36')).toBe(true);
    expect(onPhone(DESKTOP)).toBe(false);
});

it('offers the app on a phone’s browser, until dismissed', async () => {
    asPhone(IPHONE);
    await act(() => root.render(<Banner />));
    await settle();
    expect(banner()).not.toBeNull();
    expect(banner()!.querySelector('a')!.getAttribute('href')).toBe(LINK);
    await act(async () => banner()!.querySelector<HTMLButtonElement>('button[aria-label="Not now"]')!.click());
    expect(banner()).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await act(() => root.render(<Banner />));
    await settle();
    expect(banner()).toBeNull();
});

it('shows no banner on a computer', async () => {
    asPhone(DESKTOP);
    await act(() => root.render(<Banner />));
    await settle();
    expect(banner()).toBeNull();
});

it('offers nothing where the workspace sends no app links', async () => {
    asPhone(IPHONE);
    answer = () => Response.json({ url: null });
    await act(() => root.render(<Banner />));
    await settle();
    expect(banner()).toBeNull();
    expect(await appLink()).toBeNull();
});

it('never takes a link with a fragment (a code) as the workspace’s', async () => {
    answer = () => Response.json({ url: `${LINK}#c=ABCDEFGH` });
    expect(await appLink()).toBeNull();
});

it('shows the workspace QR code, which carries no code', async () => {
    await act(() => root.render(<GetTheAppDialog link={LINK} onClose={() => {}} />));
    const image = document.body.querySelector<HTMLImageElement>('[data-slot="get-the-app-code"]')!;
    expect(image.src).toMatch(/^data:image\/svg\+xml/);
    expect(document.body.querySelector('[data-slot="get-the-app-link"]')!.textContent).toBe(LINK);
    expect(new URL(LINK).hash).toBe('');
    expect(document.body.textContent).toContain('they still sign in as themselves');
});

it('works where the browser blocks storage: shown, and put away for the page', async () => {
    asPhone(IPHONE);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Full', 'QuotaExceededError');
    });
    await act(() => root.render(<Banner />));
    await settle();
    expect(banner()).not.toBeNull();
    await act(async () => banner()!.querySelector<HTMLButtonElement>('button[aria-label="Not now"]')!.click());
    expect(banner()).toBeNull();
});

it('asks nothing without real accounts', async () => {
    asPhone(IPHONE);
    await act(() => root.render(<Banner accounts={false} />));
    await settle();
    expect(banner()).toBeNull();
    expect(fetched).toBe(0);
});
