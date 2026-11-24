import { runInNewContext } from 'node:vm';

import { type AppVariant, LINK_HOST, LINK_STAGING_HOST } from '@socio/shared/device-sign-in';

import { type Env, handle } from '../src/index';

/** The host each variant's links live on (apps.ts, HOST_VARIANTS). */
export const hostOf = (variant: AppVariant) => (variant === 'development' ? LINK_STAGING_HOST : LINK_HOST);

/** The host a path's variant lives on: `/dev/…` on staging, anything else on link.socio.sh. */
const hostForPath = (path: string) => (path.startsWith('/dev/') ? LINK_STAGING_HOST : LINK_HOST);

export const get = (path: string, init: RequestInit = {}, host = hostForPath(path), env: Env = {}) =>
    handle(new Request(`https://${host}${path}`, init), env);

/** A page's one inline script and its data block, as the Worker wrote them. */
export function pageParts(html: string) {
    const data = /<script type="application\/json" id="link-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    return { data, scripts };
}

interface Element {
    hidden: boolean;
    textContent: string;
    href?: string;
}

export interface Run {
    /** The page's elements by id, after the script ran. */
    elements: Map<string, Element>;
    /** Everything the script touched beyond what a page may do: requests, navigation, markup, any other write. */
    touched: string[];
}

/** What the script may set on a page element: `hidden` and `textContent` on any, `href` on an anchor only. */
const SETTABLE = (tag: string, key: string) =>
    key === 'hidden' || key === 'textContent' || (key === 'href' && tag === 'a');

/**
 * Runs a page's script against a stand-in browser at `href`: the page's own elements (by id, with
 * their `hidden` attribute), its location, and a trap for every way to make a request, navigate or
 * write markup. Reads and writes are both watched: `document`, `location` and each element allow
 * only what a page script needs (reading the data and the fragment; setting `hidden`,
 * `textContent`, and an anchor's `href`), and record anything else, assigning a global included.
 * Any other global is missing, so reading one throws.
 */
export function runPage(html: string, href: string): Run {
    const { data, scripts } = pageParts(html);
    if (data === undefined || scripts.length !== 1) {
        throw new Error('not a link page');
    }
    const touched: string[] = [];
    const trap = (name: string): unknown =>
        new Proxy(function () {}, {
            apply: () => void touched.push(name),
            construct: () => (touched.push(`new ${name}`), {}),
            get: (_, key) => (touched.push(`${name}.${String(key)}`), trap(`${name}.${String(key)}`)),
            set: (_, key) => (touched.push(`${name}.${String(key)}=`), true),
            defineProperty: (_, key) => (touched.push(`define ${name}.${String(key)}`), true),
            deleteProperty: (_, key) => (touched.push(`delete ${name}.${String(key)}`), true),
        });
    /** A watched object: reads of `readable` pass, `settable` writes pass, anything else is recorded. */
    const watched = <T extends object>(
        name: string,
        target: T,
        readable: (key: string) => boolean,
        settable: (key: string) => boolean,
    ) =>
        new Proxy(target, {
            get: (object, key) =>
                typeof key === 'string' && readable(key) && key in object
                    ? object[key as keyof T]
                    : (touched.push(`${name}.${String(key)}`), trap(`${name}.${String(key)}`)),
            set: (object, key, value) => {
                if (typeof key === 'string' && settable(key)) {
                    (object as Record<string, unknown>)[key] = value;
                } else {
                    touched.push(`${name}.${String(key)}=`);
                }
                return true;
            },
            defineProperty: (_, key) => (touched.push(`define ${name}.${String(key)}`), true),
            deleteProperty: (_, key) => (touched.push(`delete ${name}.${String(key)}`), true),
            setPrototypeOf: () => (touched.push(`${name} prototype=`), true),
        });
    const elements = new Map<string, Element>();
    const views = new Map<string, unknown>();
    for (const match of html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"([^>]*)>/g)) {
        const [tag, id] = [match[1] ?? '', match[2] ?? ''];
        if (id === 'link-data') {
            continue;
        }
        const element: Element = { hidden: /\shidden(\s|>|$)/.test(match[0]), textContent: '' };
        elements.set(id, element);
        views.set(
            id,
            watched(
                `#${id}`,
                element,
                (key) => key === 'hidden' || key === 'textContent' || key === 'href',
                (key) => SETTABLE(tag, key),
            ),
        );
    }
    const dataElement = watched(
        '#link-data',
        { textContent: data },
        (key) => key === 'textContent',
        () => false,
    );
    const url = new URL(href);
    const document = watched(
        'document',
        {
            getElementById: (id: string) =>
                id === 'link-data' ? dataElement : (views.get(id) ?? (touched.push(`missing #${id}`), null)),
        },
        (key) => key === 'getElementById',
        () => false,
    );
    const location = watched(
        'location',
        { hash: url.hash, origin: url.origin, pathname: url.pathname },
        (key) => key === 'hash' || key === 'origin' || key === 'pathname',
        () => false,
    );
    const context: Record<string, unknown> = {};
    // `location = …` and `document = …` as bare assignments navigate in a browser: accessors here,
    // so the write is recorded instead of replacing the stand-in.
    for (const [name, value] of [
        ['document', document],
        ['location', location],
    ] as const) {
        Object.defineProperty(context, name, {
            get: () => value,
            set: () => {
                touched.push(`${name}=`);
            },
            enumerable: true,
        });
    }
    for (const name of [
        'fetch',
        'XMLHttpRequest',
        'WebSocket',
        'EventSource',
        'Image',
        'navigator',
        'window',
        'self',
        'globalThis',
        'open',
        'history',
        'setTimeout',
        'setInterval',
        'requestAnimationFrame',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'console',
        'postMessage',
        'top',
        'parent',
        'frames',
        'opener',
        'name',
    ]) {
        const value = trap(name);
        Object.defineProperty(context, name, {
            get: () => value,
            set: () => {
                touched.push(`${name}=`);
            },
            enumerable: true,
        });
    }
    runInNewContext(scripts[0] ?? '', context);
    return { elements, touched };
}
