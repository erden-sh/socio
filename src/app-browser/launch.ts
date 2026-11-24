import type { BrowserContextOptions, LaunchOptions } from 'playwright';

/**
 * How a context worker starts Chromium (CB-232).
 * One place, so the spec tests read exactly what production runs.
 *
 * - The sandbox is on. Playwright launches Chromium without it unless
 *   asked (`chromiumSandbox` defaults to false and adds --no-sandbox), and
 *   app pages run JavaScript here, so a renderer exploit must land in a
 *   sandboxed renderer, not in the worker. The container gets the seccomp
 *   profile the namespace sandbox needs (deploy-spec.ts); with no usable
 *   sandbox Chromium refuses to start, and the router's start-up self-test
 *   refuses to serve (router.ts).
 * - The network is dead for everything the context's routing doesn't
 *   fulfil itself: no name resolves, every connection goes to a proxy
 *   that points nowhere (loopback included), WebRTC sends nothing
 *   non-proxied. DNS prefetch, preconnect and STUN therefore send no
 *   packet even before the container's internal network stops them.
 */

/** A proxy address nothing listens on: every unrouted connection fails. */
export const DEAD_PROXY = 'http://127.0.0.1:9';

/** Per-context memory cap for page JavaScript, in MB. */
export const RENDERER_HEAP_MB = 256;

export const CHROMIUM_ARGS: readonly string[] = [
    // No name resolves: a page can't signal by DNS (dns-prefetch of
    // <data>.attacker.example), and the app's public name is never looked up.
    '--host-resolver-rules=MAP * ~NOTFOUND',
    // Every connection Chromium makes itself (preconnect, background
    // traffic) goes to a proxy that isn't there; loopback too, which
    // Chromium otherwise exempts from proxies.
    `--proxy-server=${DEAD_PROXY}`,
    '--proxy-bypass-list=<-loopback>',
    // WebRTC: no UDP outside the (dead) proxy, so no STUN.
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--dns-prefetch-disable',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--no-pings',
    '--disable-dev-shm-usage',
    '--renderer-process-limit=2',
    `--js-flags=--max-old-space-size=${RENDERER_HEAP_MB}`,
];

/** Arguments a launch must never carry: each turns a protection off. */
export const FORBIDDEN_ARGS: readonly RegExp[] = [
    /^--no-sandbox$/,
    /^--disable-setuid-sandbox$/,
    /^--no-zygote$/,
    /^--disable-web-security$/,
    /^--remote-debugging/,
    /^--allow-running-insecure-content$/,
    /^--disable-site-isolation-trials$/,
];

export function chromiumLaunchOptions(home?: string): LaunchOptions {
    return {
        headless: true,
        // Playwright's default is false.
        chromiumSandbox: true,
        args: [...CHROMIUM_ARGS],
        // Nothing of the worker's environment reaches Chromium but these.
        env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: home ?? process.env.HOME ?? '/tmp',
            TMPDIR: home ?? process.env.TMPDIR ?? '/tmp',
        },
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
    };
}

/**
 * The context: JavaScript on (apps are pages), but no service workers,
 * downloads, permissions or stored state; the cookie jar starts and stays
 * empty (no credential in the page).
 */
export function contextOptions(): BrowserContextOptions {
    return {
        javaScriptEnabled: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
        permissions: [],
        bypassCSP: false,
        ignoreHTTPSErrors: false,
        viewport: { width: 1280, height: 800 },
    };
}

/**
 * Before any page script: WebRTC's constructors are gone (defense in
 * depth behind the flags above and the dead network).
 */
export const PAGE_INIT_SCRIPT = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate']) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
})();`;
