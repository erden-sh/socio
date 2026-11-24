import { expect, it } from 'vitest';

import { pluginUpdateDiff } from '@socio/shared/plugins/plugin-update';
import {
    anyHttpsUrl,
    bridgeOpenMode,
    OPEN_ANY_HTTPS_LABEL,
    parsePluginToHost,
    type PluginManifest,
} from '@socio/shared/plugins/plugins';

import { parseManifest } from '../src/server/plugins/catalog.js';
import { socialStrategyManifest } from '../src/server/plugins/planner/manifest.js';

/** A third-party embed manifest, as a catalog file would give it. */
const manifest = {
    ...socialStrategyManifest,
    id: 'events',
    display: 'embed' as const,
    service: {
        ...socialStrategyManifest.service!,
        image: `company-brain-plugin-x@sha256:${'ab'.repeat(32)}`,
    },
};

const open = (url: string, allow: string[] = [], any = false) =>
    parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'open', url }, allow, any);

it('takes bridge.openAnyHttps as a boolean, for an embed only', () => {
    expect(parseManifest({ ...manifest, bridge: { openAnyHttps: true } }, 'c').bridge).toEqual({
        openAnyHttps: true,
    });
    expect(
        parseManifest({ ...manifest, bridge: { open: ['https://ok.example/a'], openAnyHttps: false } }, 'c').bridge,
    ).toEqual({ open: ['https://ok.example/a'], openAnyHttps: false });
    // Absent stays absent: nothing new for a plugin that doesn't declare it.
    expect(parseManifest({ ...manifest, bridge: { open: ['https://ok.example/a'] } }, 'c').bridge).toEqual({
        open: ['https://ok.example/a'],
    });
    for (const bad of ['yes', 1, null, ['https://x.example/']]) {
        expect(() => parseManifest({ ...manifest, bridge: { openAnyHttps: bad } }, 'c'), String(bad)).toThrow(
            /bridge.openAnyHttps must be true or false/,
        );
    }
    expect(() => parseManifest({ ...manifest, display: 'tab', bridge: { openAnyHttps: true } }, 'c')).toThrow(
        /bridge.openAnyHttps is for an embed/,
    );
    // The old spelling guesses are refused, not ignored.
    expect(() => parseManifest({ ...manifest, bridge: { openAny: true } }, 'c')).toThrow(/field openAny/);
});

it('opens only plain https links under openAnyHttps', () => {
    for (const good of [
        'https://docs.example.com/guide',
        'https://files.example.com/a/b.pdf?sig=1#page=2',
        'https://example.com:8443/x',
        'https://xn--bcher-kva.example/',
    ]) {
        expect(anyHttpsUrl(new URL(good)), good).toBe(true);
    }
    for (const bad of [
        'http://docs.example.com/guide',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'blob:https://events.apps.example/1234',
        'file:///etc/passwd',
        'ftp://files.example.com/a',
        'https://localhost/a',
        'https://user:pass@docs.example.com/a',
        'https://docs.example.com@evil.example/a',
    ]) {
        expect(anyHttpsUrl(new URL(bad)), bad).toBe(false);
        expect(open(bad, [], true), bad).toBeUndefined();
    }
    // The URL parser's own normalizing: an international host is its xn-- form.
    expect(new URL('https://bücher.example/').host).toBe('xn--bcher-kva.example');
});

it('keeps an undeclared plugin to bridge.open, and asks first for a declared one', () => {
    const allow = ['https://x.com/intent/post'];
    // Undeclared: only its list, as before.
    expect(open('https://docs.example.com/guide', allow)).toBeUndefined();
    expect(open('https://docs.example.com/guide')).toBeUndefined();
    expect(open('https://x.com/intent/post?text=hi', allow)?.type).toBe('open');
    expect(bridgeOpenMode(new URL('https://docs.example.com/guide'), allow)).toBeUndefined();
    // Declared: any https link, its list still without a prompt.
    expect(open('https://docs.example.com/guide', allow, true)).toEqual({
        v: 1,
        source: 'socio-plugin',
        type: 'open',
        url: 'https://docs.example.com/guide',
    });
    expect(bridgeOpenMode(new URL('https://x.com/intent/post?text=hi'), allow, true)).toBe('direct');
    expect(bridgeOpenMode(new URL('https://docs.example.com/guide'), allow, true)).toBe('confirm');
    expect(bridgeOpenMode(new URL('http://x.com/intent/post'), allow, true)).toBeUndefined();
    // Extra fields are still refused.
    expect(
        parsePluginToHost(
            { v: 1, source: 'socio-plugin', type: 'open', url: 'https://docs.example.com/', confirmed: true },
            [],
            true,
        ),
    ).toBeUndefined();
});

it('flags an update that adds openAnyHttps for review', () => {
    const installed = { ...manifest } as PluginManifest;
    const next = { ...manifest, version: '2.0.0', bridge: { openAnyHttps: true } } as PluginManifest;
    const kinds = (from: PluginManifest, to: PluginManifest) =>
        pluginUpdateDiff(from, to, {}).additions.map((addition) => addition.key);
    expect(kinds(installed, next)).toEqual(['bridge.openAnyHttps']);
    const already = { ...manifest, bridge: { openAnyHttps: true } } as PluginManifest;
    expect(kinds(already, next)).toEqual([]);
    expect(kinds(installed, { ...manifest, version: '2.0.1' } as PluginManifest)).toEqual([]);
    expect(OPEN_ANY_HTTPS_LABEL).toMatch(/after you confirm each one/);
});
