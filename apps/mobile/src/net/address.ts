import type { VariantName } from '../../variant';

// A workspace's address, as a person types it on the add-workspace screen:
// `acme.socio.app`, `https://…` or
// a bare host. With no scheme, https is assumed, and only the origin is kept:
// the path, query and fragment go. The global URL parses it, which in the app is
// Expo's WHATWG URL (UTS #46 and punycode, as Node's), so a host comes out in
// lower case and in ASCII: an IDN as punycode, which is what the screens show.
//
// Which addresses a build accepts is fixed by its variant, from the
// config embedded at build time, never by a setting, a link or a server:
// - production: any https host on the default port, with no user name or
//   password (owner, 2026-11-15: a person may type any workspace's address, or
//   seed it from their web session with "Add a device");
// - preview: any https host, on any port, for internal tests;
// - development: preview's, plus plain http to the hosts a development build's
//   network config allows (plugins/network-security.ts), for local servers.
// Any other value gets production's rules, the strictest. No variant accepts a
// user name or password, or an `@` before the path, which `brain.example.com@evil.example`
// uses to pass for a host it isn't. What guards against a look-alike host is
// the screens, which show the host from the URL with its registrable domain
// emphasized (`WorkspaceHost`), and the probe (probe.ts), which takes only a
// Socio workspace's sign-in view before anyone signs in.

/**
 * The hosts a development build reaches over plain http: the release
 * network config's cleartext hosts (`CLEARTEXT_HOSTS` in
 * plugins/network-security.ts, which tests/net/address.test.ts holds this to).
 * `10.0.2.2` is the Android emulator's address for the machine it runs on.
 */
export const LOCAL_HTTP_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '10.0.2.2'];

/**
 * Why an address isn't accepted. The screen words each; in production,
 * `insecure` and `port` both mean "This workspace isn't
 * available in the Socio app. Ask your admin."
 */
export type AddressProblem =
    /** Nothing was typed. */
    | 'empty'
    /** Not an address: spaces inside it, a character a host can't have, an empty label (`a..b`). */
    | 'unreadable'
    /** A scheme other than https or http (`ftp://`, `socio://`). */
    | 'scheme'
    /** A user name or password, or an `@` before the path (an email address typed by mistake gets this too). */
    | 'userinfo'
    /** Plain http where this build allows only https. */
    | 'insecure'
    /** A port other than the default, which production doesn't take. */
    | 'port';

/** An address a build accepts. */
export interface WorkspaceAddress {
    /**
     * The workspace's origin, as `new URL(…).origin` gives it, so it matches the
     * server's APP_ORIGIN byte for byte: lower case, ASCII, no default port, no
     * trailing slash, and no trailing dot on the host (`https://brain.example.com`).
     */
    origin: string;
    /** The host to show, with its port when it isn't the default: from the URL, never from the workspace's branding. */
    host: string;
}

export type AddressCheck = { ok: true; address: WorkspaceAddress } | { ok: false; problem: AddressProblem };

/** The rules a variant's builds follow: production's for any value that names neither test build. */
export function addressRules(variant: string): VariantName {
    return variant === 'development' || variant === 'preview' ? variant : 'production';
}

/** A scheme the person typed: `https://`, `ftp://`. `localhost:4352` and `brain.example.com:443` have none. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Whether `text` is an address the build of `variant` (`variantFromConfig`'s
 * answer) accepts, and its origin if so.
 */
export function checkAddress(text: string, variant: string): AddressCheck {
    const typed = text.trim();
    if (typed === '') {
        return { ok: false, problem: 'empty' };
    }
    // The URL parser drops tabs and line breaks anywhere (`brain.example\t.com`
    // is `brain.example.com`): what the person sees is what gets checked.
    if (/\s/.test(typed)) {
        return { ok: false, problem: 'unreadable' };
    }
    const withScheme = SCHEME.test(typed) ? typed : `https://${typed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return { ok: false, problem: 'unreadable' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { ok: false, problem: 'scheme' };
    }
    // An `@` before the path: userinfo, or `evil.example\@brain.example.com` and
    // `evil.example?@brain.example.com`, which a reader takes for the host after
    // the `@`, though the URL's host is the one before it. The authority starts
    // where the parser starts it, after every slash and backslash that follows
    // the scheme (`https:////evil.example\@…` is evil.example too).
    const authority = withScheme
        .slice(withScheme.indexOf(':') + 1)
        .replace(/^[/\\]+/, '')
        .split('/')[0];
    if (authority.includes('@')) {
        return { ok: false, problem: 'userinfo' };
    }
    return checkUrl(url, variant);
}

/**
 * Whether the build of `variant` accepts `url`'s origin, and that origin if so:
 * `checkAddress` for a URL already parsed, such as a redirect's target. Only
 * the origin counts; the path, query and fragment are ignored.
 */
export function checkUrl(url: URL, variant: string): AddressCheck {
    const secure = url.protocol === 'https:';
    if (!secure && url.protocol !== 'http:') {
        return { ok: false, problem: 'scheme' };
    }
    if (url.username !== '' || url.password !== '') {
        return { ok: false, problem: 'userinfo' };
    }
    // One trailing dot names the same host in DNS, but the server's Host check
    // and its cookies compare the name as written, so it goes. Any other empty
    // label means the address is broken.
    const hostname = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
    if (hostname.split('.').includes('')) {
        return { ok: false, problem: 'unreadable' };
    }

    const rules = addressRules(variant);
    if (!secure && !(rules === 'development' && LOCAL_HTTP_HOSTS.includes(hostname))) {
        return { ok: false, problem: 'insecure' };
    }
    if (rules === 'production' && url.port !== '') {
        return { ok: false, problem: 'port' };
    }
    const origin = new URL(`${url.protocol}//${hostname}${url.port === '' ? '' : `:${url.port}`}`);
    return { ok: true, address: { origin: origin.origin, host: origin.host } };
}

/** A host split for showing: its registrable domain is the part to emphasize. */
export interface HostParts {
    /** The labels before the registrable domain, with their dot (`brain.`); empty when there are none. */
    readonly lead: string;
    /** The registrable domain (`example.com`): for now its last two labels, or the whole name for one label or an IP address. */
    readonly domain: string;
    /** `:<port>` when the host has one, else empty. */
    readonly port: string;
}

/**
 * Splits `WorkspaceAddress.host` for showing, with its registrable domain
 * emphasized (brain.**example.com**). It comes from the URL, never from the
 * workspace's branding. It takes the last two labels (`co.uk` names come out as
 * `co.uk`); the public suffix list can come later.
 */
export function hostParts(host: string): HostParts {
    const match = /^(\[[^\]]*\]|[^:]*)(:\d+)?$/.exec(host);
    const name = match?.[1] ?? host;
    const port = match?.[2] ?? '';
    const labels = name.split('.');
    if (name.startsWith('[') || /^\d+(\.\d+){3}$/.test(name) || labels.length <= 2) {
        return { lead: '', domain: name, port };
    }
    return { lead: `${labels.slice(0, -2).join('.')}.`, domain: labels.slice(-2).join('.'), port };
}
